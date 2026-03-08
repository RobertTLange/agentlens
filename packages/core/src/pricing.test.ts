import { describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import { estimateUsageCost, normalizePricingModelId } from "./pricing.js";

describe("pricing", () => {
  it("normalizes observed Anthropic and OpenAI model ids to canonical pricing keys", () => {
    expect(normalizePricingModelId("global.anthropic.claude-opus-4-6-v1")).toBe("claude-opus-4.6");
    expect(normalizePricingModelId("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4.5");
    expect(normalizePricingModelId("claude-sonnet-4-6-20260219")).toBe("claude-sonnet-4.6");
    expect(normalizePricingModelId("openai/gpt-5.4-2026-02-28")).toBe("gpt-5.4");
    expect(normalizePricingModelId("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("uses Anthropic split cache write pricing and long-context premiums", () => {
    const config = mergeConfig({
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "claude-sonnet-4.6",
            inputPer1MUsd: 3,
            outputPer1MUsd: 15,
            cachedReadPer1MUsd: 0.3,
            cachedCreatePer1MUsd: 3.75,
            cachedCreate5mPer1MUsd: 3.75,
            cachedCreate1hPer1MUsd: 6,
            reasoningOutputPer1MUsd: 0,
            longContextThresholdTokens: 200_000,
            longContextInputPer1MUsd: 6,
            longContextOutputPer1MUsd: 22.5,
            longContextCachedReadPer1MUsd: 0.6,
            longContextCachedCreatePer1MUsd: 7.5,
            longContextCachedCreate5mPer1MUsd: 7.5,
            longContextCachedCreate1hPer1MUsd: 12,
            contextWindowTokens: 1_000_000,
          },
        ],
      },
    });

    const baseCost = estimateUsageCost(
      {
        model: "claude-sonnet-4-6-20260219",
        promptTokens: 150_000,
        inputTokens: 100_000,
        cachedReadTokens: 20_000,
        cachedCreateTokens: 10_000,
        cachedCreate5mTokens: 8_000,
        cachedCreate1hTokens: 2_000,
        outputTokens: 50_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    const longCost = estimateUsageCost(
      {
        model: "claude-sonnet-4-6-20260219",
        promptTokens: 250_000,
        inputTokens: 100_000,
        cachedReadTokens: 20_000,
        cachedCreateTokens: 10_000,
        cachedCreate5mTokens: 8_000,
        cachedCreate1hTokens: 2_000,
        outputTokens: 50_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    expect(baseCost).toBe(1.098);
    expect(longCost).toBe(1.821);
  });

  it("applies GPT-5.4 premium pricing only above the long-context threshold", () => {
    const config = mergeConfig({
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.4",
            inputPer1MUsd: 1.25,
            outputPer1MUsd: 7.5,
            cachedReadPer1MUsd: 0.125,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
            longContextThresholdTokens: 272_000,
            longContextInputPer1MUsd: 2.5,
            longContextOutputPer1MUsd: 11.25,
            contextWindowTokens: 1_050_000,
          },
        ],
      },
    });

    const shortCost = estimateUsageCost(
      {
        model: "gpt-5.4-2026-02-28",
        promptTokens: 200_000,
        inputTokens: 180_000,
        cachedReadTokens: 20_000,
        cachedCreateTokens: 0,
        outputTokens: 40_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );
    const longCost = estimateUsageCost(
      {
        model: "gpt-5.4-2026-02-28",
        promptTokens: 300_000,
        inputTokens: 180_000,
        cachedReadTokens: 20_000,
        cachedCreateTokens: 0,
        outputTokens: 40_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    expect(shortCost).toBe(0.5275);
    expect(longCost).toBe(0.9025);
  });
});
