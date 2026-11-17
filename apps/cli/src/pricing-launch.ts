import { createHash } from "node:crypto";
import path from "node:path";
import type { PricingCatalog } from "@agentlens/core";
import {
  fetchPricingCatalog,
  mergeConfig,
  mergeConfigWithPricingDefaults,
  pricingCachePath,
  readConfigInput,
  readPricingCache,
  resolveRuntimeDir,
  saveConfig,
  stripBundledPricingOverrides,
  writePricingCache,
} from "@agentlens/core";

const EFFECTIVE_CONFIG_FILE = "browser-config.toml";

export type PricingLaunchSource = "fresh" | "cached" | "bundled";

export interface PreparedBrowserConfig {
  configPath: string;
  configFingerprint: string;
  pricingSource: PricingLaunchSource;
  statusLine: string;
  runtimeDir: string;
}

interface PrepareBrowserConfigOptions {
  configPath: string;
  runtimeDir?: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}

function effectiveConfigPath(runtimeDir: string): string {
  return path.join(runtimeDir, EFFECTIVE_CONFIG_FILE);
}

function isFresh(catalog: PricingCatalog | null, ttlMs: number, nowMs: number): boolean {
  if (!catalog) return false;
  const fetchedAtMs = Date.parse(catalog.fetchedAt);
  if (!Number.isFinite(fetchedAtMs)) return false;
  return nowMs - fetchedAtMs <= ttlMs;
}

function hashConfig(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

async function fetchWithTimeout(
  timeoutMs: number,
  fetchImpl?: typeof fetch,
): Promise<PricingCatalog> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const options: Parameters<typeof fetchPricingCatalog>[0] = {
      signal: controller.signal,
      ...(fetchImpl ? { fetchImpl } : {}),
    };
    const envUrl = process.env.AGENTLENS_PRICING_SYNC_URL?.trim();
    if (envUrl) {
      options.url = envUrl;
    }
    return await fetchPricingCatalog(options);
  } finally {
    clearTimeout(timeout);
  }
}

function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function prepareBrowserConfig(options: PrepareBrowserConfigOptions): Promise<PreparedBrowserConfig> {
  const nowMs = options.nowMs ?? Date.now();
  const runtimeDir = resolveRuntimeDir(options.runtimeDir);
  const rawConfig = stripBundledPricingOverrides(await readConfigInput(options.configPath));
  const baseConfig = mergeConfig(rawConfig);
  const cachePath = pricingCachePath(runtimeDir);

  let selectedCatalog: PricingCatalog | null = null;
  let pricingSource: PricingLaunchSource = "bundled";
  let statusLine = "Pricing source: bundled defaults.";

  if (baseConfig.pricingSync.enabled) {
    const cachedCatalog = await readPricingCache(cachePath);
    if (isFresh(cachedCatalog, baseConfig.pricingSync.ttlMs, nowMs)) {
      selectedCatalog = cachedCatalog;
      pricingSource = "cached";
      statusLine = `Pricing source: cached (${cachedCatalog?.fetchedAt ?? "unknown fetch time"}).`;
    } else {
      try {
        selectedCatalog = await fetchWithTimeout(baseConfig.pricingSync.timeoutMs, options.fetchImpl);
        pricingSource = "fresh";
        statusLine = `Pricing source: fresh (${selectedCatalog.fetchedAt}).`;
        await writePricingCache(cachePath, selectedCatalog);
      } catch (error) {
        if (cachedCatalog) {
          selectedCatalog = cachedCatalog;
          pricingSource = "cached";
          statusLine = `Pricing source: cached (${cachedCatalog.fetchedAt}; refresh failed: ${errorSummary(error)}).`;
        } else {
          statusLine = `Pricing source: bundled defaults (refresh failed: ${errorSummary(error)}).`;
        }
      }
    }
  } else {
    statusLine = "Pricing source: bundled defaults (launch refresh disabled).";
  }

  const effectiveConfig = selectedCatalog
    ? mergeConfigWithPricingDefaults(rawConfig, selectedCatalog)
    : mergeConfig(rawConfig);
  const resolvedConfigPath = effectiveConfigPath(runtimeDir);
  await saveConfig(effectiveConfig, resolvedConfigPath);

  return {
    configPath: resolvedConfigPath,
    configFingerprint: hashConfig(effectiveConfig),
    pricingSource,
    statusLine,
    runtimeDir,
  };
}
