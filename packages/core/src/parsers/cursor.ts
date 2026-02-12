import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asArray, asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { extractTextBlocks, guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

export class CursorParser implements TraceParser {
  name = "cursor";
  agent = "cursor" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.cursor/")) confidence += 0.3;
    if (head.includes('"type":"tool_call"') || head.includes('"type": "tool_call"')) confidence += 0.2;
    if (head.includes('"type":"thinking"') || head.includes('"type": "thinking"')) confidence += 0.15;
    if (head.includes('"session_id"')) confidence += 0.15;
    if (head.includes('"call_id"')) confidence += 0.1;

    return Math.min(confidence, 1);
  }

  parse(file: DiscoveredTraceFile, text: string): ParseOutput {
    const rows = parseJsonLines(text);
    const events = [];
    let sessionId = "";

    for (let idx = 0; idx < rows.length; idx += 1) {
      const row = rows[idx];
      if (!row) continue;

      const value = row.value;
      const rawType = asString(value.type).toLowerCase();
      const subtype = asString(value.subtype).toLowerCase();
      const timestampMs = guessTimestamp(value);
      sessionId ||= asString(value.session_id || value.sessionId);

      if (rawType === "assistant" || rawType === "user") {
        const message = asRecord(value.message);
        const textBlocks = extractTextBlocks(message.content);
        const preview = normalizePreview(textBlocks[0] || rawType);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: rawType,
            rawType,
            role: rawType,
            preview,
            textBlocks,
            searchChunks: [rawType, ...textBlocks],
            raw: value,
          }),
        );
        continue;
      }

      if (rawType === "thinking") {
        const chunk = asString(value.text);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: "reasoning",
            rawType,
            role: "assistant",
            preview: normalizePreview(chunk || "thinking"),
            textBlocks: chunk ? [chunk] : [],
            searchChunks: [rawType, subtype, chunk],
            raw: value,
          }),
        );
        continue;
      }

      if (rawType === "tool_call") {
        const callId = asString(value.call_id);
        const toolCall = asRecord(value.tool_call);
        const toolEntry = asRecord(Object.values(toolCall)[0]);
        const toolName = asString(Object.keys(toolCall)[0] || "tool").replace(/ToolCall$/i, "") || "tool";
        const args = compactText(toolEntry.args);
        const result = compactText(toolEntry.result);

        if (subtype === "started") {
          events.push(
            makeEvent({
              traceId: file.id,
              index: idx + 1,
              offset: row.offset,
              timestampMs,
              sessionId,
              eventKind: "tool_use",
              rawType,
              role: "assistant",
              preview: normalizePreview(`${toolName} start ${args}`.trim()),
              textBlocks: args ? [args] : [],
              toolUseId: callId,
              toolCallId: callId,
              toolName,
              functionName: toolName,
              toolArgsText: args,
              tocLabel: `Tool: ${toolName}`,
              searchChunks: [rawType, subtype, toolName, args],
              raw: value,
            }),
          );
        } else {
          const hasError = result.toLowerCase().includes("error") || result.toLowerCase().includes("failed");
          events.push(
            makeEvent({
              traceId: file.id,
              index: idx + 1,
              offset: row.offset,
              timestampMs,
              sessionId,
              eventKind: "tool_result",
              rawType,
              role: "assistant",
              preview: normalizePreview(`${toolName} done ${result}`.trim()),
              textBlocks: result ? [result] : [],
              toolUseId: callId,
              toolCallId: callId,
              toolName,
              functionName: toolName,
              toolResultText: result,
              hasError,
              tocLabel: `Result: ${toolName}`,
              searchChunks: [rawType, subtype, toolName, result],
              raw: value,
            }),
          );
        }
        continue;
      }

      if (rawType === "system") {
        const model = asString(value.model);
        const cwd = asString(value.cwd);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: "system",
            rawType,
            role: "system",
            preview: normalizePreview(`${subtype} ${model}`.trim() || "system"),
            textBlocks: [cwd].filter(Boolean),
            raw: value,
          }),
        );
        continue;
      }

      if (rawType === "result") {
        const resultText = asString(value.result);
        const isError = Boolean(value.is_error);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: isError ? "meta" : "assistant",
            rawType,
            role: "assistant",
            preview: normalizePreview(resultText || subtype || "result"),
            textBlocks: resultText ? [resultText] : [],
            hasError: isError,
            raw: value,
          }),
        );
        continue;
      }

      if (!rawType && asString(value.prompt)) {
        const prompt = asString(value.prompt);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: "user",
            rawType: "prompt",
            role: "user",
            preview: normalizePreview(prompt),
            textBlocks: [prompt],
            raw: value,
          }),
        );
        continue;
      }

      const blocks = extractTextBlocks(value.message);
      events.push(
        makeEvent({
          traceId: file.id,
          index: idx + 1,
          offset: row.offset,
          timestampMs,
          sessionId,
          eventKind: "meta",
          rawType: rawType || "meta",
          role: "system",
          preview: normalizePreview(rawType || "meta"),
          textBlocks: blocks,
          raw: value,
        }),
      );
    }

    return {
      agent: "cursor",
      parser: this.name,
      sessionId,
      events,
      parseError: "",
    };
  }
}
