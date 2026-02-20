import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asRecord, asString, compactText, normalizePreview, parseEpochMs } from "../utils.js";
import { extractTextBlocks, makeEvent, parseJsonLines } from "./common.js";

type CursorRole = "user" | "assistant";

interface CursorRoleBlock {
  role: CursorRole;
  text: string;
  offset: number;
}

interface CursorSessionMetadata {
  model: string;
  createdAtMs: number | null;
}

const cursorSessionMetadataCache = new Map<string, CursorSessionMetadata>();
const cursorStoreDbPathCache = new Map<string, string>();

function cursorSessionCacheKey(cursorRoot: string, sessionId: string): string {
  return `${cursorRoot}::${sessionId}`;
}

function resolveCursorRootFromTranscriptPath(filePath: string): string {
  const absolute = path.resolve(filePath);
  const segments = absolute.split(path.sep);
  const cursorIndex = segments.findIndex((segment) => segment.toLowerCase() === ".cursor");
  if (cursorIndex >= 0) {
    const root = segments.slice(0, cursorIndex + 1).join(path.sep);
    return root || path.parse(absolute).root;
  }
  return path.join(os.homedir(), ".cursor");
}

function findCursorStoreDbPath(cursorRoot: string, sessionId: string): string | null {
  if (!sessionId) return null;
  const cacheKey = cursorSessionCacheKey(cursorRoot, sessionId);
  const cached = cursorStoreDbPathCache.get(cacheKey);
  if (cached && existsSync(cached)) return cached;
  if (cached) cursorStoreDbPathCache.delete(cacheKey);

  const matches = fg.sync([`chats/*/${sessionId}/store.db`], {
    cwd: cursorRoot,
    absolute: true,
    onlyFiles: true,
    dot: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });
  const discovered = matches[0] ?? "";
  if (discovered) {
    cursorStoreDbPathCache.set(cacheKey, discovered);
    return discovered;
  }
  return null;
}

function runSqliteJsonQuery(dbPath: string, sql: string): Record<string, unknown>[] {
  if (!existsSync(dbPath)) return [];
  try {
    const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const trimmed = output.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => asRecord(row))
      .filter((row): row is Record<string, unknown> => Object.keys(row).length > 0);
  } catch {
    return [];
  }
}

function decodeHexIfNeeded(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length % 2 !== 0 || !/^[\da-f]+$/i.test(trimmed)) {
    return trimmed;
  }
  try {
    return Buffer.from(trimmed, "hex").toString("utf8");
  } catch {
    return trimmed;
  }
}

function loadCursorSessionMetadata(filePath: string, sessionId: string): CursorSessionMetadata {
  const cursorRoot = resolveCursorRootFromTranscriptPath(filePath);
  const cacheKey = cursorSessionCacheKey(cursorRoot, sessionId);
  const cached = cursorSessionMetadataCache.get(cacheKey);
  if (cached) return cached;

  const storeDbPath = findCursorStoreDbPath(cursorRoot, sessionId);
  if (!storeDbPath) {
    return { model: "", createdAtMs: null };
  }

  const metadataRow =
    runSqliteJsonQuery(storeDbPath, "select value from meta where key='0' limit 1;")[0] ??
    runSqliteJsonQuery(storeDbPath, "select value from meta limit 1;")[0];

  const rawValue = asString(metadataRow?.value).trim();
  if (!rawValue) {
    return { model: "", createdAtMs: null };
  }

  const decodedValue = decodeHexIfNeeded(rawValue);
  const metadata = (() => {
    try {
      return asRecord(JSON.parse(decodedValue));
    } catch {
      return {} as Record<string, unknown>;
    }
  })();

  const resolved: CursorSessionMetadata = {
    model: asString(metadata.lastUsedModel).trim() || asString(metadata.model).trim(),
    createdAtMs: parseEpochMs(metadata.createdAt),
  };
  cursorSessionMetadataCache.set(cacheKey, resolved);
  return resolved;
}

