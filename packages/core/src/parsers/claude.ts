import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { eventKindFromRole, extractTextBlocks, guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

export class ClaudeParser implements TraceParser {
  name = "claude";
  agent = "claude" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.claude/")) confidence += 0.3;
    if (filePath.includes("/projects/")) confidence += 0.2;
    if (filePath.endsWith("history.jsonl")) confidence += 0.15;
    if (head.includes('"sessionid"')) confidence += 0.2;
    if (head.includes('"type":"assistant"') || head.includes('"type": "assistant"')) confidence += 0.2;
    if (head.includes('"parentuuid"') || head.includes('"tool_use_result"')) confidence += 0.1;

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
      const rawType = asString(value.type).toLowerCase();
      const timestampMs = guessTimestamp(value);
      const rowSessionId = asString(value.session_id || value.sessionId);
      sessionId ||= rowSessionId;
      const parentEventId = asString(value.parentUuid || value.parent_uuid || value.parent_event_id);

      const pushEvent = (seed: Omit<Parameters<typeof makeEvent>[0], "traceId" | "index" | "offset">, offset: number): void => {
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

      if (rawType === "user" || rawType === "assistant" || rawType === "system") {
        const message = asRecord(value.message);
        const role = asString(message.role || rawType).toLowerCase() || rawType || "assistant";
        const content = asArray(message.content).map((item) => asRecord(item));

        if (content.length === 0) {
          const textBlocks = extractTextBlocks(message.content);
          const preview = textBlocks[0]
            ? normalizePreview(textBlocks[0])
            : normalizePreview(asString(message.id || rawType || role));

          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: eventKindFromRole(role),
              rawType: rawType || "message",
              role,
              preview,
              textBlocks,
              parentToolUseId: asString(value.parent_tool_use_id || value.parentUuid),
              parentEventId,
              tocLabel: preview,
              searchChunks: [rawType, role, asString(message.id), ...textBlocks],
              raw: value,
            },
            row.offset,
          );
          continue;
        }

        for (const [contentIdx, item] of content.entries()) {
          const itemType = asString(item.type).toLowerCase() || rawType || "message";
          const contentOffset = row.offset + contentIdx;
          if (itemType === "tool_use") {
            const toolName = asString(item.name) || asString(item.tool_name) || "tool";
            const toolCallId = asString(item.id || item.call_id || item.tool_use_id);
            const toolArgsText = compactText(item.input || item.arguments || item.params);
            const preview = normalizePreview(toolArgsText ? `${toolName}: ${toolArgsText}` : `tool ${toolName}`);

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
                toolName,
                functionName: toolName,
                toolArgsText,
                parentToolUseId: asString(value.parent_tool_use_id || value.parentUuid),
                parentEventId: asString(value.uuid || parentEventId),
                tocLabel: `Tool: ${toolName}`,
                searchChunks: [rawType, role, itemType, toolName, toolCallId, toolArgsText],
                raw: value,
              },
              contentOffset,
            );
            continue;
          }

          if (itemType === "tool_result") {
            const toolCallId = asString(item.tool_use_id || item.call_id || item.id);
            const textBlocks = extractTextBlocks(item.content);
            const toolResultText = compactText(textBlocks.join("\n") || item.content || item.result || item.output);
            const isError =
              Boolean(item.is_error) ||
              Boolean(item.error) ||
              Boolean(asRecord(value.toolUseResult).stderr) ||
              Boolean(asRecord(value.tool_use_result).stderr);
            const preview = normalizePreview(toolResultText || `tool result ${toolCallId || ""}`.trim());

            pushEvent(
              {
                timestampMs,
                sessionId,
                eventKind: "tool_result",
                rawType: itemType,
                role,
                preview,
                textBlocks: toolResultText ? [toolResultText] : textBlocks,
                toolUseId: toolCallId,
                toolCallId,
                toolResultText,
                hasError: isError,
                parentToolUseId: asString(value.parent_tool_use_id || value.parentUuid),
                parentEventId: asString(value.uuid || parentEventId),
                tocLabel: `Result: ${toolCallId || "tool"}`,
                searchChunks: [rawType, role, itemType, toolCallId, toolResultText],
                raw: value,
              },
              contentOffset,
            );
            continue;
          }

          if (itemType === "thinking") {
            const thinkingText = compactText(item.text || item.content);
            const preview = normalizePreview(thinkingText || "thinking");
            pushEvent(
              {
                timestampMs,
                sessionId,
                eventKind: "reasoning",
                rawType: itemType,
                role: "assistant",
                preview,
                textBlocks: thinkingText ? [thinkingText] : [],
                parentToolUseId: asString(value.parent_tool_use_id || value.parentUuid),
                parentEventId: asString(value.uuid || parentEventId),
                tocLabel: "Thinking",
                searchChunks: [rawType, role, itemType, thinkingText],
                raw: value,
              },
              contentOffset,
            );
            continue;
          }

          const textBlocks = extractTextBlocks([item]);
          const preview = normalizePreview(textBlocks[0] || compactText(item.text || item.content) || itemType || role || rawType);
          pushEvent(
            {
              timestampMs,
              sessionId,
              eventKind: eventKindFromRole(role),
              rawType: itemType,
              role,
              preview,
              textBlocks,
              parentToolUseId: asString(value.parent_tool_use_id || value.parentUuid),
              parentEventId: asString(value.uuid || parentEventId),
              tocLabel: preview,
              searchChunks: [rawType, role, itemType, ...textBlocks],
              raw: value,
            },
            contentOffset,
          );
        }
        continue;
      }

      if (!rawType && asString(value.display)) {
        const display = asString(value.display);
        const project = asString(value.project);
        sessionId ||= project;
        const preview = normalizePreview(display);
        pushEvent(
          {
            timestampMs,
            sessionId,
            eventKind: "user",
            rawType: "history_entry",
            role: "user",
            preview,
            textBlocks: [display],
            tocLabel: preview,
            searchChunks: [display, project],
            raw: value,
          },
          row.offset,
        );
        continue;
      }

      const summaryText =
        compactText(value.summary) ||
        compactText(asRecord(value.message).content) ||
        compactText(value.operation) ||
        compactText(value.status);
      const preview = normalizePreview(summaryText || rawType || "meta");
      pushEvent(
        {
          timestampMs,
          sessionId,
          eventKind: "meta",
          rawType: rawType || "meta",
          role: "system",
          preview,
          textBlocks: summaryText ? [summaryText] : [],
          parentEventId,
          tocLabel: preview,
          searchChunks: [rawType, summaryText],
          raw: value,
        },
        row.offset,
      );
    }

    return {
      agent: "claude",
      parser: this.name,
      sessionId,
      events,
      parseError: "",
    };
  }
}
