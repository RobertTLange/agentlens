import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { eventKindFromRole, extractTextBlocks, guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

function normalizeToolType(rawName: string): string {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return "";
  if (
    normalized === "exec_command" ||
    normalized === "shell_command" ||
    normalized === "write_stdin" ||
    normalized === "command_execution"
  ) {
    return "bash";
  }
  if (normalized === "apply_patch") return "patch";
  if (normalized === "request_user_input") return "input";
  if (normalized === "update_plan") return "plan";
  if (normalized === "view_image") return "image";
  return normalized;
}

function normalizeWebToolType(rawActionType: string): string {
  const normalized = rawActionType.trim().toLowerCase();
  if (!normalized) return "web";
  if (normalized === "search") return "web:search";
  if (normalized === "open_page") return "web:open";
  if (normalized === "find_in_page") return "web:find";
  return "web";
}

function collectSummaryTextEntries(value: unknown): string[] {
  const entries: string[] = [];
  const collectFromItems = (items: unknown[]): void => {
    for (const item of items) {
      const record = asRecord(item);
      const itemType = asString(record.type).toLowerCase();
      if (itemType === "summary_text") {
        const text = asString(record.text).trim();
        if (text) entries.push(text);
      }
    }
  };

  collectFromItems(asArray(value));
  const record = asRecord(value);
  const recordType = asString(record.type).toLowerCase();
  if (recordType === "summary_text") {
    const text = asString(record.text).trim();
    if (text) entries.push(text);
  }
  collectFromItems(asArray(record.content));
  return entries;
}

function formatReasoningText(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;

    const summaryEntries = collectSummaryTextEntries(candidate);
    if (summaryEntries.length > 0) {
      return `Summary: ${summaryEntries.join(" ")}`;
    }

    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if ((trimmed.startsWith("[") || trimmed.startsWith("{")) && trimmed.length > 1) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          const parsedSummaryEntries = collectSummaryTextEntries(parsed);
          if (parsedSummaryEntries.length > 0) {
            return `Summary: ${parsedSummaryEntries.join(" ")}`;
          }
        } catch {
          // fall back to compact text
        }
      }
    }

    const compact = compactText(candidate);
    if (compact) return compact;
  }
  return "";
}

export class CodexParser implements TraceParser {
  name = "codex";
  agent = "codex" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.codex/")) confidence += 0.4;
    if (filePath.includes("/sessions/")) confidence += 0.2;
    if (filePath.endsWith(".jsonl")) confidence += 0.1;
    if (head.includes('"type":"response_item"') || head.includes('"type": "response_item"')) confidence += 0.2;
    if (head.includes('"type":"session_meta"') || head.includes('"type": "session_meta"')) confidence += 0.2;
    if (head.includes('"type":"item.started"') || head.includes('"type":"item.completed"')) confidence += 0.1;

