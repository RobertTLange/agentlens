import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import TOML, { type JsonMap } from "@iarna/toml";
import type {
  AppConfig,
  AgentKind,
  CostConfig,
  CostModelRate,
  ModelsConfig,
  RetentionConfig,
  RedactionConfig,
  ScanConfig,
  SessionLogDirectoryConfig,
  SourceProfileConfig,
  TraceInspectorConfig,
} from "@agentlens/contracts";
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
  return (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "gemini" ||
    value === "pi" ||
    value === "unknown"
  );
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

function ensureDefaultSessionLogDirectory(
  entries: SessionLogDirectoryConfig[],
  targetLogType: "cursor" | "gemini" | "pi",
  anchorTypes: AgentKind[],
): SessionLogDirectoryConfig[] {
  if (entries.some((entry) => entry.logType === targetLogType)) {
    return entries;
  }

  const hasKnownLegacyAgents = entries.some(
    (entry) => anchorTypes.includes(entry.logType) && entry.directory.trim().startsWith("~/"),
  );
  if (!hasKnownLegacyAgents) {
    return entries;
  }

  const defaultEntry = DEFAULT_CONFIG.sessionLogDirectories.find((entry) => entry.logType === targetLogType);
  if (!defaultEntry) {
    return entries;
  }

  return [
    ...entries,
    {
      directory: defaultEntry.directory,
      logType: targetLogType,
    },
  ];
}

function ensureKnownSessionLogDirectories(entries: SessionLogDirectoryConfig[]): SessionLogDirectoryConfig[] {
  const withCursor = ensureDefaultSessionLogDirectory(entries, "cursor", ["codex", "claude", "opencode"]);
  const withGemini = ensureDefaultSessionLogDirectory(withCursor, "gemini", ["codex", "claude", "cursor", "opencode"]);
  return ensureDefaultSessionLogDirectory(withGemini, "pi", ["codex", "claude", "cursor", "opencode"]);
}

function mergeSessionLogDirectories(input?: unknown, legacyDirectories?: string[]): SessionLogDirectoryConfig[] {
  if (Array.isArray(input)) {
    const dedup = new Map<string, SessionLogDirectoryConfig>();
    for (const value of input) {
      const normalized = normalizeSessionLogDirectory(value);
      if (!normalized) continue;
      dedup.set(`${normalized.directory}::${normalized.logType}`, normalized);
    }
    return ensureKnownSessionLogDirectories(Array.from(dedup.values()));
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
        else if (normalized.includes(".cursor")) logType = "cursor";
        else if (normalized.includes(".gemini")) logType = "gemini";
        else if (normalized.includes(".pi")) logType = "pi";
        else if (normalized.includes("opencode")) logType = "opencode";
        return { directory, logType };
      })
      .filter((entry) => {
        const key = `${entry.directory}::${entry.logType}`;
        if (dedup.has(key)) return false;
        dedup.add(key);
        return true;
      });
    return ensureKnownSessionLogDirectories(legacy);
  }

  return cloneDefaultSessionLogDirectories();
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.round(numeric);
}

function positiveMsOrDefault(value: unknown, fallback: number): number {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric <= 0) return fallback;
  return Math.max(1, Math.round(numeric));
}

function mergeScan(input?: Partial<ScanConfig>): ScanConfig {
  const defaults = DEFAULT_CONFIG.scan;
  const mode = input?.mode === "fixed" ? "fixed" : "adaptive";
  const intervalMinMs = positiveMsOrDefault(input?.intervalMinMs, defaults.intervalMinMs);
  const intervalMaxMs = Math.max(intervalMinMs, positiveMsOrDefault(input?.intervalMaxMs, defaults.intervalMaxMs));

  return {
    mode,
    intervalSeconds: positiveMsOrDefault(input?.intervalSeconds, defaults.intervalSeconds),
    intervalMinMs,
    intervalMaxMs,
    fullRescanIntervalMs: positiveMsOrDefault(input?.fullRescanIntervalMs, defaults.fullRescanIntervalMs),
    batchDebounceMs: positiveMsOrDefault(input?.batchDebounceMs, defaults.batchDebounceMs),
    recentEventWindow: positiveIntOrDefault(input?.recentEventWindow, defaults.recentEventWindow),
    includeMetaDefault: input?.includeMetaDefault ?? defaults.includeMetaDefault,
    statusRunningTtlMs: positiveMsOrDefault(input?.statusRunningTtlMs, defaults.statusRunningTtlMs),
    statusWaitingTtlMs: positiveMsOrDefault(input?.statusWaitingTtlMs, defaults.statusWaitingTtlMs),
  };
}

