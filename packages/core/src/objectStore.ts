import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

export interface ObjectMetadata {
  key: string;
  sizeBytes: number;
  etag?: string;
  /** Lowercase hexadecimal SHA-256 of the stored bytes. */
  sha256?: string;
}

export interface StoredObject extends ObjectMetadata {
  bytes: Uint8Array;
}

export interface PutObjectOptions {
  contentType?: string;
  sha256?: string;
}

export interface PutObjectResult {
  created: boolean;
  object: ObjectMetadata;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  list(prefix: string): Promise<ObjectMetadata[]>;
  putIfAbsent(key: string, bytes: Uint8Array, options?: PutObjectOptions): Promise<PutObjectResult>;
}

export interface S3ObjectStoreOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Local development only. Credentials and traces otherwise require HTTPS. */
  allowInsecureHttpEndpoint?: boolean;
  client?: S3Client;
}

export const MAX_ARCHIVE_OBJECT_BYTES = 32 * 1024 * 1024;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function base64Sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function normalizeObjectKey(value: string): string {
  if (value.startsWith("/") || value.startsWith("\\")) throw new Error("object key must be a non-empty relative path");
  const key = value.replace(/\\/g, "/");
  if (!key || key.split("/").some((part) => !part || part === "." || part === "..") || key.includes("\0")) {
    throw new Error("object key must be a non-empty relative path");
  }
  return key;
}

function normalizePrefix(value: string): string {
  if (!value.trim()) return "";
  const withoutTrailingSlash = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${normalizeObjectKey(withoutTrailingSlash)}/`;
}

function toObjectMetadata(key: string, sizeBytes: number, etag?: string, digest?: string): ObjectMetadata {
  return {
    key,
    sizeBytes,
    ...(etag ? { etag } : {}),
    ...(digest ? { sha256: digest } : {}),
  };
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NoSuchKey" || candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "PreconditionFailed" || candidate.$metadata?.httpStatusCode === 412;
}

function isConditionalConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "ConditionalRequestConflict" || candidate.$metadata?.httpStatusCode === 409;
}

function assertMatchingDigest(existing: StoredObject, expectedDigest: string): ObjectMetadata {
  if (existing.sha256 !== expectedDigest) throw new Error(`immutable object digest mismatch for ${existing.key}`);
  const { bytes: _bytes, ...metadata } = existing;
  return metadata;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function collectFiles(root: string, currentDirectory: string, files: string[]): Promise<void> {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const filePath = path.join(currentDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlinked path is not allowed in object store: ${filePath}`);
    if (entry.isDirectory()) {
      await collectFiles(root, filePath, files);
      continue;
    }
    if (entry.isFile()) files.push(path.relative(root, filePath).split(path.sep).join("/"));
  }
}

export class FileSystemObjectStore implements ObjectStore {
  private readonly configuredRoot: string;

  constructor(root: string) {
    this.configuredRoot = path.resolve(root);
  }