    return Math.min(confidence, 1);
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    const rows = parseJsonLines(text);
    const events: ParseOutput["events"] = [];
    const toolTypeByCallId = new Map<string, string>();
    let sessionId = "";
    let eventIndex = 1;

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];
      if (!row) continue;

      const value = row.value;
      const rawType = asString(value.type);
      const timestampMs = guessTimestamp(value);
      const parentEventId = asString(value.parent_id || value.parentId || value.parent_event_id);
      const rememberToolType = (toolCallId: string, toolType: string): void => {
        if (!toolCallId || !toolType) return;
        toolTypeByCallId.set(toolCallId, toolType);
      };
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

      if (rawType === "session_meta") {
        const payload = asRecord(value.payload);
        sessionId ||= asString(payload.id);
        const preview = normalizePreview(`session_meta: ${asString(payload.id) || "session"}`);
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "meta",
            rawType,
            role: "system",
            preview,
            textBlocks: [asString(payload.cwd), asString(payload.cli_version)].filter(Boolean),
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawType, asString(payload.id), asString(payload.cwd), asString(payload.cli_version)],
            raw: value,
          },
          row.offset,
        );
        continue;
      }

      if (rawType === "response_item") {
        const payload = asRecord(value.payload);
        const payloadType = asString(payload.type).toLowerCase();
        const role = asString(payload.role).toLowerCase() || "assistant";
        const callId = asString(payload.call_id || payload.id);
        const toolName = asString(payload.name || payload.function || payload.tool_name);

        if (payloadType === "message") {
          const content = asArray(payload.content).map((item) => asRecord(item));
          if (content.length === 0) {
            const textBlocks = extractTextBlocks(payload.content);
            const preview = normalizePreview(textBlocks[0] || payloadType || role || rawType);
            pushEvent(
              {
                timestampMs,
                sessionId,
                eventKind: eventKindFromRole(role),
                rawType: payloadType || rawType,
                role,
                preview,
                textBlocks,
                parentEventId,
                tocLabel: preview,
                searchChunks: [rawType, payloadType, role, ...textBlocks],
                raw: value,
              },
              row.offset,
            );
            continue;
          }

          for (const [itemIdx, item] of content.entries()) {
            const itemType = asString(item.type).toLowerCase() || payloadType;
            const itemOffset = row.offset + itemIdx;
            if (itemType === "tool_use" || itemType === "function_call") {
              const resolvedToolName = asString(item.name || item.function || toolName) || "tool";
              const toolCallId = asString(item.id || item.call_id || item.tool_use_id || callId);
              const toolType = normalizeToolType(asString(item.name || item.function || toolName || resolvedToolName));
              const toolArgsText = compactText(item.arguments || item.input || item.params || payload.arguments || payload.input);
              const preview = normalizePreview(toolArgsText ? `${resolvedToolName}: ${toolArgsText}` : `tool ${resolvedToolName}`);
              rememberToolType(toolCallId, toolType);

              pushEvent(
                {
                  timestampMs,
                  sessionId,
                  eventKind: "tool_use",
                  rawType: itemType,
                  role: "assistant",
                  preview,
                  textBlocks: toolArgsText ? [toolArgsText] : [],
                  toolUseId: toolCallId,
                  toolCallId,
                  toolName: resolvedToolName,
                  toolType,
                  functionName: resolvedToolName,
                  toolArgsText,
                  parentEventId,
                  tocLabel: `Tool: ${resolvedToolName}`,
                  searchChunks: [rawType, payloadType, itemType, resolvedToolName, toolCallId, toolType, toolArgsText],
                  raw: value,
                },
                itemOffset,
              );
              continue;
            }

            if (itemType === "tool_result" || itemType === "function_call_output") {
              const toolCallId = asString(item.tool_use_id || item.call_id || item.id || callId);
              const resolvedToolName = asString(item.name || toolName);
              const toolType = normalizeToolType(resolvedToolName) || toolTypeByCallId.get(toolCallId) || "";
              const resultText = compactText(item.output || item.content || item.result || payload.output || payload.result);
              const hasError =
                Boolean(item.is_error) ||
                Boolean(item.error) ||
                Boolean(asRecord(payload.tool_use_result).stderr) ||
                Boolean(asRecord(payload.result).error);
              const preview = normalizePreview(resultText || `tool result ${toolCallId || ""}`.trim());
              pushEvent(
                {
                  timestampMs,
                  sessionId,
                  eventKind: "tool_result",
                  rawType: itemType,
                  role,
                  preview,
                  textBlocks: resultText ? [resultText] : [],
                  toolUseId: toolCallId,
                  toolCallId,
                  toolName: resolvedToolName,
                  toolType,
                  toolResultText: resultText,
                  hasError,
                  parentEventId,
                  tocLabel: `Result: ${toolCallId || "tool"}`,
                  searchChunks: [rawType, payloadType, itemType, role, toolCallId, toolType, resultText],
                  raw: value,
                },
                itemOffset,
              );
              continue;
            }

            if (itemType === "thinking" || itemType === "reasoning") {
              const reasoningText = formatReasoningText(item.text, item.content, payload.summary);
              const preview = normalizePreview(reasoningText || itemType);
              pushEvent(
                {
                  timestampMs,
                  sessionId,
                  eventKind: "reasoning",
                  rawType: itemType,
                  role: "assistant",
                  preview,
                  textBlocks: reasoningText ? [reasoningText] : [],
                  parentEventId,
                  tocLabel: "Thinking",
                  searchChunks: [rawType, payloadType, itemType, reasoningText],
                  raw: value,
                },
                itemOffset,
              );
              continue;
            }

            const textBlocks = extractTextBlocks([item]);
            const preview = normalizePreview(textBlocks[0] || compactText(item.text || item.content) || itemType || role);
            pushEvent(
              {
                timestampMs,
                sessionId,
                eventKind: eventKindFromRole(role),
                rawType: itemType,
                role,
                preview,
                textBlocks,
                parentEventId,
                tocLabel: preview,
                searchChunks: [rawType, payloadType, itemType, role, ...textBlocks],
                raw: value,
              },
              itemOffset,
            );
          }
          continue;
        }

        if (payloadType === "function_call" || payloadType === "tool_use") {
          const resolvedToolName = toolName || "tool";
          const toolCallId = callId || asString(payload.tool_use_id);
          const toolType = normalizeToolType(resolvedToolName);
          const toolArgsText = compactText(payload.arguments || payload.input || payload.params);
          const preview = normalizePreview(toolArgsText ? `${resolvedToolName}: ${toolArgsText}` : `tool ${resolvedToolName}`);
          rememberToolType(toolCallId, toolType);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "tool_use",
              rawType: payloadType,
              role: role || "assistant",
              preview,
              textBlocks: toolArgsText ? [toolArgsText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName: resolvedToolName,
              toolType,
              functionName: resolvedToolName,
              toolArgsText,
              parentEventId,
              tocLabel: `Tool: ${resolvedToolName}`,
              searchChunks: [rawType, payloadType, resolvedToolName, toolCallId, toolType, toolArgsText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "function_call_output" || payloadType === "tool_result") {
          const toolCallId = callId || asString(payload.tool_use_id);
          const toolType = normalizeToolType(toolName) || toolTypeByCallId.get(toolCallId) || "";
          const resultText = compactText(payload.output || payload.result || payload.content);
          const hasError = Boolean(payload.is_error) || Boolean(asRecord(payload.result).error);
          const preview = normalizePreview(resultText || `tool result ${toolCallId || ""}`.trim());
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "tool_result",
              rawType: payloadType,
              role: role || "assistant",
              preview,
              textBlocks: resultText ? [resultText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName,
              toolType,
              toolResultText: resultText,
              hasError,
              parentEventId,
              tocLabel: `Result: ${toolCallId || "tool"}`,
              searchChunks: [rawType, payloadType, toolCallId, toolType, resultText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "custom_tool_call") {
          const resolvedToolName = toolName || asString(payload.tool) || "tool";
          const toolCallId = asString(payload.call_id || payload.id);
          const toolType = normalizeToolType(resolvedToolName);
          const toolArgsText = compactText(payload.input || payload.arguments || payload.params);
          const preview = normalizePreview(toolArgsText ? `${resolvedToolName}: ${toolArgsText}` : `tool ${resolvedToolName}`);
          rememberToolType(toolCallId, toolType);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "tool_use",
              rawType: payloadType,
              role: role || "assistant",
              preview,
              textBlocks: toolArgsText ? [toolArgsText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName: resolvedToolName,
              toolType,
              functionName: resolvedToolName,
              toolArgsText,
              parentEventId,
              tocLabel: `Tool: ${resolvedToolName}`,
              searchChunks: [rawType, payloadType, resolvedToolName, toolCallId, toolType, toolArgsText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "custom_tool_call_output") {
          const toolCallId = asString(payload.call_id || payload.id);
          const resolvedToolName = toolName || asString(payload.tool_name);
          const toolType = normalizeToolType(resolvedToolName) || toolTypeByCallId.get(toolCallId) || "";
          const resultText = compactText(payload.output || payload.result || payload.content);
          const hasError = Boolean(payload.is_error) || Boolean(asRecord(payload.result).error);
          const preview = normalizePreview(resultText || `tool result ${toolCallId || ""}`.trim());
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "tool_result",
              rawType: payloadType,
              role: role || "assistant",
              preview,
              textBlocks: resultText ? [resultText] : [],
              toolUseId: toolCallId,
              toolCallId,
              toolName: resolvedToolName,
              toolType,
              toolResultText: resultText,
              hasError,
              parentEventId,
              tocLabel: `Result: ${toolCallId || resolvedToolName || "tool"}`,
              searchChunks: [rawType, payloadType, toolCallId, resolvedToolName, toolType, resultText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "web_search_call") {
          const action = asRecord(payload.action);
          const actionType = asString(action.type).toLowerCase();
          const query = asString(action.query);
          const url = asString(action.url);
          const status = asString(payload.status);
          const toolType = normalizeWebToolType(actionType);
          const preview = normalizePreview(query || url || `${payloadType}: ${actionType || status || "event"}`);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: eventKindFromRole(role),
              rawType: payloadType,
              role: role || "assistant",
              preview,
              textBlocks: [query, url].filter(Boolean),
              toolType,
              parentEventId,
              tocLabel: actionType ? `Web: ${actionType}` : "Web",
              searchChunks: [rawType, payloadType, role, status, actionType, toolType, query, url],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "reasoning" || payloadType === "thinking") {
          const reasoningText = formatReasoningText(payload.summary, payload.text, payload.content);
          const preview = normalizePreview(reasoningText || payloadType);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: "reasoning",
              rawType: payloadType,
              role: "assistant",
              preview,
              textBlocks: reasoningText ? [reasoningText] : [],
              parentEventId,
              tocLabel: "Thinking",
              searchChunks: [rawType, payloadType, reasoningText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        const textBlocks = extractTextBlocks(payload.content);
        const preview = normalizePreview(textBlocks[0] || compactText(payloadType || rawType || role));
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: eventKindFromRole(role),
            rawType: payloadType || rawType,
            role,
            preview,
            textBlocks,
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawType, payloadType, role, ...textBlocks],
            raw: value,
          },
          row.offset,
        );
        continue;
      }

      if (rawType.startsWith("item.")) {
        const item = asRecord(value.item);
        const itemType = asString(item.type);
        const command = compactText(item.command || item.args || item.arguments);
        const output = compactText(item.aggregated_output || item.output || item.result);
        const itemId = asString(item.id || item.call_id || item.callId);
        const toolName = itemType === "command_execution" ? "Bash" : asString(item.name) || "tool";
        const toolType = normalizeToolType(itemType === "command_execution" ? itemType : asString(item.name || itemType));
        const isStart = rawType === "item.started";
        const isComplete = rawType === "item.completed" || rawType === "item.finished";

        if (isStart || isComplete) {
          const eventKind = isStart ? "tool_use" : "tool_result";
          const hasError = Number(item.exit_code) !== 0 && item.exit_code !== null;
          const preview = normalizePreview(command || output || toolName || itemType || rawType);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind,
              rawType: itemType || rawType,
              role: "assistant",
              preview,
              textBlocks: [command, output].filter(Boolean),
              toolUseId: itemId,
              toolCallId: itemId,
              toolName,
              toolType,
              functionName: toolName,
              toolArgsText: isStart ? command : "",
              toolResultText: isComplete ? output : "",
              hasError,
              parentEventId,
              tocLabel: isStart ? `Tool: ${toolName}` : `Result: ${toolName}`,
              searchChunks: [rawType, itemType, command, output, toolName, toolType, itemId],
              raw: value,
            },
            row.offset,
          );
          if (isStart) rememberToolType(itemId, toolType);
          continue;
        }

        const preview = normalizePreview(rawType);
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "meta",
            rawType,
            role: "system",
            preview,
            parentEventId,
            tocLabel: preview,
            searchChunks: [rawType, itemType],
            raw: value,
          },
          row.offset,
        );
        continue;
      }

      const preview = normalizePreview(rawType || "event");
      pushEvent(
        {
          timestampMs,
          sessionId,
          eventKind: "meta",
          rawType,
          role: "system",
          preview,
          parentEventId,
          tocLabel: preview,
          raw: value,
        },
        row.offset,
      );
    }

    return {
      agent: "codex",
      parser: this.name,
      sessionId,
      events,
      parseError: "",
    };
  }
}
