import { createHash } from "node:crypto";
import type { AgentKind, NormalizedEvent } from "@agentlens/contracts";

export const REMOTE_ARCHIVE_SCHEMA_VERSION = 1;

export type ArchiveCompression = "zstd" | "none";
export type ArchiveObjectKind = "events" | "raw" | "manifests" | "catalog";

export interface ArchiveSessionIdentityInput {
  namespace: string;
  provider: string;
  providerSessionId: string;
  fallbackFingerprint: string;
}

export interface ArchiveEventInput {
  sessionUid: string;
  originId: string;
  sequence: number;
  observedAtMs?: number;
  event: NormalizedEvent;
}

export interface ArchiveEvent {
  schemaVersion: number;
  recordType: "event";
  sessionUid: string;
  originId: string;
  sequence: number;
  observedAtMs: number;
  event: NormalizedEvent;
}

export interface ArchiveChunkDescriptor {
  key: string;
  sha256: string;
  compression: ArchiveCompression;
  eventCount: number;
  firstSequence: number;
  lastSequence: number;
  firstEventTs: number | null;
  lastEventTs: number | null;
  sizeBytes: number;
}

export interface ArchiveManifest {
  schemaVersion: number;
  recordType: "manifest";
  sessionUid: string;
  provider: string;
  agent: AgentKind;
  providerSessionId: string;
  originIds: string[];
  revisionSha256: string;
  createdAtMs: number;
  chunks: ArchiveChunkDescriptor[];
  raw?: { key: string; sha256: string; encryption: "hybrid-rsa-oaep-sha256" };
}

export type ArchiveManifestInput = Omit<ArchiveManifest, "schemaVersion" | "recordType" | "revisionSha256">;

function sha256(parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function requireIdentifier(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function requireSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("sha256 must be a lowercase hexadecimal digest");
  return value;
}

function normalizedEventId(sessionUid: string, sequence: number, event: NormalizedEvent): string {
  return sha256([
    "agentlens.remote.event.v1",
    sessionUid,
    String(sequence),
    String(event.timestampMs ?? ""),
    event.eventKind,
    event.rawType,
    event.role,
    event.toolCallId,
    event.toolUseId,
    event.parentEventId,
    event.textBlocks.join("\n"),
    event.toolArgsText,
    event.toolResultText,
  ]);
}

function canonicalEvent(sessionUid: string, sequence: number, input: NormalizedEvent): NormalizedEvent {
  return {
    ...input,
    traceId: sessionUid,
    eventId: normalizedEventId(sessionUid, sequence, input),
    index: sequence,
    offset: sequence,
    raw: {},
  };
}

export function createSessionUid(input: ArchiveSessionIdentityInput): string {
  const namespace = requireIdentifier(input.namespace, "archive namespace");
  const provider = requireIdentifier(input.provider, "provider").toLowerCase();
  const stableSessionPart = input.providerSessionId.trim() || requireIdentifier(input.fallbackFingerprint, "fallback fingerprint");
  return sha256(["agentlens.remote.session.v1", namespace, provider, stableSessionPart]).slice(0, 32);
}

export function createArchiveEvent(input: ArchiveEventInput): ArchiveEvent {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
    throw new Error("event sequence must be a non-negative integer");
  }
  const sessionUid = requireIdentifier(input.sessionUid, "session UID");
  return {
    schemaVersion: REMOTE_ARCHIVE_SCHEMA_VERSION,
    recordType: "event",
    sessionUid,
    originId: requireIdentifier(input.originId, "origin ID"),
    sequence: input.sequence,
    observedAtMs: input.observedAtMs ?? input.event.timestampMs ?? Date.now(),
    event: canonicalEvent(sessionUid, input.sequence, input.event),
  };
}

export function encodeArchiveEvents(events: ArchiveEvent[]): Uint8Array {
  if (events.length === 0) throw new Error("archive chunks require at least one event");
  return Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function isArchiveEvent(value: unknown): value is ArchiveEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<ArchiveEvent>;
  return (
    record.schemaVersion === REMOTE_ARCHIVE_SCHEMA_VERSION &&
    record.recordType === "event" &&
    typeof record.sessionUid === "string" &&
    typeof record.originId === "string" &&
    typeof record.sequence === "number" &&
    typeof record.observedAtMs === "number" &&
    Boolean(record.event && typeof record.event === "object")
  );
}

export function decodeArchiveEvents(bytes: Uint8Array): ArchiveEvent[] {
  const text = Buffer.from(bytes).toString("utf8");
  const events: ArchiveEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("archive event chunk contains invalid JSON");
    }
    if (!isArchiveEvent(parsed)) throw new Error("archive event chunk contains an invalid record");
    events.push(parsed);
  }
  if (events.length === 0) throw new Error("archive event chunk contains no events");
  return events;
}

export function archiveObjectKey(kind: ArchiveObjectKind, digest: string, compression: ArchiveCompression = "none"): string {
  const sha = requireSha256(digest);
  const suffix = compression === "zstd" ? ".jsonl.zst" : ".jsonl";
  return `objects/${kind}/${sha.slice(0, 2)}/${sha}${suffix}`;
}

export function createArchiveManifest(input: ArchiveManifestInput): ArchiveManifest {
  const canonical = {
    ...input,
    originIds: [...new Set(input.originIds)].sort(),
    chunks: [...input.chunks],
  };
  const revisionSha256 = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return { schemaVersion: REMOTE_ARCHIVE_SCHEMA_VERSION, recordType: "manifest", revisionSha256, ...canonical };
}

export function archiveManifestKey(sessionUid: string, revisionSha256: string): string {
  return `manifests/${requireIdentifier(sessionUid, "session UID")}/${requireSha256(revisionSha256)}.json`;
}
