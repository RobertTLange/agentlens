import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileSystemObjectStore } from "./objectStore.js";
import { CachedObjectStore } from "./objectStoreCache.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it("serves a previously fetched immutable object from the local cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cache-")); directories.push(root);
  const source = new FileSystemObjectStore(path.join(root, "source"));
  await source.putIfAbsent("objects/event", Buffer.from("first"));
  const cache = new CachedObjectStore(source, path.join(root, "cache"));
  expect(Buffer.from((await cache.get("objects/event"))!.bytes).toString()).toBe("first");
  await rm(path.join(root, "source"), { recursive: true, force: true });
  expect(Buffer.from((await cache.get("objects/event"))!.bytes).toString()).toBe("first");
});
