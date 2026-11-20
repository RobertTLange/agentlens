import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectMetadata, ObjectStore, PutObjectOptions, PutObjectResult, StoredObject } from "./objectStore.js";

function cacheName(key: string): string { return createHash("sha256").update(key).digest("hex"); }

export class CachedObjectStore implements ObjectStore {
  constructor(private readonly source: ObjectStore, private readonly cacheDirectory: string) {}

  async get(key: string): Promise<StoredObject | null> {
    const cachePath = path.join(this.cacheDirectory, cacheName(key));
    try {
      const bytes = await readFile(cachePath);
      return { key, sizeBytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
    } catch { /* cache miss */ }
    const object = await this.source.get(key);
    if (!object) return null;
    await mkdir(this.cacheDirectory, { recursive: true });
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await writeFile(temporary, object.bytes, { mode: 0o600 });
    await rename(temporary, cachePath);
    return object;
  }

  list(prefix: string): Promise<ObjectMetadata[]> { return this.source.list(prefix); }
  putIfAbsent(key: string, bytes: Uint8Array, options?: PutObjectOptions): Promise<PutObjectResult> {
    return this.source.putIfAbsent(key, bytes, options);
  }
}
