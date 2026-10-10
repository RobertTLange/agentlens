import { describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import { attachEventTokenUsage, deriveSessionMetrics } from "./metrics.js";
import { makeEvent } from "./parsers/common.js";
import { redactEvents } from "./redaction.js";

describe("event token usage", () => {
  it("uses cumulative differences when last-response usage is absent and does not mislabel an initial cumulative total", () => {
    const events = [100, 100, 150].map((total, index) => makeEvent({ traceId: "trace", index, offset: index, timestampMs: 1000 + index, eventKind: "meta", rawType: "event_msg", raw: {
      type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: total - 20, output_tokens: 20, total_tokens: total } } },
    } }));
    const points = deriveSessionMetrics(events, "codex", mergeConfig()).usagePoints;
    const measured = attachEventTokenUsage(events, points);
    expect(measured.map(event => event.consumedTokens)).toEqual([undefined, undefined, 50]);
    expect(measured[2]?.modelUsage).toMatchObject({ inputTokens: 50, outputTokens: 0, costUsd: null });
  });

  it("leaves tool text and encrypted reasoning without estimated token consumption", () => {
    const tool = makeEvent({ traceId: "trace", index: 1, offset: 1, eventKind: "tool_result", rawType: "function_call_output", textBlocks: ["truncated"], raw: { payload: { output: "x".repeat(1200) } } });
    const measured = attachEventTokenUsage([tool], [])[0];
    expect(measured).toEqual(tool);
    expect(measured?.consumedTokens).toBeUndefined();
    const reasoning = makeEvent({ traceId: "trace", index: 2, offset: 2, eventKind: "reasoning", rawType: "reasoning", textBlocks: ["[]"], raw: { payload: { encrypted_content: "hidden" } } });
    expect(attachEventTokenUsage([reasoning], [])[0]?.modelUsage).toBeUndefined();
  });

  it("exposes last-response usage as its own visible model-call checkpoint", () => {
    const events = [
      makeEvent({ traceId: "trace", index: 1, offset: 1, timestampMs: 1000, eventKind: "user", rawType: "message" }),
      makeEvent({ traceId: "trace", index: 2, offset: 2, timestampMs: 2000, eventKind: "meta", rawType: "event_msg", raw: {
        type: "event_msg", payload: { type: "token_count", info: {
          total_token_usage: { total_tokens: 10000 }, last_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        } },
      } }),
    ];
    const points = deriveSessionMetrics(events, "codex", mergeConfig()).usagePoints;
    expect(points[0]?.eventId).toBe(events[1]?.eventId);
    expect(attachEventTokenUsage(events, points)[0]?.consumedTokens).toBeUndefined();
    expect(attachEventTokenUsage(events, points)[1]?.consumedTokens).toBe(120);
    expect(attachEventTokenUsage(events, points)[1]?.eventKind).toBe("system");
    expect(attachEventTokenUsage(events, points)[1]?.modelUsage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: null });
    expect(attachEventTokenUsage(redactEvents(events, mergeConfig().redaction), points)[1]?.modelUsage?.totalTokens).toBe(120);
    expect(events[0]?.consumedTokens).toBeUndefined();
    const repeated = { ...events[1]!, eventId: "repeated", index: 3, raw: structuredClone(events[1]!.raw) };
    const repeatedEvents = [...events, repeated];
    const repeatedPoints = deriveSessionMetrics(repeatedEvents, "codex", mergeConfig()).usagePoints;
    expect(attachEventTokenUsage(repeatedEvents, repeatedPoints).map(event => event.consumedTokens)).toEqual([undefined, 120, undefined]);
  });

  it("does not duplicate Claude message usage across normalized blocks", () => {
    const raw = { type: "assistant", message: { id: "message-id", model: "model", usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 } } };
    const events = [1, 2].map(index => makeEvent({ traceId: "trace", index, offset: index, timestampMs: 1000, eventKind: "assistant", rawType: "assistant", raw }));
    const points = deriveSessionMetrics(events, "claude", mergeConfig()).usagePoints;
    const measured = attachEventTokenUsage(events, points);
    expect(measured.map(event => event.consumedTokens)).toEqual([170, undefined]);
    expect(measured[0]?.modelUsage).toMatchObject({ inputTokens: 150, cachedInputTokens: 50, outputTokens: 20 });
  });

  it("keeps unavailable token usage unknown and does not assign orphan metadata to another trace", () => {
    const event = makeEvent({ traceId: "trace", index: 1, offset: 1, eventKind: "meta", rawType: "event_msg" });
    expect(attachEventTokenUsage([event], [])[0]?.consumedTokens).toBeUndefined();
  });
});
