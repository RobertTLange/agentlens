import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentKind,
  AppConfig,
  RagDocumentKind,
  RagRefreshStatus,
  RagSummaryRecord,
  RagTraceSummaryContent,
} from "@agentlens/contracts";
import { expandHome } from "./utils.js";

export interface RagSessionRow {
  trace_id: string;
  session_id: string;
  agent: AgentKind;
  parser: string;
  source_profile: string;
  path: string;
  first_event_ts: number | null;
  last_event_ts: number | null;
  mtime_ms: number;
  size_bytes: number;
  event_count: number;
  fingerprint: string;
  status: RagRefreshStatus;
  skip_reason: string | null;
  error: string | null;
  summary_json: string | null;
  summary_text: string | null;
  summary_model: string | null;
  summary_generated_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export function dbPathFromConfig(config: AppConfig): string {
  return path.resolve(expandHome(config.rag.dbPath));
}

export function pidIsRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readDaemonPid(pidPath: string): number | null {
  const resolved = path.resolve(expandHome(pidPath));
  if (!existsSync(resolved)) return null;
  const pid = Number.parseInt(readFileSync(resolved, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function deserializeSummary(value: string | null): RagTraceSummaryContent | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as RagTraceSummaryContent;
  } catch {
    return null;
  }
}

export function toSummaryRecord(row: RagSessionRow): RagSummaryRecord {
  return {
    traceId: row.trace_id,
    sessionId: row.session_id,
    agent: row.agent,
    parser: row.parser,
    sourceProfile: row.source_profile,
    path: row.path,
    firstEventTs: row.first_event_ts,
    lastEventTs: row.last_event_ts,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    eventCount: row.event_count,
    fingerprint: row.fingerprint,
    status: row.status,
    skipReason: row.skip_reason ?? "",
    error: row.error ?? "",
    summary: deserializeSummary(row.summary_json),
    summaryText: row.summary_text ?? "",
    summaryModel: row.summary_model ?? "",
    summaryGeneratedAtMs: row.summary_generated_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function normalizeFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .match(/[\p{L}\p{N}_./:@-]+/gu)
    ?.map((term) => term.replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, 16) ?? [];
  return terms.map((term) => `"${term}"`).join(" OR ");
}

export function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return total;
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function bufferToVector(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}

export function snippet(content: string, query: string, maxLength = 220): string {
  const tokens = query.toLowerCase().match(/[\p{L}\p{N}_./:@-]+/gu) ?? [];
  const lower = content.toLowerCase();
  const hit = tokens.map((token) => lower.indexOf(token)).find((index) => index !== -1) ?? 0;
  const start = Math.max(0, hit - 80);
  return content.slice(start, start + maxLength).replace(/\s+/g, " ").trim();
}

export function addKind(kinds: RagDocumentKind[], kind: RagDocumentKind): RagDocumentKind[] {
  return kinds.includes(kind) ? kinds : [...kinds, kind];
}
