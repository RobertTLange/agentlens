import path from "node:path";
import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { eventKindFromRole, extractTextBlocks, guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

function normalizeToolType(rawName: string): string {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return "";

  const compact = normalized.replace(/[\s_-]+/g, "");
  if (compact === "bash" || compact === "execcommand" || compact === "shellcommand") return "bash";
  if (compact === "applypatch" || compact === "patch") return "patch";
  if (compact === "websearch" || compact === "googlewebsearch") return "websearch";
  if (compact === "webfetch" || compact === "fetchurl" || compact === "openurl") return "webfetch";
  if (compact === "read") return "read";
  if (compact === "write") return "write";
  if (compact === "edit" || compact === "multiedit") return "edit";
  return normalized.replace(/\s+/g, "_");
}

function fallbackSessionIdFromPath(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath)).trim();
  if (!base) return "";
  const uuidMatch = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuidMatch?.[1]) return uuidMatch[1].toLowerCase();
  const underscoreIdx = base.lastIndexOf("_");
  if (underscoreIdx >= 0 && underscoreIdx + 1 < base.length) {
    return base.slice(underscoreIdx + 1).trim();
  }
  return base;
}

export class PiParser implements TraceParser {
  name = "pi";
  agent = "pi" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.pi/")) confidence += 0.35;
    if (filePath.includes("/agent/sessions/")) confidence += 0.35;
    if (filePath.endsWith(".jsonl")) confidence += 0.05;
    if (head.includes('"type":"session"') || head.includes('"type": "session"')) confidence += 0.1;
    if (head.includes('"type":"message"') || head.includes('"type": "message"')) confidence += 0.1;
    if (head.includes('"type":"thinking_level_change"') || head.includes('"type":"model_change"')) confidence += 0.05;
    if (head.includes('"type":"toolcall"') || head.includes('"role":"toolresult"')) confidence += 0.1;

    return Math.min(confidence, 1);
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    const rows = parseJsonLines(text);
    const events: ParseOutput["events"] = [];
    let sessionId = fallbackSessionIdFromPath(file.path);
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
      const raw = row.value;
      const rawType = asString(raw.type);
      const rawTypeLower = rawType.trim().toLowerCase();
      const timestampMs = guessTimestamp(raw);
      const parentEventId = asString(raw.parentId || raw.parent_id);

