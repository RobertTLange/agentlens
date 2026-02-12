import type { AppConfig, SessionLogDirectoryConfig, SourceProfileConfig } from "@agentlens/contracts";

export const DEFAULT_SESSION_LOG_DIRECTORIES: SessionLogDirectoryConfig[] = [
  { directory: "~/.codex", logType: "codex" },
  { directory: "~/.claude", logType: "claude" },
  { directory: "~/.opencode", logType: "opencode" },
  { directory: "~/.cursor", logType: "cursor" },
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
  cursor_home: {
    name: "cursor_home",
    enabled: true,
    roots: ["~/.cursor"],
    includeGlobs: ["**/*.jsonl", "**/worker.log", "prompt_history.json"],
    excludeGlobs: [
      "**/extensions/**",
      "**/Cache/**",
      "**/CachedData/**",
      "**/workspaceStorage/**",
      "**/*.vscdb",
      "**/*.vscdb-*",
    ],
    maxDepth: 8,
    agentHint: "cursor",
  },
  opencode_home: {
    name: "opencode_home",
    enabled: true,
    roots: ["~/.opencode"],
    includeGlobs: ["**/*.jsonl", "**/*.log"],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: "opencode",
  },
};

export const DEFAULT_CONFIG: AppConfig = {
  scan: {
    intervalSeconds: 2,
    recentEventWindow: 400,
    includeMetaDefault: true,
    statusRunningTtlMs: 120_000,
    statusWaitingTtlMs: 3_600_000,
  },
  sessionLogDirectories: DEFAULT_SESSION_LOG_DIRECTORIES,
  sources: DEFAULT_SOURCE_PROFILES,
};
