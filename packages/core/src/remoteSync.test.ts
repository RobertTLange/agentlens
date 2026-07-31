import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import { canonicalizeRemoteEvents, validateRemoteArchiveConfig } from "./remoteSync.js";
import { createRemoteObjectStore, RemoteSyncService } from "./remoteSync.js";
import { listRemoteManifests, loadRemoteEvents } from "./remoteReader.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("remote sync configuration", () => {
  it("requires an explicit encryption identity before enabling sync", () => {
    const config = mergeConfig({ remoteArchive: { enabled: true } });
    expect(() => validateRemoteArchiveConfig(config)).toThrow("namespace");
  });

  it("accepts a complete local archive configuration", () => {
    const config = mergeConfig({
      remoteArchive: { enabled: true, namespace: "personal", originId: "laptop", rawPublicKeyPath: "~/archive.pub" },
    });
    expect(() => validateRemoteArchiveConfig(config)).not.toThrow();
  });

  it("enforces redaction before canonical events reach remote storage", () => {
    const config = mergeConfig({ remoteArchive: { originId: "laptop" } });
    const event = { eventId: "e", traceId: "t", index: 0, offset: 0, timestampMs: 1, sessionId: "s", eventKind: "assistant" as const, rawType: "message", role: "assistant", preview: "sk-secret", textBlocks: ["sk-secret"], toolUseId: "", parentToolUseId: "", toolName: "", toolType: "", toolCallId: "", functionName: "", toolArgsText: "sk-secret", toolResultText: "sk-secret", parentEventId: "", tocLabel: "sk-secret", hasError: false, searchText: "sk-secret", raw: { token: "sk-secret" } };
    const encoded = JSON.stringify(canonicalizeRemoteEvents(config, "session", [event], 1));
    expect(encoded).not.toContain("sk-secret");
    expect(encoded).toContain("[REDACTED]");
  });

  it("syncs a discovered trace to a filesystem archive and reads canonical events back", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-sync-"));
    directories.push(root);
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPath = path.join(root, "archive-public.pem");
    await writeFile(publicKeyPath, keys.publicKey.export({ type: "spki", format: "pem" }));
    await writeFile(path.join(root, "trace.jsonl"), '{"type":"message","timestamp":1,"text":"sk-secret"}\n');
    const archivePath = path.join(root, "archive");
    const config = mergeConfig({
      sessionLogDirectories: [],
      sources: { test: { name: "test", enabled: true, roots: [root], includeGlobs: ["trace.jsonl"], excludeGlobs: [], maxDepth: 1, agentHint: "unknown" } },
      remoteArchive: { enabled: true, namespace: "personal", originId: "test-machine", rawPublicKeyPath: publicKeyPath, statePath: path.join(root, "state.json"), store: { kind: "filesystem", directory: archivePath } },
    });
    const result = await new RemoteSyncService(config).syncOnce();
    const store = createRemoteObjectStore(config);
    const manifests = await listRemoteManifests(store);

    expect(result).toMatchObject({ scanned: 1, uploaded: 1, failures: [] });
    expect(manifests).toHaveLength(1);
    await expect(loadRemoteEvents(store, manifests[0]!)).resolves.toHaveLength(1);
    const rawObjects = await store.list("objects/raw");
    expect(rawObjects).toHaveLength(1);
    expect(Buffer.from((await store.get(rawObjects[0]!.key))!.bytes).toString("utf8")).not.toContain("sk-secret");
  });
});
