import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeZstd } from "./archiveCodec.js";
import { FileSystemObjectStore } from "./objectStore.js";
import { createArchiveEvent, createArchiveManifest, encodeArchiveEvents, archiveManifestKey, archiveObjectKey } from "./remoteArchive.js";
import { listRemoteManifests, loadRemoteEvents } from "./remoteReader.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it("lists a remote manifest and lazily hydrates its canonical events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-reader-")); directories.push(root);
  const store = new FileSystemObjectStore(root);
  const event = createArchiveEvent({ sessionUid: "session", originId: "laptop", sequence: 0, observedAtMs: 1, event: { eventId: "e", traceId: "t", index: 0, offset: 0, timestampMs: 1, sessionId: "s", eventKind: "user", rawType: "message", role: "user", preview: "hello", textBlocks: ["hello"], toolUseId: "", parentToolUseId: "", toolName: "", toolType: "", toolCallId: "", functionName: "", toolArgsText: "", toolResultText: "", parentEventId: "", tocLabel: "hello", hasError: false, searchText: "hello", raw: {} } });
  const bytes = await encodeZstd(encodeArchiveEvents([event])); const digest = createHash("sha256").update(bytes).digest("hex");
  const chunkKey = archiveObjectKey("events", digest, "zstd"); await store.putIfAbsent(chunkKey, bytes);
  const manifest = createArchiveManifest({ sessionUid: "session", provider: "codex", agent: "codex", providerSessionId: "s", originIds: ["laptop"], createdAtMs: 1, chunks: [{ key: chunkKey, sha256: digest, compression: "zstd", eventCount: 1, firstSequence: 0, lastSequence: 0, firstEventTs: 1, lastEventTs: 1, sizeBytes: bytes.byteLength }] });
  await store.putIfAbsent(archiveManifestKey("session", manifest.revisionSha256), Buffer.from(JSON.stringify(manifest)));
  const manifests = await listRemoteManifests(store);
  await expect(loadRemoteEvents(store, manifests[0]!)).resolves.toEqual([event]);
});
