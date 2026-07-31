export type AgentKind = "claude" | "codex" | "cursor" | "opencode" | "gemini" | "antigravity" | "pi" | "unknown";

export type EventKind =
  | "system"
  | "assistant"
  | "user"
  | "tool_use"
  | "tool_result"
  | "reasoning"
  | "compaction"
  | "meta";

export type SessionActivityStatus = "running" | "waiting_input" | "idle";
export type ActivityBinsMode = "time" | "event_index";
export type ActivityHeatmapMetric = "sessions" | "output_tokens" | "total_cost_usd";
export type CostUnknownModelPolicy = "n_a" | "zero";
export type ScanMode = "adaptive" | "fixed";
export type RetentionStrategy = "aggressive_recency" | "full_memory";
export type ResidentTier = "hot" | "warm" | "cold";
export type RagSearchMode = "hybrid" | "lexical" | "semantic";
export type RagDocumentKind = "summary" | "trace";
export type RagRefreshStatus = "pending" | "running" | "complete" | "stale" | "failed" | "skipped";
export type RagEmbeddingStatus = "ready" | "missing" | "dirty" | "unavailable" | "disabled";
export type AnalysisDetectorSupport = "supported" | "unsupported";
export type AnalysisSkillConfidence = "explicit" | "inferred";
export type AnalysisInventoryStatus = "configured" | "unconfigured";

export interface ScanConfig {
  mode: ScanMode;
  intervalSeconds: number;
  intervalMinMs: number;
  intervalMaxMs: number;
  fullRescanIntervalMs: number;
  batchDebounceMs: number;
  recentEventWindow: number;
  includeMetaDefault: boolean;
  statusRunningTtlMs: number;
  statusWaitingTtlMs: number;
}

