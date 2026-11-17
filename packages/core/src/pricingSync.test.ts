import { describe, expect, it } from "vitest";
import { buildPricingCatalog, keepRetiredModels } from "./pricingSync.js";

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

  it("prices 1h cache writes for every Claude model at 2x base input", () => {
    const catalog = buildPricingCatalog({
      anthropic: {
        models: {
          "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } },
          "claude-fable-5-1": { cost: { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 } },
        },
      },
      openai: { models: { "gpt-6.1-sol": { cost: { input: 2, output: 10, cache_read: 0.1 } } } },
    });
    const rate = (model: string) => catalog.modelRates.find((entry) => entry.model === model);

    expect(rate("claude-opus-5-5")).toMatchObject({ cachedCreate5mPer1MUsd: 5, cachedCreate1hPer1MUsd: 8 });
    expect(rate("anthropic/claude-opus-5-5")?.cachedCreate1hPer1MUsd).toBe(8);
    expect(rate("claude-fable-5-1")?.cachedCreate1hPer1MUsd).toBe(20);
    expect(rate("gpt-6.1-sol")?.cachedCreate1hPer1MUsd).toBeUndefined();
  });

  it("includes the 1M context of Claude 4.6 at standard rates", () => {
    const catalog = buildPricingCatalog({
      anthropic: { models: { "claude-opus-4-6": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } } } },
    });

    expect(catalog.modelRates.find((rate) => rate.model === "claude-opus-4.6")?.longContextThresholdTokens).toBeUndefined();
  });

  it("prices Haiku 5.5 prompts over 100K tokens at its higher tier", () => {
    const catalog = buildPricingCatalog({
      anthropic: { models: { "claude-haiku-5-5": { cost: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 } } } },
    });

    expect(catalog.modelRates.find((rate) => rate.model === "claude-haiku-5-5")).toMatchObject({
      cachedCreate1hPer1MUsd: 0.2,
      longContextThresholdTokens: 100_000,
      longContextInputPer1MUsd: 0.5,
      longContextOutputPer1MUsd: 2.5,
      longContextCachedReadPer1MUsd: 0.05,
      longContextCachedCreate1hPer1MUsd: 1,
    });
  });

  it("keeps the last known rate of models a newer catalog drops", () => {
    const previous = buildPricingCatalog({ openai: { models: {
      "gpt-5.2-codex": { cost: { input: 1.75, output: 14 }, limit: { context: 400_000 } },
      "gpt-6.1-sol": { cost: { input: 9, output: 9 } },
    } } });
    const fetched = buildPricingCatalog({ openai: { models: { "gpt-6.1-sol": { cost: { input: 2, output: 10 } } } } });
    const merged = keepRetiredModels(fetched, previous);

    expect(merged.modelRates.find((rate) => rate.model === "gpt-5.2-codex")?.inputPer1MUsd).toBe(1.75);
    expect(merged.modelRates.find((rate) => rate.model === "gpt-6.1-sol")?.inputPer1MUsd).toBe(2);
    expect(merged.contextWindows.some((entry) => entry.model === "gpt-5.2-codex")).toBe(true);
  });
});
