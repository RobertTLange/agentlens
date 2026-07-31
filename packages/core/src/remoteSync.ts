import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "@agentlens/contracts";
import type { NormalizedEvent } from "@agentlens/contracts";
import { expandHome } from "./utils.js";
import { discoverTraceFiles, type DiscoveredTraceFile } from "./discovery.js";
import { ParserRegistry } from "./parsers/index.js";
import { redactEvents } from "./redaction.js";
import { encodeZstd } from "./archiveCodec.js";
import { encryptRawArchive } from "./archiveEncryption.js";
import { FileSystemObjectStore, S3ObjectStore, type ObjectStore } from "./objectStore.js";
import {
  archiveManifestKey,
  archiveObjectKey,
  createArchiveEvent,
  createArchiveManifest,
  createSessionUid,
  encodeArchiveEvents,
} from "./remoteArchive.js";

interface SyncState { files: Record<string, { sizeBytes: number; mtimeMs: number }> }
export interface RemoteSyncResult { scanned: number; uploaded: number; skipped: number; failures: Array<{ path: string; error: string }> }

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function createRemoteObjectStore(config: AppConfig): ObjectStore {
  const store = config.remoteArchive.store;
  if (store.kind === "filesystem") return new FileSystemObjectStore(expandHome(store.directory));
  return new S3ObjectStore({
    bucket: store.bucket,
    prefix: store.prefix,
    ...(store.region ? { region: store.region } : {}),
    ...(store.endpoint ? { endpoint: store.endpoint } : {}),
    forcePathStyle: store.forcePathStyle,
    allowInsecureHttpEndpoint: store.allowInsecureHttpEndpoint,
  });
}

export function validateRemoteArchiveConfig(config: AppConfig): void {
  const settings = config.remoteArchive;
  if (settings.enabled !== true) return;
  if (!settings.namespace || !settings.originId || !settings.rawPublicKeyPath) {
    throw new Error("remote archive requires namespace, originId, and rawPublicKeyPath");
  }
  if (settings.store.kind === "filesystem") {
    if (!settings.store.directory) throw new Error("remote archive filesystem store requires a directory");
    return;
  }
  if (!settings.store.bucket) throw new Error("remote archive S3 store requires a bucket");
  if (settings.store.endpoint) {
    const endpoint = new URL(settings.store.endpoint);
    const localHost = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && settings.store.allowInsecureHttpEndpoint && localHost)) {
      throw new Error("remote archive S3 endpoint must use HTTPS");
    }
  }
}

function rawContext(sessionUid: string, originId: string): string { return `${sessionUid}\u0000${originId}\u0000raw`; }

export function canonicalizeRemoteEvents(config: AppConfig, sessionUid: string, events: NormalizedEvent[], observedAtMs: number) {
  const redaction = { ...config.redaction, mode: "strict" as const, alwaysOn: true };
  return redactEvents(events, redaction).map((event, sequence) =>
    createArchiveEvent({ sessionUid, originId: config.remoteArchive.originId, sequence, observedAtMs: event.timestampMs ?? observedAtMs, event }),
  );
}

async function loadState(filePath: string): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<SyncState>;
    return { files: parsed.files && typeof parsed.files === "object" ? parsed.files : {} };
  } catch { return { files: {} }; }
}

async function saveState(filePath: string, state: SyncState): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, filePath);
}

function fallbackFingerprint(raw: Uint8Array): string { return sha256(raw.subarray(0, 16 * 1024)); }

export class RemoteSyncService {
  private readonly parser = new ParserRegistry();
  private readonly statePath: string;

  constructor(private readonly config: AppConfig, private readonly store: ObjectStore = createRemoteObjectStore(config)) {
    this.statePath = expandHome(config.remoteArchive.statePath);
  }

  async syncOnce(): Promise<RemoteSyncResult> {
    const settings = this.config.remoteArchive;
    if (settings.enabled !== true) return { scanned: 0, uploaded: 0, skipped: 0, failures: [] };
    validateRemoteArchiveConfig(this.config);
    const publicKey = await readFile(expandHome(settings.rawPublicKeyPath), "utf8");
    const state = await loadState(this.statePath);
    const result: RemoteSyncResult = { scanned: 0, uploaded: 0, skipped: 0, failures: [] };
    for (const file of await discoverTraceFiles(this.config)) {
      result.scanned += 1;
      const prior = state.files[file.id];
      if (prior?.sizeBytes === file.sizeBytes && prior.mtimeMs === file.mtimeMs) { result.skipped += 1; continue; }
      try {
        await this.syncFile(file, publicKey);
        state.files[file.id] = { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs };
        result.uploaded += 1;
      } catch (error) {
        result.failures.push({ path: file.path, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await saveState(this.statePath, state);
    return result;
  }

  private async syncFile(file: DiscoveredTraceFile, publicKey: string): Promise<void> {
    const raw = await readFile(file.path);
    const parsed = this.parser.parseText(file, raw.toString("utf8"));
    const provider = parsed.agent;
    const sessionUid = createSessionUid({ namespace: this.config.remoteArchive.namespace, provider, providerSessionId: parsed.sessionId, fallbackFingerprint: fallbackFingerprint(raw) });
    const events = canonicalizeRemoteEvents(this.config, sessionUid, parsed.events, file.mtimeMs);
    if (events.length === 0) return;
    const encoded = encodeArchiveEvents(events);
    const compressed = await encodeZstd(encoded);
    const eventDigest = sha256(compressed);
    const eventKey = archiveObjectKey("events", eventDigest, "zstd");
    await this.store.putIfAbsent(eventKey, compressed, { contentType: "application/zstd", sha256: eventDigest });

    const encryptedRaw = Buffer.from(JSON.stringify(encryptRawArchive(raw, publicKey, rawContext(sessionUid, this.config.remoteArchive.originId))), "utf8");
    const rawDigest = sha256(encryptedRaw);
    const rawKey = archiveObjectKey("raw", rawDigest);
    await this.store.putIfAbsent(rawKey, encryptedRaw, { contentType: "application/json", sha256: rawDigest });
    const manifest = createArchiveManifest({
      sessionUid, provider, agent: parsed.agent, providerSessionId: parsed.sessionId, originIds: [this.config.remoteArchive.originId], createdAtMs: file.mtimeMs,
      chunks: [{ key: eventKey, sha256: eventDigest, compression: "zstd", eventCount: events.length, firstSequence: 0, lastSequence: events.length - 1, firstEventTs: events[0]?.event.timestampMs ?? null, lastEventTs: events.at(-1)?.event.timestampMs ?? null, sizeBytes: compressed.byteLength }],
      raw: { key: rawKey, sha256: rawDigest, encryption: "hybrid-rsa-oaep-sha256" },
    });
    const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
    await this.store.putIfAbsent(archiveManifestKey(sessionUid, manifest.revisionSha256), manifestBytes, { contentType: "application/json", sha256: sha256(manifestBytes) });
  }
}
