import { describe, expect, it } from "vitest";
import { buildPricingCatalog } from "./pricingSync.js";

describe("pricingSync", () => {
  it("builds canonical and provider-qualified pricing rows from models.dev payloads", () => {
    const catalog = buildPricingCatalog({
      openai: {
        models: {
          "gpt-5.4": {
            cost: {
              input: 2.5,
              output: 15,
              cache_read: 0.25,
              context_over_200k: {
                input: 5,
                output: 22.5,
                cache_read: 0.5,
              },
            },
            limit: { context: 1_050_000 },
          },
        },
      },
      anthropic: {
        models: {
          "claude-sonnet-4-6": {
            cost: {
              input: 3,
              output: 15,
              cache_read: 0.3,
              cache_write: 3.75,
            },
            limit: { context: 1_000_000 },
          },
        },
      },
      openrouter: {
        models: {
          "gpt-5.4": {
            cost: { input: 99, output: 199 },
            limit: { context: 1 },
          },
        },
      },
    });

    const gpt54 = catalog.modelRates.find((rate) => rate.model === "gpt-5.4");
    const openAiGpt54 = catalog.modelRates.find((rate) => rate.model === "openai/gpt-5.4");
    const claudeSonnet = catalog.modelRates.find((rate) => rate.model === "claude-sonnet-4.6");

    expect(gpt54?.inputPer1MUsd).toBe(2.5);
    expect(gpt54?.longContextThresholdTokens).toBe(200_000);
    expect(openAiGpt54?.outputPer1MUsd).toBe(15);
    expect(catalog.modelRates.some((rate) => rate.model === "openrouter/gpt-5.4")).toBe(false);
    expect(claudeSonnet?.cachedCreate5mPer1MUsd).toBe(3.75);
    expect(claudeSonnet?.cachedCreate1hPer1MUsd).toBe(6);
    expect(catalog.contextWindows.find((entry) => entry.model === "claude-sonnet-4.6")?.contextWindowTokens).toBe(
      1_000_000,
    );
  });
});