  private async rootPath(): Promise<string> {
    await mkdir(this.configuredRoot, { recursive: true });
    const root = await realpath(this.configuredRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw new Error("object store root must be a directory");
    return root;
  }

  private async filePath(key: string, createParents: boolean): Promise<string | null> {
    const relative = normalizeObjectKey(key);
    const root = await this.rootPath();
    let current = root;
    for (const part of relative.split("/").slice(0, -1)) {
      current = path.join(current, part);
      try {
        const directoryStat = await lstat(current);
        if (directoryStat.isSymbolicLink()) throw new Error(`symlinked path is not allowed in object store: ${current}`);
        if (!directoryStat.isDirectory()) throw new Error(`object store path is not a directory: ${current}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!createParents) return null;
        await mkdir(current);
        const directoryStat = await lstat(current);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
          throw new Error(`unsafe object store path: ${current}`);
        }
      }
    }
    return path.join(current, relative.split("/").at(-1)!);
  }

  async get(key: string): Promise<StoredObject | null> {
    const filePath = await this.filePath(key, false);
    if (!filePath) return null;
    try {
      const fileStat = await lstat(filePath);
      if (fileStat.isSymbolicLink()) throw new Error(`symlinked path is not allowed in object store: ${filePath}`);
      if (!fileStat.isFile()) throw new Error(`object store path is not a file: ${filePath}`);
      const bytes = await readFile(filePath);
      return { ...toObjectMetadata(normalizeObjectKey(key), fileStat.size, undefined, sha256(bytes)), bytes };
    } catch (error) {
      if (isMissingObject(error) || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<ObjectMetadata[]> {
    const normalizedPrefix = prefix ? normalizePrefix(prefix) : "";
    const root = await this.rootPath();
    const prefixDirectory = normalizedPrefix ? await this.filePath(`${normalizedPrefix}placeholder`, false) : root;
    const startDirectory = prefixDirectory ? path.dirname(prefixDirectory) : null;
    if (!startDirectory) return [];
    const files: string[] = [];
    try {
      await collectFiles(root, startDirectory, files);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const matching = files.filter((key) => key.startsWith(normalizedPrefix)).sort();
    return Promise.all(
      matching.map(async (key) => {
        const filePath = await this.filePath(key, false);
        if (!filePath) throw new Error(`object disappeared while listing: ${key}`);
        const fileStat = await lstat(filePath);
        if (fileStat.isSymbolicLink()) throw new Error(`symlinked path is not allowed in object store: ${filePath}`);
        return toObjectMetadata(key, fileStat.size);
      }),
    );
  }

  async putIfAbsent(key: string, bytes: Uint8Array, options: PutObjectOptions = {}): Promise<PutObjectResult> {
    const normalizedKey = normalizeObjectKey(key);
    const destination = await this.filePath(normalizedKey, true);
    if (!destination) throw new Error("could not create object store destination");
    const expectedDigest = options.sha256 ?? sha256(bytes);
    if (expectedDigest !== sha256(bytes)) throw new Error("object bytes do not match the supplied SHA-256 digest");

    const temporaryDirectory = await mkdtemp(path.join(path.dirname(destination), ".agentlens-object-store-"));
    const temporaryPath = path.join(temporaryDirectory, "object");
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx" });
      try {
        await link(temporaryPath, destination);
        return { created: true, object: toObjectMetadata(normalizedKey, bytes.byteLength, undefined, expectedDigest) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.get(normalizedKey);
        if (!existing) throw new Error("object disappeared while resolving an immutable upload");
        return { created: false, object: assertMatchingDigest(existing, expectedDigest) };
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export class S3ObjectStore implements ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket.trim();
    if (!this.bucket) throw new Error("S3 bucket is required");
    this.prefix = normalizePrefix(options.prefix ?? "");
    this.client = options.client ?? new S3Client(this.clientConfig(options));
  }

  private clientConfig(options: S3ObjectStoreOptions): S3ClientConfig {
    const endpoint = options.endpoint?.trim();
    if (endpoint) {
      const url = new URL(endpoint);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && options.allowInsecureHttpEndpoint)) {
        throw new Error("S3 endpoint must use HTTPS; allowInsecureHttpEndpoint is only for local development");
      }
    }
    return {
      ...(options.region?.trim() ? { region: options.region.trim() } : {}),
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? Boolean(endpoint),
      customUserAgent: "agentlens-remote-archive/0.4.0",
    };
  }

  private fullKey(key: string): string {
    return `${this.prefix}${normalizeObjectKey(key)}`;
  }

  private relativeKey(key: string): string | null {
    if (!key.startsWith(this.prefix)) return null;
    const relative = key.slice(this.prefix.length);
    return relative ? relative : null;
  }

  async get(key: string): Promise<StoredObject | null> {
    const normalizedKey = normalizeObjectKey(key);
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(normalizedKey) }));
      if (!response.Body) throw new Error("S3 returned an empty object body");
      if (response.ContentLength !== undefined && response.ContentLength > MAX_ARCHIVE_OBJECT_BYTES) {
        throw new Error(`S3 object exceeds the ${MAX_ARCHIVE_OBJECT_BYTES} byte archive limit`);
      }
      const bytes = await response.Body.transformToByteArray();
      if (bytes.byteLength > MAX_ARCHIVE_OBJECT_BYTES) {
        throw new Error(`S3 object exceeds the ${MAX_ARCHIVE_OBJECT_BYTES} byte archive limit`);
      }
      return {
        ...toObjectMetadata(normalizedKey, bytes.byteLength, response.ETag, sha256(bytes)),
        bytes,
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async list(prefix: string): Promise<ObjectMetadata[]> {
    const normalizedPrefix = prefix ? normalizePrefix(prefix) : "";
    const objects: ObjectMetadata[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.prefix}${normalizedPrefix}`,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }),
      );
      for (const object of response.Contents ?? []) {
        const key = object.Key ? this.relativeKey(object.Key) : null;
        if (!key) continue;
        objects.push(toObjectMetadata(key, object.Size ?? 0, object.ETag));
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects.sort((left, right) => left.key.localeCompare(right.key));
  }

  async putIfAbsent(key: string, bytes: Uint8Array, options: PutObjectOptions = {}): Promise<PutObjectResult> {
    const normalizedKey = normalizeObjectKey(key);
    const digest = options.sha256 ?? sha256(bytes);
    if (digest !== sha256(bytes)) throw new Error("object bytes do not match the supplied SHA-256 digest");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.fullKey(normalizedKey),
            Body: bytes,
            ChecksumAlgorithm: "SHA256",
            ChecksumSHA256: base64Sha256(bytes),
            IfNoneMatch: "*",
            ...(options.contentType ? { ContentType: options.contentType } : {}),
          }),
        );
        return { created: true, object: toObjectMetadata(normalizedKey, bytes.byteLength, response.ETag, digest) };
      } catch (error) {
        if (isPreconditionFailure(error)) {
          const existing = await this.get(normalizedKey);
          if (!existing) throw new Error("object disappeared while resolving an immutable upload");
          return { created: false, object: assertMatchingDigest(existing, digest) };
        }
        if (!isConditionalConflict(error) || attempt === 2) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
    throw new Error("unreachable conditional upload state");
  }
}
