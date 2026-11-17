import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@agentlens/contracts";
import { mergeConfig } from "./config.js";
import { deriveSessionMetrics } from "./metrics.js";
import { serviceTierMultiplier } from "./serviceTier.js";

const BEFORE_MARCH_2027 = Date.parse("2027-02-28T12:00:00Z");
const AFTER_MARCH_2027 = Date.parse("2027-03-01T09:00:00Z");

describe("serviceTierMultiplier", () => {
  it("prices standard and unknown tiers at the standard rate", () => {
    expect(serviceTierMultiplier("", BEFORE_MARCH_2027)).toBe(1);
    expect(serviceTierMultiplier("default", BEFORE_MARCH_2027)).toBe(1);
    expect(serviceTierMultiplier("flex", BEFORE_MARCH_2027)).toBe(1);
  });

  it("prices fast (formerly priority) at twice the standard rate", () => {
    expect(serviceTierMultiplier("fast", BEFORE_MARCH_2027)).toBe(2);
    expect(serviceTierMultiplier("Priority", BEFORE_MARCH_2027)).toBe(2);
  });

  it("prices ultrafast at 3x until March 2027 (Pacific) and 6x from then on", () => {
    expect(serviceTierMultiplier("ultrafast", BEFORE_MARCH_2027)).toBe(3);
    expect(serviceTierMultiplier("ultrafast", Date.parse("2027-03-01T07:59:00Z"))).toBe(3);
    expect(serviceTierMultiplier("ultrafast", AFTER_MARCH_2027)).toBe(6);
    expect(serviceTierMultiplier("ultrafast", null)).toBe(3);
  });
});

function codexEvent(index: number, raw: Record<string, unknown>): NormalizedEvent {
  return { eventId: `e${index}`, index, timestampMs: BEFORE_MARCH_2027 + index, raw } as unknown as NormalizedEvent;
}

function tokenCount(index: number, inputTokens: number): NormalizedEvent {
  const usage = { input_tokens: inputTokens, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: inputTokens };
  return codexEvent(index, { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } });
}

function threadSettings(index: number, serviceTier: string | null): NormalizedEvent {
  return codexEvent(index, {
    type: "event_msg",
    payload: { type: "thread_settings_applied", thread_settings: { model: "tier-model", service_tier: serviceTier } },
  });
}

describe("codex session cost with service tiers", () => {
  const config = mergeConfig({
    sessionLogDirectories: [],
    cost: {
      enabled: true,
      currency: "USD",
      unknownModelPolicy: "n_a",
      modelRates: [
        { model: "tier-model", inputPer1MUsd: 1, outputPer1MUsd: 0, cachedReadPer1MUsd: 0, cachedCreatePer1MUsd: 0, reasoningOutputPer1MUsd: 0 },
      ],
    },
  });
  const turnContext = codexEvent(0, { type: "turn_context", payload: { model: "tier-model" } });

  it("multiplies each usage row by the tier active when it was recorded", () => {
    const metrics = deriveSessionMetrics(
      [turnContext, threadSettings(1, "ultrafast"), tokenCount(2, 1_000_000), threadSettings(3, "fast"), tokenCount(4, 2_000_000)],
      "codex",
      config,
    );
    expect(metrics.costEstimateUsd).toBe(3 + 4);
    expect(metrics.usagePoints.map((point) => point.costUsd)).toEqual([3, 4]);
  });

  it("returns to the standard rate when the tier is cleared", () => {
    const metrics = deriveSessionMetrics(
      [turnContext, threadSettings(1, "fast"), threadSettings(2, null), tokenCount(3, 1_000_000)],
      "codex",
      config,
    );
    expect(metrics.costEstimateUsd).toBe(1);
  });
});
