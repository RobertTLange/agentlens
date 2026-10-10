import type { NormalizedEvent } from "@agentlens/contracts";

export interface InspectorEventGroup {
  event: NormalizedEvent;
  call?: NormalizedEvent;
  result?: NormalizedEvent;
}

export function groupInspectorEvents(events: NormalizedEvent[]): InspectorEventGroup[] {
  const operations = new Map<string, { calls: NormalizedEvent[]; results: NormalizedEvent[] }>();
  for (const event of events) {
    const id = event.toolCallId || event.toolUseId;
    if (!id || (event.eventKind !== "tool_use" && event.eventKind !== "tool_result")) continue;
    const key = JSON.stringify([event.traceId, id]);
    const operation = operations.get(key) ?? { calls: [], results: [] };
    (event.eventKind === "tool_use" ? operation.calls : operation.results).push(event);
    operations.set(key, operation);
  }
  const pairs = new Map<string, { call: NormalizedEvent; result: NormalizedEvent }>();
  for (const operation of operations.values()) {
    const call = operation.calls[0];
    const result = operation.results[0];
    // Ambiguous IDs stay separate rather than associating the wrong output.
    if (operation.calls.length !== 1 || operation.results.length !== 1 || !call || !result || result.index < call.index) continue;
    pairs.set(call.eventId, { call, result });
    pairs.set(result.eventId, { call, result });
  }
  const seen = new Set<string>();
  return events.flatMap((event) => {
    if (seen.has(event.eventId)) return [];
    const pair = pairs.get(event.eventId);
    if (pair) {
      seen.add(pair.call.eventId);
      seen.add(pair.result.eventId);
      return [{ event, ...pair }];
    }
    return [{ event, ...(event.eventKind === "tool_use" ? { call: event } : event.eventKind === "tool_result" ? { result: event } : {}) }];
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readableValue(value: unknown, depth = 0): string {
  if (value === undefined || value === null) return "";
  if (depth > 8) return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return readableValue(JSON.parse(trimmed), depth + 1); } catch { /* Preserve incomplete or non-JSON output. */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => readableValue(item, depth + 1)).filter(Boolean).join("\n\n");
  const object = record(value);
  if (typeof object.text === "string") return readableValue(object.text, depth + 1);
  if (object.content !== undefined) return readableValue(object.content, depth + 1);
  if (object.output !== undefined) return readableValue(object.output, depth + 1);
  return JSON.stringify(value, null, 2);
}

function readableInput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

export function inspectorEventText(event: NormalizedEvent): string {
  if (event.modelUsage && event.preview === "Model call usage") return JSON.stringify(event.modelUsage, null, 2);
  const payload = record(event.raw.payload);
  const message = record(event.raw.message);
  const content = message.content ?? event.raw.content;
  const callId = event.toolCallId || event.toolUseId;
  const block = Array.isArray(content)
    ? content.find((item) => {
      const entry = record(item);
      return callId && (entry.id === callId || entry.tool_use_id === callId);
    })
    : undefined;
  const tool = record(block);
  const item = record(event.raw.item);
  const state = record(record(event.raw.part).state);
  if (event.eventKind === "tool_use") {
    return readableInput(tool.input ?? tool.arguments ?? payload.arguments ?? payload.input ?? state.input ?? item.command ?? event.toolArgsText);
  }
  if (event.eventKind === "tool_result") {
    return readableValue(tool.content ?? tool.output ?? payload.output ?? payload.result ?? payload.content ?? state.output ?? item.aggregated_output ?? event.toolResultText);
  }
  if (event.eventKind === "reasoning") {
    // Encrypted reasoning is not readable content; only render supplied summaries.
    const text = readableValue(payload.summary ?? event.textBlocks);
    return text && text !== "[]" ? text : "Reasoning text unavailable";
  }
  return readableValue(event.textBlocks.length ? event.textBlocks : payload.content ?? message.content ?? event.raw.content) || event.preview;
}
