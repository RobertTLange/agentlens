import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BUNDLED_PRICING_FETCHED_AT } from "./generatedPricing.js";
import { loadPricedConfig, pricingCachePath, writePricingCache } from "./pricingCache.js";
import { buildPricingCatalog } from "./pricingSync.js";

const AFTER_BUNDLED = new Date(Date.parse(BUNDLED_PRICING_FETCHED_AT) + 86_400_000).toISOString();
const BEFORE_BUNDLED = new Date(Date.parse(BUNDLED_PRICING_FETCHED_AT) - 86_400_000).toISOString();

function catalogWithNewModel(fetchedAt: string) {
  return buildPricingCatalog(
    { anthropic: { models: { "claude-future-9": { cost: { input: 3, output: 15, cache_read: 0.3 }, limit: { context: 1_000_000 } } } } },
    fetchedAt,
  );
}

async function runtime(configToml = "", fetchedAt?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-priced-config-"));
  const configPath = path.join(root, "config.toml");
  await writeFile(configPath, configToml, "utf8");
  if (fetchedAt) await writePricingCache(pricingCachePath(root), catalogWithNewModel(fetchedAt));
  return { configPath, runtimeDir: root };
}

const rateFor = (config: Awaited<ReturnType<typeof loadPricedConfig>>, model: string) =>
  config.cost.modelRates.find((rate) => rate.model === model);

describe("loadPricedConfig", () => {
  it("prices models from a launch cache newer than the bundled table", async () => {
    const { configPath, runtimeDir } = await runtime("", AFTER_BUNDLED);

    expect(rateFor(await loadPricedConfig(configPath, runtimeDir), "claude-future-9")?.inputPer1MUsd).toBe(3);
  });

  it("keeps the bundled table when the cache is older than it", async () => {
    const { configPath, runtimeDir } = await runtime("", BEFORE_BUNDLED);
    const config = await loadPricedConfig(configPath, runtimeDir);

    expect(rateFor(config, "claude-future-9")).toBeUndefined();
    expect(rateFor(config, "claude-opus-4-6")).toBeDefined();
  });

  it("keeps the bundled table without a cache", async () => {
    const { configPath, runtimeDir } = await runtime();

    expect(rateFor(await loadPricedConfig(configPath, runtimeDir), "claude-opus-4-6")).toBeDefined();
  });

  it("ignores the cache when pricing sync is disabled", async () => {
    const { configPath, runtimeDir } = await runtime("[pricingSync]\nenabled = false\n", AFTER_BUNDLED);

    expect(rateFor(await loadPricedConfig(configPath, runtimeDir), "claude-future-9")).toBeUndefined();
  });

  it("lets an explicit config rate win over the cache", async () => {
    const toml = '[[cost.modelRates]]\nmodel = "claude-future-9"\ninputPer1MUsd = 1\noutputPer1MUsd = 2\n';
    const { configPath, runtimeDir } = await runtime(toml, AFTER_BUNDLED);

    expect(rateFor(await loadPricedConfig(configPath, runtimeDir), "claude-future-9")?.inputPer1MUsd).toBe(1);
  });
});