function applyCursorEventTimestamps(
  events: ParseOutput["events"],
  startHintMs: number | null,
  endHintMs: number | null,
): void {
  if (events.length === 0) return;
  let startMs = startHintMs ?? endHintMs ?? Date.now();
  let endMs = endHintMs ?? startMs;
  if (!Number.isFinite(startMs)) startMs = Date.now();
  if (!Number.isFinite(endMs)) endMs = startMs;
  if (endMs < startMs) endMs = startMs;

  if (startMs === endMs) {
    for (let index = 0; index < events.length; index += 1) {
      events[index]!.timestampMs = startMs + index;
    }
    return;
  }

  const span = endMs - startMs;
  const denominator = Math.max(1, events.length - 1);
  for (let index = 0; index < events.length; index += 1) {
    events[index]!.timestampMs = startMs + Math.round((span * index) / denominator);
  }
}

function applyCursorEventModel(events: ParseOutput["events"], model: string): void {
  const normalizedModel = model.trim();
  if (!normalizedModel) return;
  for (const event of events) {
    if (
      event.eventKind !== "assistant" &&
      event.eventKind !== "reasoning" &&
      event.eventKind !== "tool_use" &&
      event.eventKind !== "tool_result"
    ) {
      continue;
    }
    const existingModel = asString(event.raw.model).trim();
    if (existingModel) continue;
    event.raw = {
      ...event.raw,
      model: normalizedModel,
    };
  }
}

function normalizeToolType(rawName: string): string {
  const normalized = rawName.trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) return "";
  if (normalized.includes("read")) return "read";
  if (normalized.includes("write")) return "write";
  if (normalized.includes("replace") || normalized.includes("edit") || normalized.includes("patch")) return "edit";
  if (normalized.includes("search")) return "search";
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("terminal")) return "bash";
  return normalized;
}

function splitRoleBlocks(text: string): CursorRoleBlock[] {
  const blocks: CursorRoleBlock[] = [];
  const rawLines = text.split("\n");
  let currentRole: CursorRole | null = null;
  let currentLines: string[] = [];
  let contentOffset = 0;
  let runningOffset = 0;

  const flush = (): void => {
    if (!currentRole) return;
    const joined = currentLines.join("\n").trim();
    if (!joined) return;
    blocks.push({
      role: currentRole,
      text: joined,
      offset: contentOffset,
    });
  };

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\r$/, "");
    const roleMatch = /^(user|assistant):\s*$/i.exec(line);
    if (roleMatch) {
      flush();
      currentRole = roleMatch[1]?.toLowerCase() as CursorRole;
      currentLines = [];
      contentOffset = runningOffset + rawLine.length + 1;
    } else if (currentRole) {
      currentLines.push(line);
    }
    runningOffset += rawLine.length + 1;
  }

  flush();
  return blocks;
}

function extractTaggedText(blockText: string, tagName: string): string {
  const pattern = new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i");
  const match = pattern.exec(blockText);
  return match?.[1]?.trim() ?? "";
}

function extractToolCallId(detailText: string): string {
  const match = /(?:call[_\s-]?id|id)\s*:\s*([A-Za-z0-9._:-]+)/i.exec(detailText);
  return match?.[1]?.trim() ?? "";
}

function isCursorMarkerLine(line: string): boolean {
  const trimmed = line.trim();
  return /^\[(thinking|tool call|tool result)\]/i.test(trimmed);
}

function collectMarkerPayload(lines: string[], startIndex: number): { text: string; nextIndex: number } {
  const payloadLines: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isCursorMarkerLine(line)) break;
    if (!line.trim()) {
      payloadLines.push("");
      index += 1;
      continue;
    }
    if (/^\s{2,}\S/.test(line)) {
      payloadLines.push(line.trimStart());
      index += 1;
      continue;
    }
    break;
  }
  return {
    text: payloadLines.join("\n").trim(),
    nextIndex: index,
  };
}

