import { describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import { estimateUsageCost, normalizePricingModelId } from "./pricing.js";

describe("pricing", () => {
  it("normalizes observed Anthropic, OpenAI, and Gemini model ids to canonical pricing keys", () => {
    expect(normalizePricingModelId("global.anthropic.claude-opus-4-6-v1")).toBe("claude-opus-4.6");
    expect(normalizePricingModelId("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("claude-haiku-4.5");
    expect(normalizePricingModelId("claude-sonnet-4-6-20260219")).toBe("claude-sonnet-4.6");
    expect(normalizePricingModelId("openai/gpt-5.4-2026-02-28")).toBe("gpt-5.4");
    expect(normalizePricingModelId("google/gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
    expect(normalizePricingModelId("models/gemini-3.1-pro-preview")).toBe("gemini-3.1-pro-preview");
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
            inputPer1MUsd: 2.5,
            outputPer1MUsd: 15,
            cachedReadPer1MUsd: 0.25,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
            longContextThresholdTokens: 200_000,
            longContextInputPer1MUsd: 5,
            longContextOutputPer1MUsd: 22.5,
            longContextCachedReadPer1MUsd: 0.5,
            contextWindowTokens: 1_050_000,
          },
        ],
      },
    });

    const shortCost = estimateUsageCost(
      {
        model: "gpt-5.4-2026-02-28",
        promptTokens: 180_000,
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

    expect(shortCost).toBe(1.055);
    expect(longCost).toBe(1.81);
  });

  it("prefers provider-qualified pricing when a raw model id has a more specific override", () => {
    const config = mergeConfig({
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.4",
            inputPer1MUsd: 2.5,
            outputPer1MUsd: 15,
            cachedReadPer1MUsd: 0.25,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
          },
          {
            model: "openai/gpt-5.4",
            inputPer1MUsd: 3,
            outputPer1MUsd: 18,
            cachedReadPer1MUsd: 0.3,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
          },
        ],
      },
    });

    const bareCost = estimateUsageCost(
      {
        model: "gpt-5.4",
        promptTokens: 100_000,
        inputTokens: 100_000,
        cachedReadTokens: 0,
        cachedCreateTokens: 0,
        outputTokens: 50_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    const qualifiedCost = estimateUsageCost(
      {
        model: "openai/gpt-5.4",
        promptTokens: 100_000,
        inputTokens: 100_000,
        cachedReadTokens: 0,
        cachedCreateTokens: 0,
        outputTokens: 50_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    expect(bareCost).toBe(1);
    expect(qualifiedCost).toBe(1.2);
  });

  it("matches Gemini pricing for provider-prefixed model ids", () => {
    const config = mergeConfig({
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gemini-3.1-pro-preview",
            inputPer1MUsd: 2,
            outputPer1MUsd: 12,
            cachedReadPer1MUsd: 0.2,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
            longContextThresholdTokens: 200_000,
            longContextInputPer1MUsd: 4,
            longContextOutputPer1MUsd: 18,
            longContextCachedReadPer1MUsd: 0.4,
            contextWindowTokens: 1_048_576,
          },
        ],
      },
    });

    const modelsPrefixedCost = estimateUsageCost(
      {
        model: "models/gemini-3.1-pro-preview",
        promptTokens: 180_000,
        inputTokens: 180_000,
        cachedReadTokens: 20_000,
        cachedCreateTokens: 0,
        outputTokens: 40_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    const googlePrefixedCost = estimateUsageCost(
      {
        model: "google/gemini-3.1-pro-preview",
        promptTokens: 300_000,
        inputTokens: 180_000,
        cachedReadTokens: 20_000,
        cachedCreateTokens: 0,
        outputTokens: 40_000,
        reasoningOutputTokens: 0,
      },
      config.cost,
    );

    expect(modelsPrefixedCost).toBe(0.844);
    expect(googlePrefixedCost).toBe(1.448);
  });
});
