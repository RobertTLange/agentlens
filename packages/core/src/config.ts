import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import TOML, { type JsonMap } from "@iarna/toml";
import type {
  AppConfig,
  ActivityHeatmapConfig,
  ActivityHeatmapMetric,
  AgentKind,
  AnalysisConfig,
  CostConfig,
  CostModelRate,
  ModelsConfig,
  ModelContextWindow,
  PricingSyncConfig,
  RagConfig,
  RagDailySummaryConfig,
  RetentionConfig,
  RedactionConfig,
  ScanConfig,
  SessionLogDirectoryConfig,
  SourceProfileConfig,
  TraceInspectorConfig,
} from "@agentlens/contracts";
import { DEFAULT_CONFIG, DEFAULT_SOURCE_PROFILES } from "./sourceProfiles.js";

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".agentlens", "config.toml");

export interface PricingDefaultsOverride {
  modelRates: CostModelRate[];
  contextWindows: ModelContextWindow[];
}

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

export type PartialAppConfigInput = Omit<Partial<AppConfig>, "analysis" | "rag"> & {
  analysis?: Partial<AnalysisConfig>;
  rag?: Omit<Partial<RagConfig>, "dailySummary"> & { dailySummary?: Partial<RagDailySummaryConfig> };
  sessionJsonlDirectories?: string[];
};

function isAgentKind(value: string): value is AgentKind {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "cursor" ||
    value === "opencode" ||
    value === "gemini" ||
    value === "antigravity" ||
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
  targetLogType: "cursor" | "gemini" | "antigravity" | "pi",
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
  const withAntigravity = ensureDefaultSessionLogDirectory(withGemini, "antigravity", [
    "codex",
    "claude",
    "cursor",
    "opencode",
  ]);
  return ensureDefaultSessionLogDirectory(withAntigravity, "pi", ["codex", "claude", "cursor", "opencode"]);
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
        else if (normalized.includes(".gemini/antigravity-cli") || normalized.includes(".gemini\\antigravity-cli")) {
          logType = "antigravity";
        }
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

function normalizeActivityHeatmapMetric(value: unknown): ActivityHeatmapMetric | null {
  if (value === "sessions" || value === "output_tokens" || value === "total_cost_usd") {
    return value;
  }
  return null;
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const digits = shortMatch[1] ?? "";
    return `#${digits
      .split("")
      .map((digit) => `${digit}${digit}`)
      .join("")
      .toLowerCase()}`;
  }
  const longMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (longMatch) {
    return `#${(longMatch[1] ?? "").toLowerCase()}`;
  }
  return null;
}

