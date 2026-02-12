import type { AppConfig } from "@agentlens/contracts";
import { loadConfig } from "./config.js";
import { TraceIndex } from "./traceIndex.js";

export async function loadSnapshot(configPath?: string): Promise<TraceIndex> {
  const config = await loadConfig(configPath);
  const index = new TraceIndex(config as AppConfig);
  await index.refresh();
  return index;
}
