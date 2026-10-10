import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@agentlens/contracts";
import { buildAgentLoopTree, buildTraceTree, traceTreeMeasurements, traceGroupUsage } from "./trace-tree-model.js";

function event(eventId: string, index: number, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId, index, traceId: "trace", offset: index, timestampMs: 1000,
    sessionId: "session", eventKind: "assistant", rawType: "message", role: "assistant",
    preview: eventId, textBlocks: [], toolUseId: "", parentToolUseId: "", toolName: "",
    toolType: "", toolCallId: "", functionName: "", toolArgsText: "",
    toolResultText: "", parentEventId: "", tocLabel: "", hasError: false, searchText: "", raw: {},
    ...overrides,
  };
}

describe("trace tree", () => {
  it("groups Codex steps around separate usage checkpoints without counting usage twice", () => {
    const modelUsage = { agent: "codex" as const, model: "model", inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, totalTokens: 120, costUsd: null };
    const rows = [
      event("user", 1, { eventKind: "user" }),
      event("call", 2, { eventKind: "tool_use", toolCallId: "id" }),
      event("output", 3, { eventKind: "tool_result", toolCallId: "id" }),
      event("usage-one", 4, { eventKind: "system", modelUsage, consumedTokens: 120 }),
      event("answer", 5),
      event("usage-two", 6, { eventKind: "system", modelUsage, consumedTokens: 120 }),
      event("unmeasured", 7),
    ];
    const tree = buildAgentLoopTree(rows);
    expect(tree[0]?.children.map(node => [node.event.eventId, node.loopNumber])).toEqual([["usage-one", 1], ["usage-two", 2], ["unmeasured", undefined]]);
    expect(tree[0]?.children[0]?.children[0]?.children[0]?.event.eventId).toBe("output");
    expect(tree[0]?.children[1]?.children[0]?.event.eventId).toBe("answer");
    expect(traceTreeMeasurements(tree).get("user")?.tokens).toBe(240);
    const partial = buildAgentLoopTree(rows.slice(1));
    expect(partial[0]?.loopNumber).toBe(1);
    expect(partial[0]?.children[0]?.event.eventId).toBe("call");
  });

  it("sums each recorded call once and keeps incomplete group cost unavailable", () => {
    const usage = { agent: "codex" as const, model: "model", inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, totalTokens: 120, costUsd: 0.02 };
    const tree = buildAgentLoopTree([
      event("user", 1, { eventKind: "user" }),
      event("call-one", 2, { modelUsage: usage }),
      event("call-two", 3, { modelUsage: { ...usage, inputTokens: 300, costUsd: 0.06 } }),
    ]);
    expect(traceGroupUsage(tree[0]!)).toEqual({ inputTokens: 400, outputTokens: 40, cachedInputTokens: 160, costUsd: 0.08 });
    tree[0]!.children[1]!.event.modelUsage!.costUsd = null;
    expect(traceGroupUsage(tree[0]!).costUsd).toBeNull();
  });

  it("keeps response-attached usage with following operations for other providers", () => {
    const modelUsage = { agent: "claude" as const, model: "model", inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, totalTokens: 120, costUsd: null };
    const tree = buildAgentLoopTree([
      event("user", 1, { eventKind: "user" }), event("response", 2, { modelUsage, consumedTokens: 120 }),
      event("call", 3, { eventKind: "tool_use", toolCallId: "id" }), event("output", 4, { eventKind: "tool_result", toolCallId: "id" }),
    ]);
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.loopNumber).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.event.eventId).toBe("call");
  });

  it("uses the next event gap only when a linked duration is unavailable", () => {
    const rows = [
      event("instruction", 1, { eventKind: "system", timestampMs: 1000 }),
      event("reasoning", 2, { eventKind: "reasoning", timestampMs: 2250 }),
      event("call", 3, { eventKind: "tool_use", toolCallId: "id", timestampMs: 2250 }),
      event("middle", 4, { timestampMs: 3000 }),
      event("output", 5, { eventKind: "tool_result", toolCallId: "id", timestampMs: 4250 }),
      event("last", 6, { timestampMs: 5000 }),
    ];
    const measured = traceTreeMeasurements(buildTraceTree(rows));
    expect(measured.get("instruction")).toEqual({ durationSeconds: 1.25, durationEstimated: true, tokens: null });
    expect(measured.get("reasoning")).toEqual({ durationSeconds: 0, durationEstimated: true, tokens: null });
    expect(measured.get("call")?.durationSeconds).toBe(2);
    expect(measured.get("call")?.durationEstimated).toBeUndefined();
    expect(measured.get("last")?.durationSeconds).toBeNull();
  });

  it("does not estimate across missing timestamps, backward times, or different traces", () => {
    const rows = [
      event("missing-next", 1, { timestampMs: 1000 }),
      event("missing", 2, { timestampMs: null }),
      event("backward", 3, { timestampMs: 4000 }),
      event("last", 4, { timestampMs: 3000 }),
      event("other", 5, { traceId: "other", timestampMs: 5000 }),
    ];
    const measured = traceTreeMeasurements(buildTraceTree(rows));
    for (const row of rows) expect(measured.get(row.eventId)?.durationSeconds).toBeNull();
  });

  it("measures branch elapsed seconds and recorded tokens without treating unavailable leaves as zero", () => {
    const user = event("user", 1, { eventKind: "user", timestampMs: 1000, consumedTokens: 100 });
    const call = event("call", 2, { eventKind: "tool_use", timestampMs: 2000, toolCallId: "id" });
    const output = event("output", 3, { eventKind: "tool_result", timestampMs: 3500, toolCallId: "id" });
    const reply = event("reply", 4, { timestampMs: 5000, consumedTokens: 20 });
    const measurements = traceTreeMeasurements(buildTraceTree([user, call, output, reply]));
    expect(measurements.get("user")).toEqual({ durationSeconds: 4, tokens: 120 });
    expect(measurements.get("call")).toEqual({ durationSeconds: 1.5, tokens: null });
    expect(measurements.get("output")).toEqual({ durationSeconds: 1.5, tokens: null });
    expect(measurements.get("reply")).toEqual({ durationSeconds: null, tokens: 20 });
    expect(traceTreeMeasurements(buildTraceTree([event("zero", 1, { timestampMs: null, consumedTokens: 0 })])).get("zero")).toEqual({ durationSeconds: null, tokens: 0 });
  });

  it("groups chronological user turns and nests tool results under their unique calls", () => {
    const user = event("user", 1, { eventKind: "user" });
    const call = event("call", 2, { eventKind: "tool_use", toolCallId: "id" });
    const result = event("result", 3, { eventKind: "tool_result", toolCallId: "id" });
    const next = event("next", 4, { eventKind: "user" });
    expect(buildTraceTree([next, result, call, user])).toEqual([
      { event: user, children: [{ event: call, children: [{ event: result, children: [] }] }] },
      { event: next, children: [] },
    ]);
  });

  it("prefers recorded event and tool parents over user-turn grouping", () => {
    const call = event("call", 1, { eventKind: "tool_use", toolUseId: "tool" });
    const user = event("user", 2, { eventKind: "user" });
    const child = event("child", 3, { parentEventId: "call" });
    const nested = event("nested", 4, { parentToolUseId: "tool" });
    expect(buildTraceTree([call, user, child, nested])[0]?.children.map(node => node.event.eventId)).toEqual(["child", "nested"]);
  });

  it("keeps missing, forward, self, and cross-trace parents safe and preserves all events", () => {
    const rows = [
      event("user", 1, { eventKind: "user" }),
      event("missing", 2, { parentEventId: "absent" }),
      event("forward", 3, { parentEventId: "self" }),
      event("self", 4, { parentEventId: "self" }),
      event("other", 5, { traceId: "other", parentEventId: "user" }),
    ];
    expect(buildTraceTree(rows).map(node => node.event.eventId)).toEqual(rows.map(row => row.eventId));
  });

  it("does not attach ambiguous tool IDs to an arbitrary call", () => {
    const rows = [
      event("call-a", 1, { eventKind: "tool_use", toolCallId: "id" }),
      event("call-b", 2, { eventKind: "tool_use", toolCallId: "id" }),
      event("result", 3, { eventKind: "tool_result", toolCallId: "id" }),
      event("child", 4, { parentToolUseId: "id" }),
    ];
    expect(buildTraceTree(rows)).toHaveLength(4);
    expect(buildTraceTree([])).toEqual([]);
  });
});