function mergeActivityHeatmap(input?: Partial<ActivityHeatmapConfig>): ActivityHeatmapConfig {
  const defaults = DEFAULT_CONFIG.activityHeatmap;
  return {
    metric: normalizeActivityHeatmapMetric(input?.metric) ?? defaults.metric,
    color: normalizeHexColor(input?.color) ?? defaults.color,
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

function mergePricingSync(input?: Partial<PricingSyncConfig>): PricingSyncConfig {
  const defaults = DEFAULT_CONFIG.pricingSync;
  return {
    enabled: input?.enabled ?? defaults.enabled,
    ttlMs: positiveMsOrDefault(input?.ttlMs, defaults.ttlMs),
    timeoutMs: positiveMsOrDefault(input?.timeoutMs, defaults.timeoutMs),
  };
}

function normalizeCostModelRate(value: unknown): CostModelRate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CostModelRate>;
  const model = String(candidate.model ?? "").trim();
  if (!model) return null;
  const normalized: CostModelRate = {
    model,
    inputPer1MUsd: toFiniteNumber(candidate.inputPer1MUsd) ?? 0,
    outputPer1MUsd: toFiniteNumber(candidate.outputPer1MUsd) ?? 0,
    cachedReadPer1MUsd: toFiniteNumber(candidate.cachedReadPer1MUsd) ?? 0,
    cachedCreatePer1MUsd: toFiniteNumber(candidate.cachedCreatePer1MUsd) ?? 0,
    reasoningOutputPer1MUsd: toFiniteNumber(candidate.reasoningOutputPer1MUsd) ?? 0,
  };
  const cachedCreate5mPer1MUsd = toFiniteNumber(candidate.cachedCreate5mPer1MUsd);
  if (cachedCreate5mPer1MUsd !== null) normalized.cachedCreate5mPer1MUsd = cachedCreate5mPer1MUsd;
  const cachedCreate1hPer1MUsd = toFiniteNumber(candidate.cachedCreate1hPer1MUsd);
  if (cachedCreate1hPer1MUsd !== null) normalized.cachedCreate1hPer1MUsd = cachedCreate1hPer1MUsd;
  const longContextThresholdTokens = toFiniteNumber(candidate.longContextThresholdTokens);
  if (longContextThresholdTokens !== null) normalized.longContextThresholdTokens = longContextThresholdTokens;
  const longContextInputPer1MUsd = toFiniteNumber(candidate.longContextInputPer1MUsd);
  if (longContextInputPer1MUsd !== null) normalized.longContextInputPer1MUsd = longContextInputPer1MUsd;
  const longContextOutputPer1MUsd = toFiniteNumber(candidate.longContextOutputPer1MUsd);
  if (longContextOutputPer1MUsd !== null) normalized.longContextOutputPer1MUsd = longContextOutputPer1MUsd;
  const longContextCachedReadPer1MUsd = toFiniteNumber(candidate.longContextCachedReadPer1MUsd);
  if (longContextCachedReadPer1MUsd !== null) normalized.longContextCachedReadPer1MUsd = longContextCachedReadPer1MUsd;
  const longContextCachedCreatePer1MUsd = toFiniteNumber(candidate.longContextCachedCreatePer1MUsd);
  if (longContextCachedCreatePer1MUsd !== null) normalized.longContextCachedCreatePer1MUsd = longContextCachedCreatePer1MUsd;
  const longContextCachedCreate5mPer1MUsd = toFiniteNumber(candidate.longContextCachedCreate5mPer1MUsd);
  if (longContextCachedCreate5mPer1MUsd !== null) {
    normalized.longContextCachedCreate5mPer1MUsd = longContextCachedCreate5mPer1MUsd;
  }
  const longContextCachedCreate1hPer1MUsd = toFiniteNumber(candidate.longContextCachedCreate1hPer1MUsd);
  if (longContextCachedCreate1hPer1MUsd !== null) {
    normalized.longContextCachedCreate1hPer1MUsd = longContextCachedCreate1hPer1MUsd;
  }
  const longContextReasoningOutputPer1MUsd = toFiniteNumber(candidate.longContextReasoningOutputPer1MUsd);
  if (longContextReasoningOutputPer1MUsd !== null) {
    normalized.longContextReasoningOutputPer1MUsd = longContextReasoningOutputPer1MUsd;
  }
  const contextWindowTokens = toFiniteNumber(candidate.contextWindowTokens);
  if (contextWindowTokens !== null) normalized.contextWindowTokens = contextWindowTokens;
  return normalized;
}

function mergeCost(input?: Partial<CostConfig>, defaultModelRates: CostModelRate[] = DEFAULT_CONFIG.cost.modelRates): CostConfig {
  const defaults = DEFAULT_CONFIG.cost;
  const defaultRates = defaultModelRates.map(normalizeCostModelRate).filter((value): value is CostModelRate => value !== null);
  const inputRates = Array.isArray(input?.modelRates)
    ? input.modelRates.map(normalizeCostModelRate).filter((value): value is CostModelRate => value !== null)
    : [];
  const rateByModel = new Map(defaultRates.map((rate) => [rate.model, rate] as const));
  for (const rate of inputRates) {
    rateByModel.set(rate.model, rate);
  }
  const appendedInputRates = inputRates.filter((rate) => !defaultRates.some((defaultRate) => defaultRate.model === rate.model));
  const rates = [
    ...defaultRates.map((rate) => rateByModel.get(rate.model) ?? rate),
    ...appendedInputRates,
  ];
  return {
    enabled: input?.enabled ?? defaults.enabled,
    currency: typeof input?.currency === "string" && input.currency.trim() ? input.currency : defaults.currency,
    unknownModelPolicy: input?.unknownModelPolicy === "zero" ? "zero" : defaults.unknownModelPolicy,
    modelRates: rates,
  };
}

function mergeModels(
  input?: Partial<ModelsConfig>,
  defaultContextWindows: ModelContextWindow[] = DEFAULT_CONFIG.models.contextWindows,
): ModelsConfig {
  const defaults = DEFAULT_CONFIG.models;
  const defaultWindow = toFiniteNumber(input?.defaultContextWindowTokens);
  const normalizedInputContextWindows =
    Array.isArray(input?.contextWindows) && input.contextWindows.length > 0
      ? input.contextWindows
          .map((entry) => {
            const model = String(entry?.model ?? "").trim();
            const contextWindowTokens = toFiniteNumber(entry?.contextWindowTokens);
            if (!model || contextWindowTokens === null || contextWindowTokens <= 0) return null;
            return { model, contextWindowTokens: Math.round(contextWindowTokens) };
          })
          .filter((entry): entry is { model: string; contextWindowTokens: number } => entry !== null)
      : [];
  const windowByModel = new Map(defaultContextWindows.map((entry) => [entry.model, entry] as const));
  for (const entry of normalizedInputContextWindows) {
    windowByModel.set(entry.model, entry);
  }
  const appendedInputContextWindows = normalizedInputContextWindows.filter(
    (entry) => !defaultContextWindows.some((defaultEntry) => defaultEntry.model === entry.model),
  );
  const contextWindows = [
    ...defaultContextWindows.map((entry) => windowByModel.get(entry.model) ?? entry),
    ...appendedInputContextWindows,
  ];

  return {
    defaultContextWindowTokens:
      defaultWindow !== null && defaultWindow > 0 ? Math.round(defaultWindow) : defaults.defaultContextWindowTokens,
    contextWindows,
  };
}

function nonEmptyStringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function mergeRagDailySummary(input: Partial<RagDailySummaryConfig> | undefined, summaryMaxPromptBytes: number): RagDailySummaryConfig {
  const defaults = DEFAULT_CONFIG.rag.dailySummary;
  const scheduleHour = toFiniteNumber(input?.scheduleHourLocal);
  return {
    enabled: input?.enabled ?? defaults.enabled,
    scheduleHourLocal: scheduleHour === null ? defaults.scheduleHourLocal : Math.max(0, Math.min(23, Math.round(scheduleHour))),
    windowHours: Math.max(1, positiveIntOrDefault(input?.windowHours, defaults.windowHours)),
    retryIntervalMs: positiveMsOrDefault(input?.retryIntervalMs, defaults.retryIntervalMs),
    maxPromptBytes: positiveMsOrDefault(input?.maxPromptBytes, summaryMaxPromptBytes),
  };
}

function mergeRag(input?: PartialAppConfigInput["rag"]): RagConfig {
  const defaults = DEFAULT_CONFIG.rag;
  const backend = input?.embeddingBackend === "disabled" ? "disabled" : defaults.embeddingBackend;
  const summaryMaxPromptBytes = positiveMsOrDefault(input?.summaryMaxPromptBytes, defaults.summaryMaxPromptBytes);
  return {
    enabled: input?.enabled ?? defaults.enabled,
    dbPath: nonEmptyStringOrDefault(input?.dbPath, defaults.dbPath),
    quietPeriodMs: positiveMsOrDefault(input?.quietPeriodMs, defaults.quietPeriodMs),
    workerIntervalMs: positiveMsOrDefault(input?.workerIntervalMs, defaults.workerIntervalMs),
    daemonPidPath: nonEmptyStringOrDefault(input?.daemonPidPath, defaults.daemonPidPath),
    daemonLogPath: nonEmptyStringOrDefault(input?.daemonLogPath, defaults.daemonLogPath),
    headlessExecutable: nonEmptyStringOrDefault(input?.headlessExecutable, defaults.headlessExecutable),
    summaryAgent: nonEmptyStringOrDefault(input?.summaryAgent, defaults.summaryAgent),
    summaryModel: typeof input?.summaryModel === "string" ? input.summaryModel.trim() : defaults.summaryModel,
    summaryReasoningEffort: nonEmptyStringOrDefault(input?.summaryReasoningEffort, defaults.summaryReasoningEffort),
    summaryPermissionMode: nonEmptyStringOrDefault(input?.summaryPermissionMode, defaults.summaryPermissionMode),
    summaryTimeoutMs: positiveMsOrDefault(input?.summaryTimeoutMs, defaults.summaryTimeoutMs),
    summaryMaxPromptBytes,
    embeddingBackend: backend,
    embeddingModel: nonEmptyStringOrDefault(input?.embeddingModel, defaults.embeddingModel),
    modelCacheDir: nonEmptyStringOrDefault(input?.modelCacheDir, defaults.modelCacheDir),
    embeddingBatchSize: Math.max(1, positiveIntOrDefault(input?.embeddingBatchSize, defaults.embeddingBatchSize)),
    searchCandidateMultiplier: Math.max(1, positiveIntOrDefault(input?.searchCandidateMultiplier, defaults.searchCandidateMultiplier)),
    rrfK: Math.max(1, positiveIntOrDefault(input?.rrfK, defaults.rrfK)),
    dailySummary: mergeRagDailySummary(input?.dailySummary, summaryMaxPromptBytes),
  };
}

function mergeAnalysis(input?: Partial<AnalysisConfig>): AnalysisConfig {
  const defaults = DEFAULT_CONFIG.analysis;
  const rawRoots = Array.isArray(input?.skillRoots) ? input.skillRoots : defaults.skillRoots;
  const skillRoots = rawRoots
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  return {
    skillRoots: skillRoots.length > 0 ? skillRoots : defaults.skillRoots,
    topSessionLimit: Math.max(1, positiveIntOrDefault(input?.topSessionLimit, defaults.topSessionLimit)),
    cachePath: nonEmptyStringOrDefault(input?.cachePath, defaults.cachePath),
  };
}

export function mergeConfigWithPricingDefaults(
  input?: PartialAppConfigInput,
  pricingDefaults?: PricingDefaultsOverride,
): AppConfig {
  const sources: Record<string, SourceProfileConfig> = {};
  const inputSources = input?.sources ?? {};
  const hasExplicitSources = input?.sources !== undefined;

  for (const [name, defaultProfile] of Object.entries(DEFAULT_SOURCE_PROFILES)) {
    const profileInput = inputSources[name];
    if (profileInput) {
      sources[name] = mergeProfile(defaultProfile, profileInput);
      continue;
    }
    if (hasExplicitSources) {
      sources[name] = mergeProfile(defaultProfile, { enabled: false });
      continue;
    }
    sources[name] = mergeProfile(defaultProfile);
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
    activityHeatmap: mergeActivityHeatmap(input?.activityHeatmap),
    redaction: mergeRedaction(input?.redaction),
    pricingSync: mergePricingSync(input?.pricingSync),
    cost: mergeCost(input?.cost, pricingDefaults?.modelRates),
    models: mergeModels(input?.models, pricingDefaults?.contextWindows),
    rag: mergeRag(input?.rag),
    analysis: mergeAnalysis(input?.analysis),
  };
}

export function mergeConfig(input?: PartialAppConfigInput): AppConfig {
  return mergeConfigWithPricingDefaults(input);
}

export async function readConfigInput(configPath = DEFAULT_CONFIG_PATH): Promise<PartialAppConfigInput> {
  try {
    const raw = await readFile(configPath, "utf8");
    return TOML.parse(raw) as PartialAppConfigInput;
  } catch {
    return {};
  }
}

export function stripBundledPricingOverrides(input: PartialAppConfigInput): PartialAppConfigInput {
  const next = structuredClone(input);

  if (Array.isArray(next.cost?.modelRates)) {
    const defaultRates = new Map(
      DEFAULT_CONFIG.cost.modelRates
        .map(normalizeCostModelRate)
        .filter((value): value is CostModelRate => value !== null)
        .map((rate) => [rate.model, rate] as const),
    );
    const keptRates = next.cost.modelRates.filter((candidate) => {
      const normalized = normalizeCostModelRate(candidate);
      if (!normalized) return false;
      const bundled = defaultRates.get(normalized.model);
      return !bundled || JSON.stringify(normalized) !== JSON.stringify(bundled);
    });
    next.cost = {
      ...next.cost,
      modelRates: keptRates,
    };
  }

  if (Array.isArray(next.models?.contextWindows)) {
    const defaultWindows = new Map(DEFAULT_CONFIG.models.contextWindows.map((entry) => [entry.model, entry.contextWindowTokens] as const));
    const keptWindows = next.models.contextWindows.filter((entry) => {
      const model = String(entry?.model ?? "").trim();
      const contextWindowTokens = toFiniteNumber(entry?.contextWindowTokens);
      if (!model || contextWindowTokens === null) return false;
      const bundled = defaultWindows.get(model);
      return bundled === undefined || bundled !== Math.round(contextWindowTokens);
    });
    next.models = {
      ...next.models,
      contextWindows: keptWindows,
    };
  }

  return next;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  const parsed = await readConfigInput(configPath);
  return mergeConfig(parsed);
}

export async function saveConfig(config: AppConfig, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const dir = path.dirname(configPath);
  await mkdir(dir, { recursive: true });
  const content = TOML.stringify(config as unknown as JsonMap);
  await writeFile(configPath, content, "utf8");
}
