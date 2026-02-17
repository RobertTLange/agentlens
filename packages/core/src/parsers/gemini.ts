import path from "node:path";
import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { eventKindFromRole, extractTextBlocks, guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

function normalizeToolType(rawName: string): string {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return "";
  const compact = normalized.replace(/[\s_-]+/g, "");
  if (compact === "googlewebsearch" || compact === "websearch") return "websearch";
  if (compact === "webfetch" || compact === "fetchurl" || compact === "openurl") return "webfetch";
  if (
    compact === "bash" ||
    compact === "execcommand" ||
    compact === "shellcommand" ||
    compact === "writestdin" ||
    compact === "commandexecution"
  ) {
    return "bash";
  }
  if (compact === "applypatch" || compact === "patch") return "patch";
  return normalized.replace(/\s+/g, "_");
}

function roleForType(rawType: string): string {
  const normalized = rawType.trim().toLowerCase();
  if (!normalized) return "assistant";
  if (normalized === "gemini" || normalized === "model" || normalized === "assistant") return "assistant";
  if (normalized === "user") return "user";
  if (normalized === "system") return "system";
  return normalized;
}

function fallbackSessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)).trim();
  if (!base) return "";
  return base.replace(/^session-/, "");
}

function extractPartRecords(content: unknown, partsFallback: unknown): Record<string, unknown>[] {
  const fromContent = asArray(content).flatMap((item) => asArray(asRecord(item).parts).map((part) => asRecord(part)));
  if (fromContent.length > 0) return fromContent;
  return asArray(partsFallback).map((part) => asRecord(part));
}

function extractRowTextBlocks(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
  };

  if (typeof row.message === "string") push(row.message);
  if (typeof row.content === "string") push(row.content);
  if (typeof row.text === "string") push(row.text);

  const appendFromContent = (content: unknown): void => {
    for (const item of asArray(content)) {
      const record = asRecord(item);
      const text = asString(record.text).trim();
      if (text) push(text);
      for (const part of asArray(record.parts)) {
        const partText = asString(asRecord(part).text).trim();
        if (partText) push(partText);
      }
    }
    const extracted = extractTextBlocks(content);
    for (const text of extracted) push(text);
  };

  appendFromContent(row.content);
  appendFromContent(asRecord(row.message).content);

  const deduped = new Set<string>();
  return out.filter((value) => {
    if (deduped.has(value)) return false;
    deduped.add(value);
    return true;
  });
}

function hasErrorStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes("error") || normalized.includes("fail");
}

interface ToolResultEntry {
  text: string;
  timestampMs: number | null;
  hasError: boolean;
}

function extractToolResultEntries(toolCall: Record<string, unknown>): ToolResultEntry[] {
  const status = asString(toolCall.status);
  const statusError = hasErrorStatus(status);
  const records: Record<string, unknown>[] = [];

  const directFunctionResponse = asRecord(toolCall.functionResponse);
  if (Object.keys(directFunctionResponse).length > 0) records.push(directFunctionResponse);

  for (const item of asArray(toolCall.result)) {
    const itemRecord = asRecord(item);
    const functionResponse = asRecord(itemRecord.functionResponse);
    if (Object.keys(functionResponse).length > 0) {
      records.push(functionResponse);
      continue;
    }
    if (Object.keys(itemRecord).length > 0) {
      records.push(itemRecord);
    }
  }

  if (records.length === 0) {
    const fallbackText =
      compactText(toolCall.resultDisplay) || compactText(toolCall.result) || compactText(toolCall.response) || status;
    if (!fallbackText) return [];
    return [
      {
        text: fallbackText,
        timestampMs: guessTimestamp(toolCall),
        hasError: statusError,
      },
    ];
  }

  return records.map((record) => {
    const response = asRecord(record.response);
    return {
      text:
        compactText(record.response) ||
        compactText(record.output) ||
        compactText(record.result) ||
        compactText(record.content) ||
        compactText(toolCall.resultDisplay) ||
        compactText(record),
      timestampMs: guessTimestamp(record) ?? guessTimestamp(toolCall),
      hasError: statusError || Boolean(record.error) || Boolean(response.error),
    };
  });
}

export class GeminiParser implements TraceParser {
  name = "gemini";
  agent = "gemini" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.gemini/")) confidence += 0.45;
    if (filePath.includes("/tmp/")) confidence += 0.1;
    if (filePath.includes("/chats/")) confidence += 0.15;
    if (/\/session-[^/]+\.json$/.test(filePath)) confidence += 0.2;
    if (filePath.endsWith(".jsonl")) confidence += 0.05;
    if (head.includes('"projecthash"') && head.includes('"messages"')) confidence += 0.15;
    if (head.includes('"type":"gemini"') || head.includes('"toolcalls"') || head.includes('"sessionid"')) confidence += 0.15;