function makeSessionId(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

function parseCursorJsonlEvents(file: DiscoveredTraceFile, text: string, sessionId: string): ParseOutput["events"] {
  const rows = parseJsonLines(text);
  if (rows.length === 0) return [];

  const events: ParseOutput["events"] = [];
  let eventIndex = 1;
  for (const row of rows) {
    const payload = row.value;
    const role = asString(payload.role).trim().toLowerCase();
    const message = asRecord(payload.message);
    const rawContent = message.content ?? payload.content;
    const textBlocks = extractTextBlocks(rawContent);
    const fallbackText = asString(message.text).trim() || asString(payload.text).trim();
    const contentBlocks = textBlocks.length > 0 ? textBlocks : fallbackText ? [fallbackText] : [];
    const joinedText = contentBlocks.join("\n").trim();
    const preview = normalizePreview(joinedText || role || "cursor");
    const eventKind = role === "user" ? "user" : "assistant";
    const normalizedRole = role || (eventKind === "user" ? "user" : "assistant");

    events.push(
      makeEvent({
        traceId: file.id,
        index: eventIndex,
        offset: row.offset,
        timestampMs: null,
        sessionId,
        eventKind,
        rawType: `cursor_jsonl_${eventKind}`,
        role: normalizedRole,
        preview,
        textBlocks: contentBlocks,
        tocLabel: preview,
        searchChunks: [normalizedRole, joinedText],
        raw: payload,
      }),
    );
    eventIndex += 1;
  }

  return events;
}

export class CursorParser implements TraceParser {
  name = "cursor";
  agent = "cursor" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.cursor/")) confidence += 0.35;
    if (filePath.includes("/agent-transcripts/")) confidence += 0.35;
    if (filePath.endsWith(".txt")) confidence += 0.1;
    if (filePath.endsWith(".jsonl")) confidence += 0.1;
    if (head.includes("\"role\"") && head.includes("\"message\"")) confidence += 0.1;
    if (head.includes("\nuser:") || head.startsWith("user:")) confidence += 0.1;
    if (head.includes("\nassistant:") || head.startsWith("assistant:")) confidence += 0.1;
    if (head.includes("[tool call]") || head.includes("[thinking]")) confidence += 0.1;

    return Math.min(confidence, 1);
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    const sessionId = makeSessionId(file.path);
    const sessionMetadata = loadCursorSessionMetadata(file.path, sessionId);
    const jsonlEvents = parseCursorJsonlEvents(file, text, sessionId);
    if (jsonlEvents.length > 0) {
      applyCursorEventTimestamps(jsonlEvents, sessionMetadata.createdAtMs, file.mtimeMs);
      applyCursorEventModel(jsonlEvents, sessionMetadata.model);
      return {
        agent: "cursor",
        parser: this.name,
        sessionId,
        events: jsonlEvents,
        parseError: "",
      };
    }

    const blocks = splitRoleBlocks(text);
    const events: ParseOutput["events"] = [];
    const toolCallIdByName = new Map<string, string>();
    let eventIndex = 1;

    const pushEvent = (
      seed: Omit<Parameters<typeof makeEvent>[0], "traceId" | "index">,
    ): void => {
      events.push(
        makeEvent({
          traceId: file.id,
          index: eventIndex,
          ...seed,
        }),
      );
      eventIndex += 1;
    };

    for (const block of blocks) {
      if (block.role === "user") {
        const query = extractTaggedText(block.text, "user_query");
        const previewText = query || block.text;
        const preview = normalizePreview(previewText || "user");
        pushEvent({
          offset: block.offset,
          timestampMs: null,
          sessionId,
          eventKind: "user",
          rawType: "cursor_user",
          role: "user",
          preview,
          textBlocks: block.text ? [block.text] : [],
          tocLabel: preview,
          searchChunks: ["user", query, block.text],
          raw: {
            role: "user",
            text: block.text,
            query,
          },
        });
        continue;
      }

      const lines = block.text.split(/\r?\n/);
      const assistantLines: string[] = [];
      let assistantOffset = block.offset;

      const flushAssistantEvent = (offset: number): void => {
        const textBody = assistantLines.join("\n").trim();
        assistantLines.length = 0;
        if (!textBody) return;
        const preview = normalizePreview(textBody);
        pushEvent({
          offset,
          timestampMs: null,
          sessionId,
          eventKind: "assistant",
          rawType: "cursor_assistant",
          role: "assistant",
          preview,
          textBlocks: [textBody],
          tocLabel: preview,
          searchChunks: ["assistant", textBody],
          raw: {
            role: "assistant",
            text: textBody,
          },
        });
      };

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex] ?? "";
        const trimmed = line.trim();

        const thinkingMatch = /^\[Thinking\]\s*(.*)$/i.exec(trimmed);
        if (thinkingMatch) {
          flushAssistantEvent(assistantOffset);
          const thinkingText = compactText(thinkingMatch[1] ?? "");
          const preview = normalizePreview(thinkingText || "thinking");
          pushEvent({
            offset: block.offset + lineIndex,
            timestampMs: null,
            sessionId,
            eventKind: "reasoning",
            rawType: "thinking",
            role: "assistant",
            preview,
            textBlocks: thinkingText ? [thinkingText] : [],
            tocLabel: thinkingText ? preview : "Thinking",
            searchChunks: ["thinking", thinkingText],
            raw: {
              role: "assistant",
              marker: "thinking",
              text: thinkingText,
            },
          });
          assistantOffset = block.offset + lineIndex + 1;
          continue;
        }

        const toolCallMatch = /^\[Tool call\]\s*(.*)$/i.exec(trimmed);
        if (toolCallMatch) {
          flushAssistantEvent(assistantOffset);
          const toolName = (toolCallMatch[1] ?? "").trim() || "tool";
          const payload = collectMarkerPayload(lines, lineIndex);
          const detailText = payload.text;
          const explicitCallId = extractToolCallId(detailText);
          const toolCallId = explicitCallId || `cursor_tool_${eventIndex}`;
          const toolType = normalizeToolType(toolName);
          toolCallIdByName.set(toolName.toLowerCase(), toolCallId);
          const preview = normalizePreview(detailText ? `${toolName}: ${detailText}` : toolName);

          pushEvent({
            offset: block.offset + lineIndex,
            timestampMs: null,
            sessionId,
            eventKind: "tool_use",
            rawType: "tool_call",
            role: "assistant",
            preview,
            textBlocks: detailText ? [detailText] : [],
            toolUseId: toolCallId,
            toolCallId,
            toolName,
            toolType,
            functionName: toolName,
            toolArgsText: detailText,
            tocLabel: `Tool: ${toolName}`,
            searchChunks: ["tool call", toolName, toolType, detailText],
            raw: {
              role: "assistant",
              marker: "tool_call",
              toolName,
              detailText,
              toolCallId,
            },
          });

          lineIndex = payload.nextIndex - 1;
          assistantOffset = block.offset + lineIndex + 1;
          continue;
        }

        const toolResultMatch = /^\[Tool result\]\s*(.*)$/i.exec(trimmed);
        if (toolResultMatch) {
          flushAssistantEvent(assistantOffset);
          const toolName = (toolResultMatch[1] ?? "").trim();
          const payload = collectMarkerPayload(lines, lineIndex);
          const detailText = payload.text;
          const callIdFromDetails = extractToolCallId(detailText);
          const rememberedCallId = toolName ? toolCallIdByName.get(toolName.toLowerCase()) ?? "" : "";
          const toolCallId = callIdFromDetails || rememberedCallId || `cursor_tool_result_${eventIndex}`;
          const toolType = normalizeToolType(toolName);
          const preview = normalizePreview(detailText || `${toolName || "tool"} result`);

          pushEvent({
            offset: block.offset + lineIndex,
            timestampMs: null,
            sessionId,
            eventKind: "tool_result",
            rawType: "tool_result",
            role: "assistant",
            preview,
            textBlocks: detailText ? [detailText] : [],
            toolUseId: toolCallId,
            toolCallId,
            toolName,
            toolType,
            toolResultText: detailText,
            tocLabel: `Result: ${toolName || "tool"}`,
            searchChunks: ["tool result", toolName, toolType, detailText],
            raw: {
              role: "assistant",
              marker: "tool_result",
              toolName,
              detailText,
              toolCallId,
            },
          });

          lineIndex = payload.nextIndex - 1;
          assistantOffset = block.offset + lineIndex + 1;
          continue;
        }

        assistantLines.push(line);
      }

      flushAssistantEvent(assistantOffset);
    }

    applyCursorEventTimestamps(events, sessionMetadata.createdAtMs, file.mtimeMs);
    applyCursorEventModel(events, sessionMetadata.model);

    return {
      agent: "cursor",
      parser: this.name,
      sessionId,
      events,
      parseError: blocks.length === 0 ? "cursor transcript missing role blocks" : "",
    };
  }
}
