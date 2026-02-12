import type { EventKind, NormalizedEvent } from "@agentlens/contracts";
import { asArray, asRecord, asString, normalizePreview, parseEpochMs } from "../utils.js";

export interface EventSeed {
  eventId?: string;
  traceId: string;
  index: number;
  offset: number;
  timestampMs?: number | null;
  sessionId?: string;
  eventKind: EventKind;
  rawType: string;
  role?: string;
  preview?: string;
  textBlocks?: string[];
  toolUseId?: string;
  parentToolUseId?: string;
  toolName?: string;
  toolCallId?: string;
  functionName?: string;
  toolArgsText?: string;
  toolResultText?: string;
  parentEventId?: string;
  tocLabel?: string;
  hasError?: boolean;
  searchChunks?: string[];
  raw?: Record<string, unknown>;
}

export function makeEvent(seed: EventSeed): NormalizedEvent {
  const textBlocks = seed.textBlocks ?? [];
  const preview = seed.preview ?? normalizePreview((textBlocks[0] ?? seed.rawType) || "event");
  const searchChunks = seed.searchChunks ?? [preview, seed.rawType, ...textBlocks];

  return {
    eventId: seed.eventId ?? `${seed.traceId}:${seed.index}:${seed.offset}`,
    traceId: seed.traceId,
    index: seed.index,
    offset: seed.offset,
    timestampMs: seed.timestampMs ?? null,
    sessionId: seed.sessionId ?? "",
    eventKind: seed.eventKind,
    rawType: seed.rawType,
    role: seed.role ?? "assistant",
    preview,
    textBlocks,
    toolUseId: seed.toolUseId ?? "",
    parentToolUseId: seed.parentToolUseId ?? "",
    toolName: seed.toolName ?? "",
    toolCallId: seed.toolCallId ?? seed.toolUseId ?? "",
    functionName: seed.functionName ?? "",
    toolArgsText: seed.toolArgsText ?? "",
    toolResultText: seed.toolResultText ?? "",
    parentEventId: seed.parentEventId ?? "",
    tocLabel: seed.tocLabel ?? preview,
    hasError: Boolean(seed.hasError),
    searchText: searchChunks.join("\n").toLowerCase(),
    raw: seed.raw ?? {},
  };
}

export function parseJsonLines(text: string): Array<{ offset: number; value: Record<string, unknown> }> {
  const out: Array<{ offset: number; value: Record<string, unknown> }> = [];
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      offset += line.length + 1;
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        out.push({ offset, value: parsed as Record<string, unknown> });
      }
    } catch {
      // skip invalid line
    }
    offset += line.length + 1;
  }
  return out;
}

export function eventKindFromRole(role: string): EventKind {
  const lowered = role.trim().toLowerCase();
  if (lowered === "system" || lowered === "developer") {
    return "system";
  }
  if (lowered === "user") {
    return "user";
  }
  return "assistant";
}

export function extractTextBlocks(value: unknown): string[] {
  if (typeof value === "string") {
    return value ? [value] : [];
  }
  const out: string[] = [];
  for (const item of asArray(value)) {
    const record = asRecord(item);
    const itemType = asString(record.type);
    if (itemType === "text" || itemType === "input_text" || itemType === "output_text") {
      const text = asString(record.text);
      if (text) out.push(text);
      continue;
    }
    if (itemType === "tool_result") {
      const nested = extractTextBlocks(record.content);
      if (nested.length > 0) {
        out.push(...nested);
      } else {
        const content = asString(record.content);
        if (content && content !== "[]") out.push(content);
      }
      continue;
    }

    for (const field of ["text", "content", "result", "output", "input"]) {
      const fieldValue = record[field];
      if (fieldValue === undefined || fieldValue === null) continue;
      if (typeof fieldValue === "string" && fieldValue.trim()) {
        out.push(fieldValue);
        break;
      }
      const nested = extractTextBlocks(fieldValue);
      if (nested.length > 0) {
        out.push(...nested);
        break;
      }
      const itemText = asString(fieldValue);
      if (itemText && itemText !== "{}" && itemText !== "[]") {
        out.push(itemText);
        break;
      }
    }
  }
  return out;
}

export function guessTimestamp(payload: Record<string, unknown>): number | null {
  const fromRecord = (record: Record<string, unknown>): number | null =>
    parseEpochMs(record.timestamp) ??
    parseEpochMs(record.timestamp_ms) ??
    parseEpochMs(record.timestampMs) ??
    parseEpochMs(record.time) ??
    parseEpochMs(record.ts) ??
    parseEpochMs(record.updated_at) ??
    parseEpochMs(record.updatedAt) ??
    parseEpochMs(record.start_time) ??
    parseEpochMs(record.startTime) ??
    parseEpochMs(record.started_at) ??
    parseEpochMs(record.startedAt) ??
    parseEpochMs(record.created_at) ??
    parseEpochMs(record.createdAt) ??
    parseEpochMs(record.date) ??
    null;

  const payloadRecord = asRecord(payload.payload);
  const eventRecord = asRecord(payload.event);
  const messageRecord = asRecord(payload.message);

  return (
    fromRecord(payload) ??
    fromRecord(payloadRecord) ??
    fromRecord(eventRecord) ??
    fromRecord(messageRecord) ??
    null
  );
}
