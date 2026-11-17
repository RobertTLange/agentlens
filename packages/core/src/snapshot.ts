import type { AppConfig } from "@agentlens/contracts";
import { loadPricedConfig } from "./pricingCache.js";
import { TraceIndex } from "./traceIndex.js";

export async function loadSnapshot(configPath?: string): Promise<TraceIndex> {
  const config = await loadPricedConfig(configPath);
  const index = new TraceIndex(config as AppConfig);
  await index.refresh();
  return index;
}
