import type { AppConfig, SessionLogDirectoryConfig, SourceProfileConfig } from "@agentlens/contracts";

export const DEFAULT_SESSION_LOG_DIRECTORIES: SessionLogDirectoryConfig[] = [
  { directory: "~/.codex", logType: "codex" },
  { directory: "~/.claude", logType: "claude" },
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
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "claude",
  },
  claude_history: {
    name: "claude_history",
    enabled: false,
    roots: ["~/.claude"],
    includeGlobs: ["history.jsonl"],
    excludeGlobs: [],
    maxDepth: 2,
    agentHint: "claude",
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  scan: {
    intervalSeconds: 2,
    recentEventWindow: 400,
    includeMetaDefault: true,
    statusRunningTtlMs: 20_000,
    statusWaitingTtlMs: 1_800_000,
  },
  sessionLogDirectories: DEFAULT_SESSION_LOG_DIRECTORIES,
  sources: DEFAULT_SOURCE_PROFILES,
};