      if (rawTypeLower === "session") {
        sessionId = asString(raw.id).trim() || sessionId;
        const cwd = asString(raw.cwd);
        const version = asString(raw.version);
        const preview = normalizePreview(`session: ${sessionId || "session"}`);
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "meta",
            rawType: rawTypeLower || "session",
            role: "system",
            preview,
            textBlocks: [cwd, version].filter(Boolean),
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawTypeLower, sessionId, cwd, version],
            raw,
          },
          row.offset,
        );
        continue;
      }

      if (rawTypeLower === "model_change") {
        const provider = asString(raw.provider);
        const modelId = asString(raw.modelId || raw.model_id);
        const preview = normalizePreview(`model_change: ${modelId || provider || "model"}`);
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "meta",
            rawType: rawTypeLower,
            role: "system",
            preview,
            textBlocks: [provider, modelId].filter(Boolean),
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawTypeLower, provider, modelId],
            raw,
          },
          row.offset,
        );
        continue;
      }

      if (rawTypeLower === "thinking_level_change") {
        const level = asString(raw.thinkingLevel || raw.thinking_level);
        const preview = normalizePreview(`thinking_level: ${level || "default"}`);
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "meta",
            rawType: rawTypeLower,
            role: "system",
            preview,
            textBlocks: level ? [level] : [],
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawTypeLower, level],
            raw,
          },
          row.offset,
        );
        continue;
      }

      if (rawTypeLower !== "message") {
        const preview = normalizePreview(rawTypeLower || "event");
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "meta",
            rawType: rawTypeLower || "event",
            role: "system",
            preview,
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawTypeLower],
            raw,
          },
          row.offset,
        );
        continue;
      }

      const message = asRecord(raw.message);
      const role = asString(message.role).trim().toLowerCase();
      const contentItems = asArray(message.content).map((item) => asRecord(item));
      const messageTimestampMs = guessTimestamp(message) ?? timestampMs;

      if (role === "toolresult") {
        const toolCallId = asString(message.toolCallId || message.tool_call_id);
        const toolName = asString(message.toolName || message.tool_name);
        const toolType = normalizeToolType(toolName);
        const textBlocks = extractTextBlocks(message.content);
        const toolResultText = compactText(
          textBlocks.join("\n") || message.content || message.output || message.result || message.error,
        );
        const preview = normalizePreview(toolResultText || `tool result ${toolCallId || ""}`.trim());
        pushEvent(
          {
            timestampMs: messageTimestampMs,
            sessionId,
            eventKind: "tool_result",
            rawType: role || rawTypeLower,
            role: "assistant",
            preview,
            textBlocks: toolResultText ? [toolResultText] : textBlocks,
            toolUseId: toolCallId,
            toolCallId,
            toolName,
            toolType,
            toolResultText,
            hasError: Boolean(message.isError) || Boolean(message.error),
            parentEventId,
            tocLabel: `Result: ${toolCallId || "tool"}`,
            searchChunks: [rawTypeLower, role, toolName, toolCallId, toolType, toolResultText],
            raw,
          },
          row.offset,
        );
        continue;
      }

      if (contentItems.length === 0) {
        const textBlocks = extractTextBlocks(message.content);
        const fallbackText = compactText(message.text || message.content);
        const merged = textBlocks.length > 0 ? textBlocks : fallbackText ? [fallbackText] : [];
        const preview = normalizePreview(merged[0] || role || "message");
        pushEvent(
          {
            timestampMs: messageTimestampMs,
            sessionId,
            eventKind: eventKindFromRole(role),
            rawType: role || rawTypeLower,
            role: role || "assistant",
            preview,
            textBlocks: merged,
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawTypeLower, role, ...merged],
            raw,
          },
          row.offset + rowIdx,
        );
        continue;
      }

      for (const [itemIdx, item] of contentItems.entries()) {
        const itemType = asString(item.type).trim().toLowerCase();
        const itemOffset = row.offset + itemIdx;

        if (role === "assistant" && itemType === "thinking") {
          const thinkingText = compactText(item.thinking || item.text || item.content);
          const preview = normalizePreview(thinkingText || "thinking");
          pushEvent(
            {
              timestampMs: messageTimestampMs,
              sessionId,
              eventKind: "reasoning",
              rawType: itemType || rawTypeLower,
              role: "assistant",
              preview,
              textBlocks: thinkingText ? [thinkingText] : [],
              parentEventId,
              tocLabel: thinkingText ? preview : "Thinking",
              searchChunks: [rawTypeLower, role, itemType, thinkingText],
              raw,
            },
            itemOffset,
          );
          continue;
        }

        if (role === "assistant" && itemType === "toolcall") {
          const toolName = asString(item.name || item.toolName || item.tool_name) || "tool";
          const toolCallId = asString(item.id || item.toolCallId || item.tool_call_id);
          const toolType = normalizeToolType(toolName);
          const toolArgsText = compactText(item.arguments || item.args || item.input);
          const preview = normalizePreview(toolArgsText ? `${toolName}: ${toolArgsText}` : `tool ${toolName}`);
          pushEvent(
            {
              timestampMs: messageTimestampMs,
              sessionId,
              eventKind: "tool_use",
              rawType: itemType,
              role: "assistant",
              preview,
              textBlocks: toolArgsText ? [toolArgsText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName,
              toolType,
              functionName: toolName,
              toolArgsText,
              parentEventId,
              tocLabel: `Tool: ${toolName}`,
              searchChunks: [rawTypeLower, role, itemType, toolName, toolCallId, toolType, toolArgsText],
              raw,
            },
            itemOffset,
          );
          continue;
        }

        const textBlocks = extractTextBlocks([item]);
        if (textBlocks.length === 0) {
          const compact = compactText(item.text || item.content);
          if (compact) textBlocks.push(compact);
        }
        const preview = normalizePreview(textBlocks[0] || itemType || role || rawTypeLower || "message");
        pushEvent(
          {
            timestampMs: messageTimestampMs,
            sessionId,
            eventKind: eventKindFromRole(role),
            rawType: itemType || rawTypeLower,
            role: role || "assistant",
            preview,
            textBlocks,
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawTypeLower, role, itemType, ...textBlocks],
            raw,
          },
          itemOffset,
        );
      }
    }

    return {
      agent: "pi",
      parser: this.name,
      sessionId,
      events,
      parseError: "",
    };
  }
}
