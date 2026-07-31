import { createHash } from "node:crypto";
import type { ArchiveManifest, ArchiveEvent } from "./remoteArchive.js";
import { decodeArchiveEvents } from "./remoteArchive.js";
import { decodeZstd } from "./archiveCodec.js";
import type { ObjectStore } from "./objectStore.js";

function isManifest(value: unknown): value is ArchiveManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<ArchiveManifest>;
  return manifest.schemaVersion === 1 && manifest.recordType === "manifest" && typeof manifest.sessionUid === "string" && Array.isArray(manifest.chunks);
}

async function readManifest(store: ObjectStore, key: string): Promise<ArchiveManifest | null> {
  const object = await store.get(key);
  if (!object) return null;
  try {
    const parsed = JSON.parse(Buffer.from(object.bytes).toString("utf8")) as unknown;
    return isManifest(parsed) ? parsed : null;
  } catch { return null; }
}

export async function listRemoteManifests(store: ObjectStore): Promise<ArchiveManifest[]> {
  const objects = await store.list("manifests");
  const manifests = await Promise.all(objects.filter((object) => object.key.endsWith(".json")).map((object) => readManifest(store, object.key)));
  return manifests.filter((manifest): manifest is ArchiveManifest => manifest !== null).sort((left, right) => right.createdAtMs - left.createdAtMs);
}

export async function loadRemoteEvents(store: ObjectStore, manifest: ArchiveManifest): Promise<ArchiveEvent[]> {
  const events: ArchiveEvent[] = [];
  for (const chunk of manifest.chunks) {
    const object = await store.get(chunk.key);
    if (!object) throw new Error(`remote archive chunk is missing: ${chunk.key}`);
    const digest = createHash("sha256").update(object.bytes).digest("hex");
    if (digest !== chunk.sha256) throw new Error(`remote archive chunk failed its digest check: ${chunk.key}`);
    const bytes = chunk.compression === "zstd" ? await decodeZstd(object.bytes) : object.bytes;
    events.push(...decodeArchiveEvents(bytes));
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}
