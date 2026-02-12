import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { eventKindFromRole, extractTextBlocks, guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

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
    let sessionId = "";
    let eventIndex = 1;

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];
      if (!row) continue;

      const value = row.value;
      const rawType = asString(value.type);
      const timestampMs = guessTimestamp(value);
      const parentEventId = asString(value.parent_id || value.parentId || value.parent_event_id);
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
              const toolArgsText = compactText(item.arguments || item.input || item.params || payload.arguments || payload.input);
              const preview = normalizePreview(toolArgsText ? `${resolvedToolName}: ${toolArgsText}` : `tool ${resolvedToolName}`);

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
                  functionName: resolvedToolName,
                  toolArgsText,
                  parentEventId,
                  tocLabel: `Tool: ${resolvedToolName}`,
                  searchChunks: [rawType, payloadType, itemType, resolvedToolName, toolCallId, toolArgsText],
                  raw: value,
                },
                itemOffset,
              );
              continue;
            }

            if (itemType === "tool_result" || itemType === "function_call_output") {
              const toolCallId = asString(item.tool_use_id || item.call_id || item.id || callId);
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
                  toolName: asString(item.name || toolName),
                  toolResultText: resultText,
                  hasError,
                  parentEventId,
                  tocLabel: `Result: ${toolCallId || "tool"}`,
                  searchChunks: [rawType, payloadType, itemType, role, toolCallId, resultText],
                  raw: value,
                },
                itemOffset,
              );
              continue;
            }

            if (itemType === "thinking" || itemType === "reasoning") {
              const reasoningText = compactText(item.text || item.content || payload.summary);
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
          const toolArgsText = compactText(payload.arguments || payload.input || payload.params);
          const preview = normalizePreview(toolArgsText ? `${resolvedToolName}: ${toolArgsText}` : `tool ${resolvedToolName}`);
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
              functionName: resolvedToolName,
              toolArgsText,
              parentEventId,
              tocLabel: `Tool: ${resolvedToolName}`,
              searchChunks: [rawType, payloadType, resolvedToolName, toolCallId, toolArgsText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "function_call_output" || payloadType === "tool_result") {
          const toolCallId = callId || asString(payload.tool_use_id);
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
              toolResultText: resultText,
              hasError,
              parentEventId,
              tocLabel: `Result: ${toolCallId || "tool"}`,
              searchChunks: [rawType, payloadType, toolCallId, resultText],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        if (payloadType === "reasoning" || payloadType === "thinking") {
          const reasoningText = compactText(payload.summary || payload.text || payload.content);
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
              functionName: toolName,
              toolArgsText: isStart ? command : "",
              toolResultText: isComplete ? output : "",
              hasError,
              parentEventId,
              tocLabel: isStart ? `Tool: ${toolName}` : `Result: ${toolName}`,
              searchChunks: [rawType, itemType, command, output, toolName, itemId],
              raw: value,
            },
            row.offset,
          );
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
