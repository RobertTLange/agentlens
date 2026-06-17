import path from "node:path";
import type { EventKind } from "@agentlens/contracts";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, normalizePreview, parseEpochMs } from "../utils.js";
import { makeEvent, parseJsonLines } from "./common.js";
import type { ParseOutput, TraceParser } from "./types.js";

function normalizeToolType(rawName: string): string {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return "";
  const compact = normalized.replace(/[\s_-]+/g, "");
  if (compact === "listdirectory" || compact === "listdir" || compact === "ls") return "list_directory";
  if (compact === "readfile" || compact === "read") return "read";
  if (compact === "editfile" || compact === "edit" || compact === "writefile" || compact === "write") return "edit";
  if (compact === "bash" || compact === "shell" || compact === "runcommand") return "bash";
  if (compact === "applypatch" || compact === "patch") return "patch";
  if (compact === "websearch" || compact === "googlewebsearch") return "websearch";
  if (compact === "webfetch" || compact === "fetchurl") return "webfetch";
  return normalized.replace(/\s+/g, "_");
}

function sessionIdFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const marker = "/brain/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) {
    const tail = normalized.slice(markerIndex + marker.length);
    const conversationId = tail.split("/", 1)[0]?.trim() ?? "";
    if (conversationId) return conversationId;
  }

  const parent = path.basename(path.dirname(filePath)).trim();
  if (parent && parent !== "logs") return parent;
  return path.basename(filePath, path.extname(filePath)).trim();
}

function timestampMs(row: Record<string, unknown>): number | null {
  return (
    parseEpochMs(row.created_at) ??
    parseEpochMs(row.createdAt) ??
    parseEpochMs(row.timestamp) ??
    parseEpochMs(row.time) ??
    null
  );
}

function roleForType(type: string, source: string): string {
  if (type === "USER_INPUT" || source.startsWith("USER")) return "user";
  if (type === "SYSTEM_MESSAGE" || type === "CONVERSATION_HISTORY" || source === "SYSTEM") return "system";
  return "assistant";
}

function eventKindForRow(type: string, role: string): EventKind {
  if (type === "CONVERSATION_HISTORY") return "meta";
  if (role === "user") return "user";
  if (role === "system") return "system";
  return "assistant";
}

function hasErrorStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized.includes("error") || normalized.includes("fail");
}

function isToolResultRow(type: string, row: Record<string, unknown>): boolean {
  if (!type || type === "USER_INPUT" || type === "PLANNER_RESPONSE" || type === "SYSTEM_MESSAGE" || type === "CONVERSATION_HISTORY") {
    return false;
  }
  return typeof row.content === "string" || row.content !== undefined || row.result !== undefined || row.output !== undefined;
}

function fullText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return asString(value).trim();
}

function rowContentText(row: Record<string, unknown>): string {
  return fullText(row.content) || fullText(row.message) || fullText(row.text) || fullText(row.result) || fullText(row.output);
}

function conversationHistoryRaw(row: Record<string, unknown>): Record<string, unknown> {
  const { content, message, text, result, output, ...rest } = row;
  return rest;
}

export class AntigravityParser implements TraceParser {
  name = "antigravity";
  agent = "antigravity" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    if (file.agentHint === "gemini" || file.parserHint === "gemini") return 0;
    let confidence = 0;
    const filePath = file.path.toLowerCase().replace(/\\/g, "/");
    const head = headText.toLowerCase();

    if (filePath.endsWith("/transcript_full.jsonl")) return 0;
    if (filePath.includes("/.gemini/antigravity-cli/")) confidence += 0.45;
    if (filePath.includes("/brain/")) confidence += 0.2;
    if (filePath.endsWith("/.system_generated/logs/transcript.jsonl")) confidence += 0.25;
    if (filePath.endsWith("/transcript.jsonl")) confidence += 0.1;
    if (head.includes('"step_index"') && head.includes('"source"') && head.includes('"status"')) confidence += 0.25;
    if (
      head.includes('"user_input"') ||
      head.includes('"planner_response"') ||
      head.includes('"conversation_history"') ||
      head.includes('"system_message"')
    ) {
      confidence += 0.25;
    }

    return Math.min(confidence, 1);
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    const rows = parseJsonLines(text);
    const sessionId = sessionIdFromPath(file.path);
    const events: ParseOutput["events"] = [];
    let eventIndex = 1;
    const toolTypeByCallId = new Map<string, string>();
    const pendingToolCallIdsByType = new Map<string, string[]>();

    const pushEvent = (seed: Omit<Parameters<typeof makeEvent>[0], "traceId" | "index" | "sessionId">): void => {
      events.push(
        makeEvent({
          traceId: file.id,
          index: eventIndex,
          sessionId,
          ...seed,
        }),
      );
      eventIndex += 1;
    };

