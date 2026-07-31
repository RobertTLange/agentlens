import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { FileSystemObjectStore, S3ObjectStore } from "./objectStore.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentlens-object-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileSystemObjectStore", () => {
  it("writes immutable objects and preserves the first successful upload", async () => {
    const root = await temporaryDirectory();
    const store = new FileSystemObjectStore(root);

    const first = await store.putIfAbsent("objects/events/aa/event.jsonl", Buffer.from("first"));
    const second = await store.putIfAbsent("objects/events/aa/event.jsonl", Buffer.from("first"));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readFile(path.join(root, "objects/events/aa/event.jsonl"), "utf8")).toBe("first");
  });

  it("rejects object keys that can escape the configured root", async () => {
    const store = new FileSystemObjectStore(await temporaryDirectory());

    await expect(store.putIfAbsent("../outside", Buffer.from("unsafe"))).rejects.toThrow("object key");
    await expect(store.putIfAbsent("/outside", Buffer.from("unsafe"))).rejects.toThrow("object key");
  });

  it("rejects a symlinked directory within the object root", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, path.join(root, "objects"));
    const store = new FileSystemObjectStore(root);

    await expect(store.putIfAbsent("objects/event.json", Buffer.from("unsafe"))).rejects.toThrow("symlink");
    await expect(store.get("objects/event.json")).rejects.toThrow("symlink");
  });

  it("lists objects under a prefix in lexical order", async () => {
    const store = new FileSystemObjectStore(await temporaryDirectory());
    await store.putIfAbsent("catalog/2026/b.json", Buffer.from("b"));
    await store.putIfAbsent("catalog/2026/a.json", Buffer.from("a"));
    await store.putIfAbsent("objects/events/aa/a.jsonl", Buffer.from("ignored"));

    const objects = await store.list("catalog/");

    expect(objects.map((object) => object.key)).toEqual(["catalog/2026/a.json", "catalog/2026/b.json"]);
  });

  it("rejects an existing object with a different content digest", async () => {
    const store = new FileSystemObjectStore(await temporaryDirectory());
    await store.putIfAbsent("objects/event.json", Buffer.from("first"));

    await expect(store.putIfAbsent("objects/event.json", Buffer.from("second"))).rejects.toThrow("digest");
  });
});

describe("S3ObjectStore", () => {
  it("uses configured region, prefixes keys, and verifies an immutable-write conflict", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof PutObjectCommand) {
          throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
        }
        if (command instanceof GetObjectCommand) {
          return {
            Body: { transformToByteArray: async () => Buffer.from("first") },
            ContentLength: 5,
            ETag: '"etag"',
          };
        }
        throw new Error("unexpected command");
      }),
    } as unknown as S3Client;
    const store = new S3ObjectStore({ bucket: "archive", prefix: "agentlens", region: "eu-central-1", client });

    const result = await store.putIfAbsent("events/a.json", Buffer.from("first"));

    expect(result).toMatchObject({ created: false, object: { key: "events/a.json" } });
    const put = sent.find((command) => command instanceof PutObjectCommand) as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: "archive", Key: "agentlens/events/a.json", IfNoneMatch: "*" });
  });

  it("rejects insecure endpoints unless explicitly enabled", () => {
    expect(() => new S3ObjectStore({ bucket: "archive", endpoint: "http://localhost:3900" })).toThrow("HTTPS");
    expect(
      () => new S3ObjectStore({ bucket: "archive", endpoint: "http://localhost:3900", allowInsecureHttpEndpoint: true }),
    ).not.toThrow();
  });

  it("retries a conditional conflict and paginates lists", async () => {
    let puts = 0;
    const client = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof PutObjectCommand) {
          puts += 1;
          if (puts === 1) throw { name: "ConditionalRequestConflict", $metadata: { httpStatusCode: 409 } };
          return { ETag: '"written"' };
        }
        if (command instanceof ListObjectsV2Command) {
          if (!command.input.ContinuationToken) {
            return { Contents: [{ Key: "prefix/catalog/a.json", Size: 1 }], IsTruncated: true, NextContinuationToken: "next" };
          }
          return { Contents: [{ Key: "prefix/catalog/b.json", Size: 1 }], IsTruncated: false };
        }
        throw new Error("unexpected command");
      }),
    } as unknown as S3Client;
    const store = new S3ObjectStore({ bucket: "archive", prefix: "prefix", region: "eu-central-1", client });

    await expect(store.putIfAbsent("catalog/a.json", Buffer.from("a"))).resolves.toMatchObject({ created: true });
    await expect(store.list("catalog")).resolves.toEqual([
      { key: "catalog/a.json", sizeBytes: 1 },
      { key: "catalog/b.json", sizeBytes: 1 },
    ]);
  });
});
