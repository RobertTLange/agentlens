export type AgentKind = "claude" | "codex" | "cursor" | "opencode" | "unknown";

export type EventKind =
  | "system"
  | "assistant"
  | "user"
  | "tool_use"
  | "tool_result"
  | "reasoning"
  | "meta";

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
  };
  sessionLogDirectories: SessionLogDirectoryConfig[];
  sources: Record<string, SourceProfileConfig>;
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
  lastEventTs: number | null;
  eventCount: number;
  parseable: boolean;
  parseError: string;
  errorCount: number;
  toolUseCount: number;
  toolResultCount: number;
  unmatchedToolUses: number;
  unmatchedToolResults: number;
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