function mergeRetention(input?: Partial<RetentionConfig>): RetentionConfig {
  const defaults = DEFAULT_CONFIG.retention;
  const strategy = input?.strategy === "full_memory" ? "full_memory" : "aggressive_recency";
  const hotTraceCount = Math.max(1, positiveIntOrDefault(input?.hotTraceCount, defaults.hotTraceCount));
  const warmTraceCount = Math.max(0, positiveIntOrDefault(input?.warmTraceCount, defaults.warmTraceCount));

  return {
    strategy,
    hotTraceCount,
    warmTraceCount,
    maxResidentEventsPerHotTrace: Math.max(
      1,
      positiveIntOrDefault(input?.maxResidentEventsPerHotTrace, defaults.maxResidentEventsPerHotTrace),
    ),
    maxResidentEventsPerWarmTrace: Math.max(
      1,
      positiveIntOrDefault(input?.maxResidentEventsPerWarmTrace, defaults.maxResidentEventsPerWarmTrace),
    ),
    detailLoadMode: "lazy_from_disk",
  };
}

function mergeTraceInspector(input?: Partial<TraceInspectorConfig>): TraceInspectorConfig {
  const defaults = DEFAULT_CONFIG.traceInspector;
  const topModelCountInput = toFiniteNumber(input?.topModelCount);
  return {
    includeMetaDefault: input?.includeMetaDefault ?? defaults.includeMetaDefault,
    topModelCount: topModelCountInput !== null && topModelCountInput > 0 ? Math.round(topModelCountInput) : defaults.topModelCount,
    showAgentBadges: input?.showAgentBadges ?? defaults.showAgentBadges,
    showHealthDiagnostics: input?.showHealthDiagnostics ?? defaults.showHealthDiagnostics,
  };
}

function mergeRedaction(input?: Partial<RedactionConfig>): RedactionConfig {
  const defaults = DEFAULT_CONFIG.redaction;
  return {
    mode: input?.mode === "off" || input?.mode === "strict" ? input.mode : defaults.mode,
    alwaysOn: input?.alwaysOn ?? defaults.alwaysOn,
    replacement: typeof input?.replacement === "string" && input.replacement.trim() ? input.replacement : defaults.replacement,
    keyPattern: typeof input?.keyPattern === "string" && input.keyPattern.trim() ? input.keyPattern : defaults.keyPattern,
    valuePattern: typeof input?.valuePattern === "string" && input.valuePattern.trim() ? input.valuePattern : defaults.valuePattern,
  };
}

function normalizeCostModelRate(value: unknown): CostModelRate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CostModelRate>;
  const model = String(candidate.model ?? "").trim();
  if (!model) return null;
  return {
    model,
    inputPer1MUsd: toFiniteNumber(candidate.inputPer1MUsd) ?? 0,
    outputPer1MUsd: toFiniteNumber(candidate.outputPer1MUsd) ?? 0,
    cachedReadPer1MUsd: toFiniteNumber(candidate.cachedReadPer1MUsd) ?? 0,
    cachedCreatePer1MUsd: toFiniteNumber(candidate.cachedCreatePer1MUsd) ?? 0,
    reasoningOutputPer1MUsd: toFiniteNumber(candidate.reasoningOutputPer1MUsd) ?? 0,
  };
}

function mergeCost(input?: Partial<CostConfig>): CostConfig {
  const defaults = DEFAULT_CONFIG.cost;
  const ratesInput = Array.isArray(input?.modelRates) ? input.modelRates : defaults.modelRates;
  const rates = ratesInput.map(normalizeCostModelRate).filter((value): value is CostModelRate => value !== null);
  return {
    enabled: input?.enabled ?? defaults.enabled,
    currency: typeof input?.currency === "string" && input.currency.trim() ? input.currency : defaults.currency,
    unknownModelPolicy: input?.unknownModelPolicy === "zero" ? "zero" : defaults.unknownModelPolicy,
    modelRates: rates,
  };
}

function mergeModels(input?: Partial<ModelsConfig>): ModelsConfig {
  const defaults = DEFAULT_CONFIG.models;
  const defaultWindow = toFiniteNumber(input?.defaultContextWindowTokens);
  const contextWindows =
    Array.isArray(input?.contextWindows) && input.contextWindows.length > 0
      ? input.contextWindows
          .map((entry) => {
            const model = String(entry?.model ?? "").trim();
            const contextWindowTokens = toFiniteNumber(entry?.contextWindowTokens);
            if (!model || contextWindowTokens === null || contextWindowTokens <= 0) return null;
            return { model, contextWindowTokens: Math.round(contextWindowTokens) };
          })
          .filter((entry): entry is { model: string; contextWindowTokens: number } => entry !== null)
      : defaults.contextWindows;

  return {
    defaultContextWindowTokens:
      defaultWindow !== null && defaultWindow > 0 ? Math.round(defaultWindow) : defaults.defaultContextWindowTokens,
    contextWindows,
  };
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
    scan: mergeScan(input?.scan),
    retention: mergeRetention(input?.retention),
    sessionLogDirectories: mergeSessionLogDirectories(input?.sessionLogDirectories, input?.sessionJsonlDirectories),
    sources,
    traceInspector: mergeTraceInspector(input?.traceInspector),
    redaction: mergeRedaction(input?.redaction),
    cost: mergeCost(input?.cost),
    models: mergeModels(input?.models),
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