    return Math.min(confidence, 1);
  }

  private parseRows(file: DiscoveredTraceFile, rows: Record<string, unknown>[], initialSessionId = ""): ParseOutput {
    const events: ParseOutput["events"] = [];
    const toolTypeByCallId = new Map<string, string>();
    let sessionId = initialSessionId;
    let eventIndex = 1;

    const pushEvent = (
      seed: Omit<Parameters<typeof makeEvent>[0], "traceId" | "index" | "offset">,
      offset: number,
    ): void => {
      events.push(
        makeEvent({
          traceId: file.id,
          index: eventIndex,
          offset,
          ...seed,
        }),
      );
      eventIndex += 1;
    };

    for (const [rowIdx, row] of rows.entries()) {
      const rawType = asString(row.type).toLowerCase() || "message";
      const role = roleForType(rawType);
      const timestampMs = guessTimestamp(row);
      const rowSessionId = asString(row.sessionId || row.session_id || row.chatId || row.conversationId);
      const rowId = asString(row.id || row.messageId || row.message_id);
      sessionId ||= rowSessionId;
      const baseOffset = rowIdx * 1000;

      let emittedContentEvent = false;
      const parts = extractPartRecords(row.content, row.parts);
      for (const [partIdx, part] of parts.entries()) {
        const partOffset = baseOffset + partIdx;
        const functionCall = asRecord(part.functionCall);
        if (Object.keys(functionCall).length > 0) {
          const toolName = asString(functionCall.name) || "tool";
          const toolCallId = asString(functionCall.id || part.id || `${rowIdx}:${partIdx}`);
          const toolType = normalizeToolType(toolName);
          const toolArgsText = compactText(functionCall.args || functionCall.arguments || functionCall.input);
          if (toolCallId && toolType) {
            toolTypeByCallId.set(toolCallId, toolType);
          }
          const preview = normalizePreview(toolArgsText ? `${toolName}: ${toolArgsText}` : `tool ${toolName}`);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "tool_use",
              rawType: "function_call",
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
              searchChunks: [rawType, role, toolName, toolCallId, toolType, toolArgsText],
              raw: row,
            },
            partOffset,
          );
          continue;
        }

        const functionResponse = asRecord(part.functionResponse);
        if (Object.keys(functionResponse).length > 0) {
          const toolCallId = asString(functionResponse.id || part.id || `${rowIdx}:${partIdx}`);
          const toolName = asString(functionResponse.name) || asString(part.name);
          const toolType = normalizeToolType(toolName) || toolTypeByCallId.get(toolCallId) || "";
          const toolResultText = compactText(functionResponse.response || functionResponse.output || functionResponse.result);
          const hasError = Boolean(asRecord(functionResponse.response).error) || Boolean(functionResponse.error);
          const preview = normalizePreview(toolResultText || `tool result ${toolCallId || ""}`.trim());
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "tool_result",
              rawType: "function_response",
              role: "assistant",
              preview,
              textBlocks: toolResultText ? [toolResultText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName,
              toolType,
              toolResultText,
              hasError,
              parentEventId: rowId,
              tocLabel: `Result: ${toolCallId || "tool"}`,
              searchChunks: [rawType, role, toolName, toolCallId, toolType, toolResultText],
              raw: row,
            },
            partOffset,
          );
          continue;
        }

        const partText = asString(part.text).trim();
        if (partText) {
          const preview = normalizePreview(partText);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: eventKindFromRole(role),
              rawType: rawType || "message_part",
              role,
              preview,
              textBlocks: [partText],
              parentEventId: rowId,
              tocLabel: preview,
              searchChunks: [rawType, role, partText],
              raw: row,
            },
            partOffset,
          );
          emittedContentEvent = true;
        }
      }

      const thoughtBlocks = extractTextBlocks(row.thoughts).map((text) => text.trim()).filter(Boolean);
      if (thoughtBlocks.length > 0) {
        const reasoningText = compactText(thoughtBlocks.join("\n"));
        const preview = normalizePreview(reasoningText || "thinking");
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "reasoning",
            rawType: "thoughts",
            role: "assistant",
            preview,
            textBlocks: reasoningText ? [reasoningText] : [],
            parentEventId: rowId,
            tocLabel: "Thinking",
            searchChunks: [rawType, role, reasoningText],
            raw: row,
          },
          baseOffset + 500,
        );
      }

      const toolCalls = asArray(row.toolCalls).map((value) => asRecord(value));
      for (const [toolIdx, toolCall] of toolCalls.entries()) {
        const toolName =
          asString(toolCall.name || toolCall.function || asRecord(toolCall.functionCall).name) || "tool";
        const toolCallId =
          asString(toolCall.id || toolCall.call_id || toolCall.callId || asRecord(toolCall.functionCall).id) ||
          `${rowIdx}:tool:${toolIdx}`;
        const toolType = normalizeToolType(toolName);
        const toolArgsText = compactText(toolCall.args || asRecord(toolCall.functionCall).args || asRecord(toolCall.functionCall).arguments);
        if (toolCallId && toolType) {
          toolTypeByCallId.set(toolCallId, toolType);
        }
        const toolTimestampMs = guessTimestamp(toolCall) ?? timestampMs;
        const toolUsePreview = normalizePreview(toolArgsText ? `${toolName}: ${toolArgsText}` : `tool ${toolName}`);
        pushEvent(
          {
            timestampMs: toolTimestampMs,
            sessionId,
            eventKind: "tool_use",
            rawType: "tool_call",
            role: "assistant",
            preview: toolUsePreview,
            textBlocks: toolArgsText ? [toolArgsText] : [],
            toolUseId: toolCallId,
            toolCallId,
            toolName,
            toolType,
            functionName: toolName,
            toolArgsText,
            parentEventId: rowId,
            tocLabel: `Tool: ${toolName}`,
            searchChunks: [rawType, role, toolName, toolCallId, toolType, toolArgsText],
            raw: row,
          },
          baseOffset + 600 + toolIdx * 10,
        );

        const resultEntries = extractToolResultEntries(toolCall);
        for (const [resultIdx, result] of resultEntries.entries()) {
          const toolResultPreview = normalizePreview(result.text || `tool result ${toolCallId}`);
          pushEvent(
            {
              timestampMs: result.timestampMs ?? toolTimestampMs,
              sessionId,
              eventKind: "tool_result",
              rawType: "tool_result",
              role: "assistant",
              preview: toolResultPreview,
              textBlocks: result.text ? [result.text] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName,
              toolType: toolType || toolTypeByCallId.get(toolCallId) || "",
              toolResultText: result.text,
              hasError: result.hasError,
              parentEventId: rowId,
              tocLabel: `Result: ${toolCallId}`,
              searchChunks: [rawType, role, toolName, toolCallId, toolType, result.text],
              raw: row,
            },
            baseOffset + 601 + toolIdx * 10 + resultIdx,
          );
        }
      }

      const textBlocks = extractRowTextBlocks(row);
      const isMessageType =
        rawType === "user" || rawType === "gemini" || rawType === "assistant" || rawType === "model" || rawType === "system";
      if (textBlocks.length > 0 || (isMessageType && !emittedContentEvent && toolCalls.length === 0)) {
        const preview = normalizePreview(textBlocks[0] || compactText(row.content) || compactText(row.message) || rawType || "message");
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: eventKindFromRole(role),
            rawType,
            role,
            preview,
            textBlocks,
            parentEventId: rowId,
            tocLabel: preview,
            searchChunks: [rawType, role, rowId, ...textBlocks],
            raw: row,
          },
          baseOffset + 900,
        );
      }
    }

    return {
      agent: "gemini",
      parser: this.name,
      sessionId: sessionId || fallbackSessionIdFromPath(file.path),
      events,
      parseError: "",
    };
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const payload = parsed as Record<string, unknown>;
        const initialSessionId = asString(payload.sessionId || payload.session_id) || fallbackSessionIdFromPath(file.path);
        const messages = asArray(payload.messages).map((value) => asRecord(value));
        if (messages.length > 0) {
          return this.parseRows(file, messages, initialSessionId);
        }
        return this.parseRows(file, [payload], initialSessionId);
      }
      if (Array.isArray(parsed)) {
        const rows = parsed
          .map((value) => asRecord(value))
          .filter((row) => Object.keys(row).length > 0);
        if (rows.length > 0) {
          const firstSessionId = asString(rows[0]?.sessionId || rows[0]?.session_id);
          return this.parseRows(file, rows, firstSessionId || fallbackSessionIdFromPath(file.path));
        }
      }
    } catch {
      // Fall through to JSONL parsing.
    }

    const rows = parseJsonLines(text).map((row) => row.value);
    if (rows.length > 0) {
      return this.parseRows(file, rows, fallbackSessionIdFromPath(file.path));
    }

    return {
      agent: "gemini",
      parser: this.name,
      sessionId: fallbackSessionIdFromPath(file.path),
      events: [],
      parseError: "No parseable Gemini events",
    };
  }
}