export interface RetentionConfig {
  strategy: RetentionStrategy;
  hotTraceCount: number;
  warmTraceCount: number;
  maxResidentEventsPerHotTrace: number;
  maxResidentEventsPerWarmTrace: number;
  detailLoadMode: "lazy_from_disk";
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface TraceInspectorConfig {
  includeMetaDefault: boolean;
  topModelCount: number;
  showAgentBadges: boolean;
  showHealthDiagnostics: boolean;
}

export interface ActivityHeatmapConfig {
  metric: ActivityHeatmapMetric;
  color: string;
}

export interface RedactionConfig {
  mode: "strict" | "off";
  alwaysOn: boolean;
  replacement: string;
  keyPattern: string;
  valuePattern: string;
}

export interface PricingSyncConfig {
  enabled: boolean;
  ttlMs: number;
  timeoutMs: number;
}

export interface CostModelRate {
  model: string;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cachedReadPer1MUsd: number;
  cachedCreatePer1MUsd: number;
  cachedCreate5mPer1MUsd?: number;
  cachedCreate1hPer1MUsd?: number;
  reasoningOutputPer1MUsd: number;
  longContextThresholdTokens?: number;
  longContextInputPer1MUsd?: number;
  longContextOutputPer1MUsd?: number;
  longContextCachedReadPer1MUsd?: number;
  longContextCachedCreatePer1MUsd?: number;
  longContextCachedCreate5mPer1MUsd?: number;
  longContextCachedCreate1hPer1MUsd?: number;
  longContextReasoningOutputPer1MUsd?: number;
  contextWindowTokens?: number;
}

export interface CostConfig {
  enabled: boolean;
  currency: string;
  unknownModelPolicy: CostUnknownModelPolicy;
  modelRates: CostModelRate[];
}

export interface ModelContextWindow {
  model: string;
  contextWindowTokens: number;
}

export interface ModelsConfig {
  defaultContextWindowTokens: number;
  contextWindows: ModelContextWindow[];
}

export interface RagConfig {
  enabled: boolean;
  dbPath: string;
  quietPeriodMs: number;
  workerIntervalMs: number;
  daemonPidPath: string;
  daemonLogPath: string;
  headlessExecutable: string;
  summaryAgent: string;
  summaryModel: string;
  summaryReasoningEffort: string;
  summaryPermissionMode: string;
  summaryTimeoutMs: number;
  summaryMaxPromptBytes: number;
  embeddingBackend: "local" | "disabled";
  embeddingModel: string;
  modelCacheDir: string;
  embeddingBatchSize: number;
  searchCandidateMultiplier: number;
  rrfK: number;
  dailySummary: RagDailySummaryConfig;
}

export interface RagDailySummaryConfig {
  enabled: boolean;
  scheduleHourLocal: number;
  windowHours: number;
  retryIntervalMs: number;
  maxPromptBytes: number;
}

export interface AnalysisConfig {
  skillRoots: string[];
  topSessionLimit: number;
  cachePath: string;
}

export type RemoteArchiveStoreConfig =
  | { kind: "filesystem"; directory: string }
  | {
      kind: "s3";
      bucket: string;
      prefix: string;
      region: string;
      endpoint: string;
      forcePathStyle: boolean;
      allowInsecureHttpEndpoint: boolean;
    };

export interface RemoteArchiveConfig {
  enabled: boolean;
  namespace: string;
  originId: string;
  flushIntervalMs: number;
  idleFlushMs: number;
  statePath: string;
  cachePath: string;
  rawPublicKeyPath: string;
  store: RemoteArchiveStoreConfig;
}

export interface TokenTotals {
  inputTokens: number;
  cachedReadTokens: number;
  cachedCreateTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ModelTokenShare {
  model: string;
  tokens: number;
  percent: number;
}

export interface SourceProfileConfig {
  name: string;
  enabled: boolean;
  roots: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  maxDepth: number;
  agentHint?: AgentKind;
}

export interface SessionLogDirectoryConfig {
  directory: string;
  logType: AgentKind;
}

export interface AppConfig {
  scan: ScanConfig;
  retention: RetentionConfig;
  sessionLogDirectories: SessionLogDirectoryConfig[];
  sources: Record<string, SourceProfileConfig>;
  traceInspector: TraceInspectorConfig;
  activityHeatmap: ActivityHeatmapConfig;
  redaction: RedactionConfig;
  pricingSync: PricingSyncConfig;
  cost: CostConfig;
  models: ModelsConfig;
  rag: RagConfig;
  analysis: AnalysisConfig;
  remoteArchive: RemoteArchiveConfig;
}

export interface NormalizedEvent {
  eventId: string;
  traceId: string;
  index: number;
  offset: number;
  timestampMs: number | null;
  sessionId: string;
  eventKind: EventKind;
  rawType: string;
  role: string;
  preview: string;
  textBlocks: string[];
  toolUseId: string;
  parentToolUseId: string;
  toolName: string;
  toolType: string;
  toolCallId: string;
  functionName: string;
  toolArgsText: string;
  toolResultText: string;
  parentEventId: string;
  tocLabel: string;
  hasError: boolean;
  searchText: string;
  raw: Record<string, unknown>;
}

export interface TraceSummary {
  id: string;
  sourceProfile: string;
  path: string;
  agent: AgentKind;
  parser: string;
  sessionId: string;
  sizeBytes: number;
  mtimeMs: number;
  firstEventTs?: number | null;
  lastEventTs: number | null;
  eventCount: number;
  parseable: boolean;
  parseError: string;
  errorCount: number;
  toolUseCount: number;
  toolResultCount: number;
  compactionCount: number;
  lastCompactionTs: number | null;
  unmatchedToolUses: number;
  unmatchedToolResults: number;
  activityStatus: SessionActivityStatus;
  activityReason: string;
  activityBins?: number[];
  activityBinsMode?: ActivityBinsMode;
  activityWindowMinutes?: number;
  activityBinMinutes?: number;
  activityBinCount?: number;
  tokenTotals?: TokenTotals;
  modelTokenSharesTop?: ModelTokenShare[];
  modelTokenSharesEstimated?: boolean;
  contextWindowPct?: number | null;
  costEstimateUsd?: number | null;
  eventKindCounts: Record<EventKind, number>;
  residentTier: ResidentTier;
  isMaterialized: boolean;
  topTools?: NamedCount[];
}

export interface SessionDetail {
  summary: TraceSummary;
  events: NormalizedEvent[];
}

export interface RagTraceSummaryContent {
  title: string;
  userGoal: string;
  outcome: string;
  keySteps: string[];
  filesOrProjects: string[];
  toolsUsed: string[];
  errorsOrBlockers: string[];
  decisions: string[];
  workflowObservations: string[];
  followups: string[];
  searchKeywords: string[];
}

export interface RagSummaryRecord {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  parser: string;
  sourceProfile: string;
  path: string;
  firstEventTs: number | null;
  lastEventTs: number | null;
  mtimeMs: number;
  sizeBytes: number;
  eventCount: number;
  fingerprint: string;
  status: RagRefreshStatus;
  skipReason: string;
  error: string;
  summary: RagTraceSummaryContent | null;
  summaryText: string;
  summaryModel: string;
  summaryGeneratedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DailyWorkSummaryContent {
  title: string;
  windowLabel: string;
  overview: string;
  completedWork: string[];
  notableSessions: string[];
  filesOrProjects: string[];
  toolsOrWorkflows: string[];
  blockers: string[];
  followups: string[];
  searchKeywords: string[];
}

export interface DailyWorkSummaryRecord {
  id: string;
  windowStartMs: number;
  windowEndMs: number;
  scheduledAtMs: number;
  status: RagRefreshStatus;
  content: DailyWorkSummaryContent | null;
  summaryText: string;
  model: string;
  error: string;
  internalSummarySessionIds: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RagSearchResult {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  path: string;
  title: string;
  userGoal: string;
  outcome: string;
  updatedAtMs: number;
  summaryGeneratedAtMs: number | null;
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
  matchedKinds: RagDocumentKind[];
  snippets: string[];
}

export interface RagIndexStatus {
  enabled: boolean;
  dbPath: string;
  daemon: { running: boolean; pid: number | null; pidPath: string; logPath: string };
  sessions: { total: number; complete: number; pending: number; stale: number; failed: number; skipped: number };
  daily: {
    enabled: boolean;
    lastScheduledAtMs: number | null;
    lastStatus: RagRefreshStatus | null;
    lastGeneratedAtMs: number | null;
    nextRunAtMs: number | null;
  };
  documents: number;
  embeddings: {
    status: RagEmbeddingStatus;
    model: string;
    dimension: number | null;
    count: number;
    error?: string;
  };
  lastRunAtMs: number | null;
  lastRunError: string;
}

export interface RagSearchResponse {
  query: string;
  mode: RagSearchMode;
  results: RagSearchResult[];
  embeddings: RagIndexStatus["embeddings"];
}

export interface RagSummaryListResponse {
  summaries: RagSummaryRecord[];
}

export interface DailyWorkSummaryListResponse {
  reports: DailyWorkSummaryRecord[];
}

export interface RagProjectionItem {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  path: string;
  title: string;
  summaryGeneratedAtMs: number | null;
  updatedAtMs: number;
  lastEventTs: number | null;
  mtimeMs: number;
  summaryAtMs: number;
  originalTraceAtMs: number;
  x: number;
  y: number;
  clusterId: number;
}

export interface RagProjectionResponse {
  items: RagProjectionItem[];
  model: string;
  dimension: number | null;
  sourceCount: number;
  embeddedCount: number;
  missingEmbeddingCount: number;
  warnings: string[];
}

export interface AnalysisCountByAgent {
  agent: AgentKind;
  count: number;
}

export interface AnalysisSkillUsageRow {
  name: string;
  inventoryStatus: AnalysisInventoryStatus;
  explicitCount: number;
  inferredCount: number;
  totalCount: number;
  sessionCount: number;
  byAgent: AnalysisCountByAgent[];
}

export interface AnalysisSubagentUsageRow {
  name: string;
  spawnCount: number;
  sessionCount: number;
  byAgent: AnalysisCountByAgent[];
}

export interface AnalysisSourceAgentRow {
  agent: AgentKind;
  detectorSupport: AnalysisDetectorSupport;
  sessionCount: number;
  explicitSkillCount: number;
  inferredSkillCount: number;
  totalSkillCount: number;
  subagentSpawnCount: number;
}

export interface AnalysisTopSessionRow {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  path: string;
  lastEventTs: number | null;
  mtimeMs: number;
  explicitSkillCount: number;
  inferredSkillCount: number;
  subagentSpawnCount: number;
  topSkills: NamedCount[];
  topSubagents: NamedCount[];
}

export interface AnalysisInventorySummary {
  configuredSkills: string[];
  unusedConfiguredSkills: string[];
  observedUnconfiguredSkills: string[];
  skillRoots: string[];
  warnings: string[];
}

export interface AnalysisSummary {
  generatedAtMs: number;
  traceCount: number;
  supportedTraceCount: number;
  explicitSkillCount: number;
  inferredSkillCount: number;
  totalSkillCount: number;
  subagentSpawnCount: number;
  configuredSkillCount: number;
  unusedConfiguredSkillCount: number;
  observedUnconfiguredSkillCount: number;
}

export type AnalysisCacheState = "hit" | "miss" | "inflight" | "stale";

export interface AnalysisRuntimeInfo {
  cache: AnalysisCacheState;
  buildDurationMs: number;
  cacheAgeMs: number | null;
  traceCount: number;
  sinceMs: number | null;
  agent: AgentKind | null;
}

export interface AnalysisResponse {
  summary: AnalysisSummary;
  inventory: AnalysisInventorySummary;
  byAgent: AnalysisSourceAgentRow[];
  skills: AnalysisSkillUsageRow[];
  subagents: AnalysisSubagentUsageRow[];
  topSessions: AnalysisTopSessionRow[];
  runtime?: AnalysisRuntimeInfo;
}

export interface TraceTocItem {
  eventId: string;
  index: number;
  timestampMs: number | null;
  eventKind: EventKind;
  label: string;
  colorKey: string;
  toolType: string;
}

export type TraceEventPayloadMode = "full" | "compact";

export interface TracePage {
  summary: TraceSummary;
  events: NormalizedEvent[];
  toc: TraceTocItem[];
  nextBefore: string;
  liveCursor: string;
  eventPayload?: TraceEventPayloadMode;
}

export type IndexStartupPhase = "cold" | "bootstrapping" | "hydrating" | "ready" | "failed";

export interface IndexStartupStatus {
  phase: IndexStartupPhase;
  inspectorReady: boolean;
  fullReady: boolean;
  isPartial: boolean;
  discoveredTraceCount: number;
  hydratedTraceCount: number;
  startupError?: string;
}

export type TraceIndexStartupState = IndexStartupStatus;

export interface ActivityHydrationProgress {
  ready: boolean;
  relevantDiscoveredCount: number;
  relevantHydratedCount: number;
  percent: number;
}

export type LiveDeltaType =
  | "trace_added"
  | "trace_updated"
  | "trace_removed"
  | "events_appended"
  | "overview_updated";

export interface LiveEnvelopeBase<TType extends string, TPayload> {
  id: string;
  type: TType;
  version: number;
  payload: TPayload;
}

export type TraceUpsertLiveEnvelope = LiveEnvelopeBase<
  "trace_added" | "trace_updated",
  { summary: TraceSummary }
>;

export type TraceRemovedLiveEnvelope = LiveEnvelopeBase<"trace_removed", { id: string }>;

export type EventsAppendedLiveEnvelope = LiveEnvelopeBase<
  "events_appended",
  { id: string; appended: number; latestEvents?: NormalizedEvent[] }
>;

export type OverviewUpdatedLiveEnvelope = LiveEnvelopeBase<
  "overview_updated",
  { overview: OverviewStats; startup: IndexStartupStatus }
>;

export type LiveDeltaEnvelope =
  | TraceUpsertLiveEnvelope
  | TraceRemovedLiveEnvelope
  | EventsAppendedLiveEnvelope
  | OverviewUpdatedLiveEnvelope;

export type LiveBatchEnvelope = LiveEnvelopeBase<"batch", { events: LiveDeltaEnvelope[] }>;

export interface AgentActivityBin {
  startMs: number;
  endMs: number;
  activeSessionCount: number;
  heatmapValue: number;
  heatmapValues?: ActivityHeatmapMetricValues;
  activeTraceIds: string[];
  primaryTraceId: string;
  activeByAgent: Record<AgentKind, number>;
  eventCount: number;
  eventKindCounts: Record<EventKind, number>;
  dominantAgent: AgentKind | "none";
  dominantEventKind: EventKind | "none";
  isBreak: boolean;
}

export interface ActivityHeatmapPresentation {
  metric: ActivityHeatmapMetric;
  color: string;
  palette: [string, string, string, string, string];
}

export interface ActivityHeatmapMetricValues {
  sessions: number;
  output_tokens: number;
  total_cost_usd: number;
}

export interface AgentActivityDay {
  dateLocal: string;
  tzOffsetMinutes: number;
  binMinutes: number;
  breakMinutes: number;
  windowStartMs: number;
  windowEndMs: number;
  totalSessionsInWindow: number;
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
  totalEventCount: number;
  bins: AgentActivityBin[];
}

export interface AgentActivityWeekDay {
  dateLocal: string;
  windowStartMs: number;
  windowEndMs: number;
  totalSessionsInWindow: number;
  heatmapValue: number;
  heatmapValues?: ActivityHeatmapMetricValues;
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
  totalEventCount: number;
  bins: AgentActivityBin[];
}

export interface AgentActivityWeek {
  presentation: ActivityHeatmapPresentation;
  tzOffsetMinutes: number;
  dayCount: number;
  slotMinutes: number;
  hourStartLocal: number;
  hourEndLocal: number;
  startDateLocal: string;
  endDateLocal: string;
  days: AgentActivityWeekDay[];
  usageSummary?: ActivityUsageSummary;
}

export interface ActivityUsageSummaryRow {
  agent: AgentKind;
  sessionHours: number;
  sessionSharePct: number;
  uniqueSessions: number;
  activeSlots: number;
  activeDays: number;
  peakConcurrentSessions: number;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
}

export interface ActivityUsageSummaryTotals {
  totalUniqueSessions: number;
  totalSessionHours: number;
  peakAllAgentConcurrency: number;
  mostUsedAgent: AgentKind | null;
}

export interface ActivityUsageSummary {
  rows: ActivityUsageSummaryRow[];
  totals: ActivityUsageSummaryTotals;
}

export interface AgentActivityYearDay {
  dateLocal: string;
  windowStartMs: number;
  windowEndMs: number;
  totalSessionsInWindow: number;
  heatmapValue: number;
  heatmapValues?: ActivityHeatmapMetricValues;
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
  totalEventCount: number;
}

export interface AgentActivityYear {
  presentation: ActivityHeatmapPresentation;
  tzOffsetMinutes: number;
  dayCount: number;
  startDateLocal: string;
  endDateLocal: string;
  days: AgentActivityYearDay[];
  usageSummary: ActivityUsageSummary;
}

export interface OverviewStats {
  traceCount: number;
  sessionCount: number;
  eventCount: number;
  errorCount: number;
  toolUseCount: number;
  toolResultCount: number;
  byAgent: Record<string, number>;
  byEventKind: Record<EventKind, number>;
  updatedAtMs: number;
}

export interface IndexPerformanceStats {
  refreshCount: number;
  fullRefreshCount: number;
  dirtyRefreshCount: number;
  idleRefreshCount: number;
  parsedFileCount: number;
  incrementalAppendCount: number;
  fullReparseCount: number;
  lastRefreshDurationMs: number;
  lastRefreshAtMs: number;
  averageRefreshDurationMs: number;
  watcherRoots: number;
  trackedFiles: number;
  dirtyPathQueue: number;
  hotTraces: number;
  warmTraces: number;
  coldTraces: number;
  materializedTraces: number;
}

export interface StreamEnvelope {
  id: string;
  type:
    | "snapshot"
    | "trace_added"
    | "trace_updated"
    | "trace_removed"
    | "events_appended"
    | "overview_updated"
    | "heartbeat";
  version: number;
  payload: Record<string, unknown>;
}
