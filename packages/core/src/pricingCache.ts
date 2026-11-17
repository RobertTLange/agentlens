import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppConfig, CostModelRate, ModelContextWindow } from "@agentlens/contracts";
import {
  DEFAULT_CONFIG_PATH,
  mergeConfig,
  mergeConfigWithPricingDefaults,
  readConfigInput,
  stripBundledPricingOverrides,
} from "./config.js";
import { BUNDLED_PRICING_FETCHED_AT, DEFAULT_CONTEXT_WINDOWS, DEFAULT_PRICING_MODEL_RATES } from "./generatedPricing.js";
import { keepRetiredModels, type PricingCatalog } from "./pricingSync.js";

// `agentlens --browser` refreshes pricing from models.dev into this cache; every
// other command reads it (never the network), so CLI costs match the browser.
export const PRICING_CACHE_VERSION = 2;
export const PRICING_CACHE_FILE = "pricing-cache.json";

interface PricingCacheArtifact extends PricingCatalog {
  version: number;
}

export function resolveRuntimeDir(input?: string): string {
  return input?.trim() || process.env.AGENTLENS_RUNTIME_DIR?.trim() || path.join(os.homedir(), ".agentlens");
}

export function pricingCachePath(runtimeDir: string): string {
  return path.join(runtimeDir, PRICING_CACHE_FILE);
}

export async function readPricingCache(cachePath: string): Promise<PricingCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<PricingCacheArtifact>;
    if (parsed.version !== PRICING_CACHE_VERSION) return null;
    if (!parsed.fetchedAt || !Array.isArray(parsed.sources) || !Array.isArray(parsed.modelRates) || !Array.isArray(parsed.contextWindows)) {
      return null;
    }
    return {
      fetchedAt: parsed.fetchedAt,
      sources: parsed.sources,
      modelRates: parsed.modelRates as CostModelRate[],
      contextWindows: parsed.contextWindows as ModelContextWindow[],
    };
  } catch {
    return null;
  }
}

export async function writePricingCache(cachePath: string, catalog: PricingCatalog): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const artifact: PricingCacheArtifact = { version: PRICING_CACHE_VERSION, ...catalog };
  await writeFile(cachePath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

/** A cached catalog only beats the bundled table when it was fetched later (an upgrade can ship newer prices). */
export function isNewerThanBundled(catalog: PricingCatalog | null): catalog is PricingCatalog {
  if (!catalog) return false;
  const fetchedAtMs = Date.parse(catalog.fetchedAt);
  return Number.isFinite(fetchedAtMs) && fetchedAtMs > Date.parse(BUNDLED_PRICING_FETCHED_AT);
}

/** A fetched catalog plus the bundled rates of models it no longer lists. */
export function withBundledRetiredModels(catalog: PricingCatalog): PricingCatalog {
  return keepRetiredModels(catalog, { modelRates: DEFAULT_PRICING_MODEL_RATES, contextWindows: DEFAULT_CONTEXT_WINDOWS });
}

/** The user's config priced with the newest pricing on disk: the launch cache or the bundled defaults. */
export async function loadPricedConfig(configPath = DEFAULT_CONFIG_PATH, runtimeDir?: string): Promise<AppConfig> {
  const rawConfig = stripBundledPricingOverrides(await readConfigInput(configPath));
  if (!mergeConfig(rawConfig).pricingSync.enabled) return mergeConfig(rawConfig);
  const cached = await readPricingCache(pricingCachePath(resolveRuntimeDir(runtimeDir)));
  return isNewerThanBundled(cached) ? mergeConfigWithPricingDefaults(rawConfig, withBundledRetiredModels(cached)) : mergeConfig(rawConfig);
}
