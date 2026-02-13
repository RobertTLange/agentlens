export type AgentKind = "claude" | "codex" | "unknown";

export type EventKind =
  | "system"
  | "assistant"
  | "user"
  | "tool_use"
  | "tool_result"
  | "reasoning"
  | "meta";

export type SessionActivityStatus = "running" | "waiting_input" | "idle";
export type ActivityBinsMode = "time" | "event_index";
export type CostUnknownModelPolicy = "n_a" | "zero";

export interface TraceInspectorConfig {
  includeMetaDefault: boolean;
  topModelCount: number;
  showAgentBadges: boolean;
  showHealthDiagnostics: boolean;
}

export interface RedactionConfig {
  mode: "strict" | "off";
  alwaysOn: boolean;
  replacement: string;
  keyPattern: string;
  valuePattern: string;
}

export interface CostModelRate {
  model: string;
  inputPer1MUsd: number;
  outputPer1MUsd: number;
  cachedReadPer1MUsd: number;
  cachedCreatePer1MUsd: number;
  reasoningOutputPer1MUsd: number;
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
  scan: {
    intervalSeconds: number;
    recentEventWindow: number;
    includeMetaDefault: boolean;
    statusRunningTtlMs: number;
    statusWaitingTtlMs: number;
  };
  sessionLogDirectories: SessionLogDirectoryConfig[];
  sources: Record<string, SourceProfileConfig>;
  traceInspector: TraceInspectorConfig;
  redaction: RedactionConfig;
  cost: CostConfig;
  models: ModelsConfig;
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
}

export interface SessionDetail {
  summary: TraceSummary;
  events: NormalizedEvent[];
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

export interface TracePage {
  summary: TraceSummary;
  events: NormalizedEvent[];
  toc: TraceTocItem[];
  nextBefore: string;
  liveCursor: string;
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