    for (const row of rows) {
      const type = asString(row.value.type).trim().toUpperCase();
      const source = asString(row.value.source).trim().toUpperCase();
      const status = asString(row.value.status);
      const rowTimestampMs = timestampMs(row.value);
      const rowId = asString(row.value.id || row.value.step_id || row.value.step_index);
      const role = roleForType(type, source);
      const contentText = rowContentText(row.value);
      const rowOffset = row.offset;

      if (type === "CONVERSATION_HISTORY") {
        pushEvent({
          offset: rowOffset,
          timestampMs: rowTimestampMs,
          eventKind: "meta",
          rawType: type,
          role: "system",
          preview: "Conversation history",
          textBlocks: [],
          parentEventId: rowId,
          tocLabel: "Conversation history",
          hasError: hasErrorStatus(status),
          searchChunks: [type, source, status],
          raw: conversationHistoryRaw(row.value),
        });
      } else if (contentText && !isToolResultRow(type, row.value)) {
        const eventKind = eventKindForRow(type, role);
        pushEvent({
          offset: rowOffset,
          timestampMs: rowTimestampMs,
          eventKind,
          rawType: type || "message",
          role,
          preview: normalizePreview(contentText),
          textBlocks: [contentText],
          parentEventId: rowId,
          tocLabel: eventKind === "meta" ? "Conversation history" : normalizePreview(contentText),
          hasError: hasErrorStatus(status),
          searchChunks: [type, source, status, contentText],
          raw: row.value,
        });
      }

      for (const [toolIdx, toolCallValue] of asArray(row.value.tool_calls).entries()) {
        const toolCall = asRecord(toolCallValue);
        const toolName = asString(toolCall.name || toolCall.type || toolCall.tool_name) || "tool";
        const toolCallId = asString(toolCall.id || toolCall.call_id || toolCall.tool_call_id) || `${rowId || rowOffset}:tool:${toolIdx}`;
        const toolType = normalizeToolType(toolName);
        const toolArgsText = fullText(toolCall.arguments || toolCall.args || toolCall.input || toolCall.params);
        if (toolCallId && toolType) {
          toolTypeByCallId.set(toolCallId, toolType);
          const pending = pendingToolCallIdsByType.get(toolType) ?? [];
          pending.push(toolCallId);
          pendingToolCallIdsByType.set(toolType, pending);
        }
        const preview = normalizePreview(toolArgsText ? `${toolName}: ${toolArgsText}` : `tool ${toolName}`);
        pushEvent({
          offset: rowOffset + 100 + toolIdx,
          timestampMs: timestampMs(toolCall) ?? rowTimestampMs,
          eventKind: "tool_use",
          rawType: "tool_call",
          role: "assistant",
          preview,
          textBlocks: toolArgsText ? [toolArgsText] : [],
          toolUseId: toolCallId,
          toolCallId,
          toolName,
          toolType,
          functionName: toolName,
          toolArgsText,
          parentEventId: rowId,
          tocLabel: `Tool: ${toolName}`,
          hasError: hasErrorStatus(status),
          searchChunks: [type, source, status, toolName, toolCallId, toolType, toolArgsText],
          raw: row.value,
        });
      }

      if (isToolResultRow(type, row.value)) {
        const explicitToolCallId = asString(row.value.tool_call_id || row.value.toolCallId || row.value.call_id || row.value.tool_use_id);
        const toolName = asString(row.value.tool_name || row.value.toolName) || type;
        const toolType = normalizeToolType(toolName) || (explicitToolCallId ? toolTypeByCallId.get(explicitToolCallId) : "") || "";
        const pendingToolCallIds = toolType ? (pendingToolCallIdsByType.get(toolType) ?? []) : [];
        const inferredToolCallId = explicitToolCallId || pendingToolCallIds.shift() || asString(row.value.id || row.value.step_index);
        const toolCallId = inferredToolCallId;
        const toolResultText = contentText || status || type;
        pushEvent({
          offset: rowOffset + 500,
          timestampMs: rowTimestampMs,
          eventKind: "tool_result",
          rawType: type,
          role: "assistant",
          preview: normalizePreview(toolResultText),
          textBlocks: toolResultText ? [toolResultText] : [],
          toolUseId: toolCallId,
          toolCallId,
          toolName,
          toolType,
          toolResultText,
          parentEventId: rowId,
          tocLabel: `Result: ${toolName || "tool"}`,
          hasError: hasErrorStatus(status),
          searchChunks: [type, source, status, toolName, toolCallId, toolType, toolResultText],
          raw: row.value,
        });
      }
    }

    return {
      agent: "antigravity",
      parser: this.name,
      sessionId,
      events,
      parseError: rows.length > 0 ? "" : "No parseable Antigravity events",
    };
  }
}
