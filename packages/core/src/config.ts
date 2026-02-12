import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import TOML, { type JsonMap } from "@iarna/toml";
import type { AppConfig, AgentKind, SessionLogDirectoryConfig, SourceProfileConfig } from "@agentlens/contracts";
import { DEFAULT_CONFIG, DEFAULT_SOURCE_PROFILES } from "./sourceProfiles.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".agentlens", "config.toml");

function mergeProfile(defaultProfile: SourceProfileConfig, input?: Partial<SourceProfileConfig>): SourceProfileConfig {
  const merged: SourceProfileConfig = {
    name: input?.name ?? defaultProfile.name,
    enabled: input?.enabled ?? defaultProfile.enabled,
    roots: input?.roots ?? defaultProfile.roots,
    includeGlobs: input?.includeGlobs ?? defaultProfile.includeGlobs,
    excludeGlobs: input?.excludeGlobs ?? defaultProfile.excludeGlobs,
    maxDepth: input?.maxDepth ?? defaultProfile.maxDepth,
  };
  const hint = input?.agentHint ?? defaultProfile.agentHint;
  if (hint !== undefined) {
    merged.agentHint = hint;
  }
  return merged;
}

type PartialAppConfigInput = Partial<AppConfig> & { sessionJsonlDirectories?: string[] };

function isAgentKind(value: string): value is AgentKind {
  return value === "claude" || value === "codex" || value === "cursor" || value === "opencode" || value === "unknown";
}

function cloneDefaultSessionLogDirectories(): SessionLogDirectoryConfig[] {
  return DEFAULT_CONFIG.sessionLogDirectories.map((entry) => ({
    directory: entry.directory,
    logType: entry.logType,
  }));
}

function normalizeSessionLogDirectory(value: unknown): SessionLogDirectoryConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<SessionLogDirectoryConfig>;
  const directory = String(candidate.directory ?? "").trim();
  const logTypeRaw = String(candidate.logType ?? "").trim().toLowerCase();
  if (!directory || !isAgentKind(logTypeRaw)) {
    return null;
  }
  return { directory, logType: logTypeRaw };
}

function mergeSessionLogDirectories(input?: unknown, legacyDirectories?: string[]): SessionLogDirectoryConfig[] {
  if (Array.isArray(input)) {
    const dedup = new Map<string, SessionLogDirectoryConfig>();
    for (const value of input) {
      const normalized = normalizeSessionLogDirectory(value);
      if (!normalized) continue;
      dedup.set(`${normalized.directory}::${normalized.logType}`, normalized);
    }
    return Array.from(dedup.values());
  }

  if (Array.isArray(legacyDirectories)) {
    const dedup = new Set<string>();
    const legacy = legacyDirectories
      .map((directory) => String(directory ?? "").trim())
      .filter((directory) => directory.length > 0)
      .map((directory) => {
        const normalized = directory.toLowerCase();
        let logType: AgentKind = "unknown";
        if (normalized.includes(".codex")) logType = "codex";
        else if (normalized.includes(".claude")) logType = "claude";
        else if (normalized.includes(".opencode")) logType = "opencode";
        else if (normalized.includes(".cursor")) logType = "cursor";
        return { directory, logType };
      })
      .filter((entry) => {
        const key = `${entry.directory}::${entry.logType}`;
        if (dedup.has(key)) return false;
        dedup.add(key);
        return true;
      });
    return legacy;
  }

  return cloneDefaultSessionLogDirectories();
}

export function mergeConfig(input?: PartialAppConfigInput): AppConfig {
  const sources: Record<string, SourceProfileConfig> = {};
  const inputSources = input?.sources ?? {};

  for (const [name, defaultProfile] of Object.entries(DEFAULT_SOURCE_PROFILES)) {
    sources[name] = mergeProfile(defaultProfile, inputSources[name]);
  }

  for (const [name, profile] of Object.entries(inputSources)) {
    if (!sources[name]) {
      sources[name] = mergeProfile(
        {
          name,
          enabled: true,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "unknown",
        },
        profile,
      );
    }
  }

  return {
    scan: {
      intervalSeconds: input?.scan?.intervalSeconds ?? DEFAULT_CONFIG.scan.intervalSeconds,
      recentEventWindow: input?.scan?.recentEventWindow ?? DEFAULT_CONFIG.scan.recentEventWindow,
      includeMetaDefault: input?.scan?.includeMetaDefault ?? DEFAULT_CONFIG.scan.includeMetaDefault,
      statusRunningTtlMs: input?.scan?.statusRunningTtlMs ?? DEFAULT_CONFIG.scan.statusRunningTtlMs,
      statusWaitingTtlMs: input?.scan?.statusWaitingTtlMs ?? DEFAULT_CONFIG.scan.statusWaitingTtlMs,
    },
    sessionLogDirectories: mergeSessionLogDirectories(input?.sessionLogDirectories, input?.sessionJsonlDirectories),
    sources,
  };
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed = TOML.parse(raw) as PartialAppConfigInput;
    return mergeConfig(parsed);
  } catch {
    return mergeConfig();
  }
}

export async function saveConfig(config: AppConfig, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const content = TOML.stringify(config as unknown as JsonMap);
  await writeFile(configPath, content, "utf8");
}
