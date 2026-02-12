import type { ParseOutput, TraceParser } from "./types.js";
import type { DiscoveredTraceFile } from "../discovery.js";
import { asRecord, asString, compactText, normalizePreview } from "../utils.js";
import { guessTimestamp, makeEvent, parseJsonLines } from "./common.js";

export class OpenCodeParser implements TraceParser {
  name = "opencode";
  agent = "opencode" as const;

  canParse(file: DiscoveredTraceFile, headText: string): number {
    let confidence = 0;
    const filePath = file.path.toLowerCase();
    const head = headText.toLowerCase();

    if (filePath.includes("/.opencode/")) confidence += 0.35;
    if (head.includes('"type":"step_start"') || head.includes('"type": "step_start"')) confidence += 0.2;
    if (head.includes('"type":"tool_use"') || head.includes('"type": "tool_use"')) confidence += 0.2;
    if (head.includes('"sessionid"')) confidence += 0.15;

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
      const rawType = asString(value.type);
      const timestampMs = guessTimestamp(value);
      sessionId ||= asString(value.sessionID || value.sessionId);

      if (rawType === "step_start") {
        const part = asRecord(value.part);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: "assistant",
            rawType,
            role: "assistant",
            preview: normalizePreview(`turn start: ${asString(part.messageID) || "step"}`),
            textBlocks: [asString(part.snapshot)].filter(Boolean),
            raw: value,
          }),
        );
        continue;
      }

      if (rawType === "step_finish") {
        const part = asRecord(value.part);
        const reason = asString(part.reason);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: "assistant",
            rawType,
            role: "assistant",
            preview: normalizePreview(`turn finish: ${reason || "complete"}`),
            textBlocks: [asString(part.tokens), asString(part.cost)].filter(Boolean),
            raw: value,
          }),
        );
        continue;
      }

      if (rawType === "text") {
        const part = asRecord(value.part);
        const textValue = asString(part.text);
        events.push(
          makeEvent({
            traceId: file.id,
            index: idx + 1,
            offset: row.offset,
            timestampMs,
            sessionId,
            eventKind: "assistant",
            rawType,
            role: "assistant",
            preview: normalizePreview(textValue || "text"),
            textBlocks: textValue ? [textValue] : [],
            raw: value,
          }),
        );
        continue;
      }

      if (rawType === "tool_use") {
        const part = asRecord(value.part);
        const state = asRecord(part.state);
        const status = asString(state.status).toLowerCase();
        const toolName = asString(part.tool) || "tool";
        const callId = asString(part.callID);
        const output = compactText(state.output);
        const metadata = asRecord(state.metadata);
        const hasError = Number(metadata.exit) !== 0 && metadata.exit !== undefined;

        if (status === "completed") {
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
              preview: normalizePreview(`${toolName} done ${output}`.trim()),
              textBlocks: output ? [output] : [],
              toolUseId: callId,
              toolCallId: callId,
              toolName,
              functionName: toolName,
              toolResultText: output,
              hasError,
              tocLabel: `Result: ${toolName}`,
              raw: value,
            }),
          );
        } else {
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
              preview: normalizePreview(`${toolName} ${status || "running"}`),
              textBlocks: [compactText(state.input)].filter(Boolean),
              toolUseId: callId,
              toolCallId: callId,
              toolName,
              functionName: toolName,
              toolArgsText: compactText(state.input),
              tocLabel: `Tool: ${toolName}`,
              raw: value,
            }),
          );
        }
        continue;
      }

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
          raw: value,
        }),
      );
    }

    return {
      agent: "opencode",
      parser: this.name,
      sessionId,
      events,
      parseError: "",
    };
  }
}
