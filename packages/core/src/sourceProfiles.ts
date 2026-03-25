import type { AppConfig, SessionLogDirectoryConfig, SourceProfileConfig } from "@agentlens/contracts";
import { DEFAULT_CONTEXT_WINDOWS, DEFAULT_PRICING_MODEL_RATES } from "./generatedPricing.js";

export const DEFAULT_SESSION_LOG_DIRECTORIES: SessionLogDirectoryConfig[] = [
  { directory: "~/.codex", logType: "codex" },
  { directory: "~/.claude", logType: "claude" },
  { directory: "~/.cursor", logType: "cursor" },
  { directory: "~/.gemini", logType: "gemini" },
  { directory: "~/.pi", logType: "pi" },
  { directory: "~/.local/share/opencode", logType: "opencode" },
];

export const DEFAULT_SOURCE_PROFILES: Record<string, SourceProfileConfig> = {
  codex_home: {
    name: "codex_home",
    enabled: true,
    roots: ["~/.codex/sessions"],
    includeGlobs: ["**/*.jsonl"],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "codex",
  },
  claude_projects: {
    name: "claude_projects",
    enabled: true,
    roots: ["~/.claude/projects"],
    includeGlobs: ["**/*.jsonl"],
    excludeGlobs: ["**/subagents/agent-acompact-*.jsonl"],
    maxDepth: 8,
    agentHint: "claude",
  },
  claude_history: {
    name: "claude_history",
    enabled: true,
    roots: ["~/.claude"],
    includeGlobs: ["history.jsonl"],
    excludeGlobs: [],
    maxDepth: 2,
    agentHint: "claude",
  },
  cursor_agent_transcripts: {
    name: "cursor_agent_transcripts",
    enabled: true,
    roots: ["~/.cursor/projects"],
    includeGlobs: ["**/agent-transcripts/*.txt", "**/agent-transcripts/*.jsonl"],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "cursor",
  },
  opencode_storage_session: {
    name: "opencode_storage_session",
    enabled: true,
    roots: ["~/.local/share/opencode/storage/session"],
    includeGlobs: ["**/*.json"],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "opencode",
  },
  gemini_tmp: {
    name: "gemini_tmp",
    enabled: true,
    roots: ["~/.gemini/tmp"],
    includeGlobs: ["**/chats/session-*.json", "**/*.jsonl"],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "gemini",
  },
  pi_agent_sessions: {
    name: "pi_agent_sessions",
    enabled: true,
    roots: ["~/.pi/agent/sessions"],
    includeGlobs: ["**/*.jsonl"],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "pi",
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  scan: {
    mode: "adaptive",
    intervalSeconds: 2,
    intervalMinMs: 200,
    intervalMaxMs: 3000,
    fullRescanIntervalMs: 900_000,
    batchDebounceMs: 120,
    recentEventWindow: 400,
    includeMetaDefault: true,
    statusRunningTtlMs: 20_000,
    statusWaitingTtlMs: 1_800_000,
  },
  retention: {
    strategy: "aggressive_recency",
    hotTraceCount: 60,
    warmTraceCount: 240,
    maxResidentEventsPerHotTrace: 1200,
    maxResidentEventsPerWarmTrace: 120,
    detailLoadMode: "lazy_from_disk",
  },
  sessionLogDirectories: DEFAULT_SESSION_LOG_DIRECTORIES,
  sources: DEFAULT_SOURCE_PROFILES,
  traceInspector: {
    includeMetaDefault: false,
    topModelCount: 3,
    showAgentBadges: true,
    showHealthDiagnostics: false,
  },
  activityHeatmap: {
    metric: "sessions",
    color: "#dc2626",
  },
  redaction: {
    mode: "strict",
    alwaysOn: true,
    replacement: "[REDACTED]",
    keyPattern:
      "(?i)(api[_-]?key|token|secret|password|passphrase|private[_-]?key|access[_-]?key|auth|credential|session|cookie)",
    valuePattern:
      "(?i)(sk-[a-z0-9_-]+|ghp_[a-z0-9]+|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\\-_]{20,}|xox[baprs]-[A-Za-z0-9-]+|-----BEGIN [A-Z ]+ PRIVATE KEY-----)",
  },
  cost: {
    enabled: true,
    currency: "USD",
    unknownModelPolicy: "n_a",
    modelRates: DEFAULT_PRICING_MODEL_RATES,
  },
  models: {
    defaultContextWindowTokens: 200_000,
    contextWindows: DEFAULT_CONTEXT_WINDOWS,
  },
};
