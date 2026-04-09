import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPricingCatalog, loadConfig, mergeConfig, saveConfig } from "@agentlens/core";
import { prepareBrowserConfig } from "./pricing-launch.js";

async function createConfigFile(runtimeLabel: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), runtimeLabel));
  const configPath = path.join(root, "config.toml");
  const config = mergeConfig({
    pricingSync: {
      enabled: true,
      ttlMs: 1_000,
      timeoutMs: 5_000,
    },
  });
  await saveConfig(config, configPath);
  return { root, configPath };
}

describe("prepareBrowserConfig", () => {
  it("fetches fresh pricing and writes an effective browser config", async () => {
    const { root, configPath } = await createConfigFile("agentlens-browser-pricing-");
    const runtimeDir = path.join(root, "runtime");
    const prepared = await prepareBrowserConfig({
      configPath,
      runtimeDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            openai: {
              models: {
                "gpt-5.4": {
                  cost: { input: 123, output: 456, cache_read: 7 },
                  limit: { context: 1_050_000 },
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      nowMs: Date.parse("2026-04-10T00:00:00.000Z"),
    });

    expect(prepared.pricingSource).toBe("fresh");
    expect(prepared.statusLine).toContain("Pricing source: fresh");
    const effective = await loadConfig(prepared.configPath);
    expect(effective.cost.modelRates.find((rate) => rate.model === "gpt-5.4")?.inputPer1MUsd).toBe(123);

    const cacheText = await readFile(path.join(runtimeDir, "pricing-cache.json"), "utf8");
    expect(cacheText).toContain('"version": 1');
    expect(cacheText).toContain('"inputPer1MUsd": 123');
  });

  it("falls back to cached pricing when live refresh fails", async () => {
    const { root, configPath } = await createConfigFile("agentlens-browser-pricing-cache-");
    const runtimeDir = path.join(root, "runtime");
    const cachePath = path.join(runtimeDir, "pricing-cache.json");
    const cachedCatalog = buildPricingCatalog(
      {
        google: {
          models: {
            "gemini-3.1-pro-preview": {
              cost: { input: 2, output: 12, cache_read: 0.2 },
              limit: { context: 1_048_576 },
            },
          },
        },
      },
      "2026-04-09T23:59:59.000Z",
    );
    await saveConfig(
      mergeConfig({
        pricingSync: {
          enabled: true,
          ttlMs: 1,
          timeoutMs: 5_000,
        },
      }),
      configPath,
    );
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      cachePath,
      JSON.stringify(
        {
          version: 1,
          ...cachedCatalog,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const prepared = await prepareBrowserConfig({
      configPath,
      runtimeDir,
      fetchImpl: async () => {
        throw new Error("offline");
      },
      nowMs: Date.parse("2026-04-10T00:00:10.000Z"),
    });

    expect(prepared.pricingSource).toBe("cached");
    expect(prepared.statusLine).toContain("refresh failed: offline");
    const effective = await loadConfig(prepared.configPath);
    expect(effective.cost.modelRates.find((rate) => rate.model === "gemini-3.1-pro-preview")?.inputPer1MUsd).toBe(2);
  });
});
