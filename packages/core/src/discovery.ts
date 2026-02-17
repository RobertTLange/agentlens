import { stat } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { AgentKind, AppConfig } from "@agentlens/contracts";
import { expandHome, stableId } from "./utils.js";

export interface DiscoveredTraceFile {
  id: string;
  path: string;
  sourceProfile: string;
  agentHint: AgentKind;
  parserHint?: AgentKind;
  sizeBytes: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}

async function discoverProfile(config: AppConfig, profileName: string): Promise<DiscoveredTraceFile[]> {
  const profile = config.sources[profileName];
  if (!profile || !profile.enabled) {
    return [];
  }

  const files: DiscoveredTraceFile[] = [];
  for (const rootRaw of profile.roots) {
    const root = expandHome(rootRaw);
    const matches = await fg(profile.includeGlobs, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      dot: true,
      deep: profile.maxDepth,
      suppressErrors: true,
      ignore: profile.excludeGlobs,
      unique: true,
      followSymbolicLinks: false,
    });

    for (const filePath of matches) {
      try {
        const fileStat = await stat(filePath);
        const id = stableId([filePath, String(fileStat.dev), String(fileStat.ino)]);
        files.push({
          id,
          path: path.resolve(filePath),
          sourceProfile: profileName,
          agentHint: profile.agentHint ?? "unknown",
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ino: Number(fileStat.ino),
          dev: Number(fileStat.dev),
        });
      } catch {
        // ignore stale files
      }
    }
  }

  return files;
}

async function discoverSessionLogDirectories(config: AppConfig): Promise<DiscoveredTraceFile[]> {
  const hasPathSegment = (input: string, segment: string): boolean =>
    path
      .normalize(input)
      .split(path.sep)
      .some((part) => part.toLowerCase() === segment.toLowerCase());

  const includeGlobsForSessionDirectory = (root: string, logType: AgentKind): string[] => {
    if (logType === "codex") {
      return hasPathSegment(root, "sessions") ? ["**/*.jsonl"] : ["sessions/**/*.jsonl"];
    }
    if (logType === "claude") {
      return hasPathSegment(root, "projects") ? ["**/*.jsonl"] : ["projects/**/*.jsonl"];
    }
    if (logType === "cursor") {
      if (hasPathSegment(root, "agent-transcripts")) {
        return ["**/*.txt"];
      }
      if (hasPathSegment(root, "projects")) {
        return ["**/agent-transcripts/*.txt"];
      }
      return ["projects/**/agent-transcripts/*.txt"];
    }
    if (logType === "opencode") {
      if (hasPathSegment(root, "storage")) {
        return hasPathSegment(root, "session") ? ["**/*.json"] : ["session/**/*.json"];
      }
      return ["storage/session/**/*.json"];
    }
    return ["**/*.jsonl"];
  };

  const files: DiscoveredTraceFile[] = [];
  for (const entry of config.sessionLogDirectories) {
    const root = expandHome(entry.directory);
    const collectMatches = async (includeGlobs: string[]): Promise<string[]> => {
      if (includeGlobs.length === 0) return [];
      return fg(includeGlobs, {
        cwd: root,
        absolute: true,
        onlyFiles: true,
        dot: true,
        deep: 12,
        suppressErrors: true,
        unique: true,
        followSymbolicLinks: false,
      });
    };

    let matches: string[] = [];
    if (entry.logType === "opencode") {
      const sessionGlobs = (() => {
        if (hasPathSegment(root, "storage")) {
          if (hasPathSegment(root, "session")) return ["**/*.json"];
          return ["session/**/*.json"];
        }
        return ["storage/session/**/*.json"];
      })();
      const sessionDiffGlobs = (() => {
        if (hasPathSegment(root, "storage")) {
          if (hasPathSegment(root, "session_diff")) return ["**/*.json"];
          return ["session_diff/**/*.json"];
        }
        return ["storage/session_diff/**/*.json"];
      })();

      const sessionMatches = await collectMatches(sessionGlobs);
      const discoveredSessionIds = new Set(
        sessionMatches
          .map((filePath) => path.basename(filePath, path.extname(filePath)).trim())
          .filter((value) => value.length > 0),
      );

      const sessionDiffMatches = await collectMatches(sessionDiffGlobs);
      const filteredSessionDiffMatches = sessionDiffMatches.filter((filePath) => {
        const sessionId = path.basename(filePath, path.extname(filePath)).trim();
        if (!sessionId) return false;
        return !discoveredSessionIds.has(sessionId);
      });

      matches = [...sessionMatches, ...filteredSessionDiffMatches];
    } else {
      matches = await collectMatches(includeGlobsForSessionDirectory(root, entry.logType));
    }

    for (const filePath of matches) {
      try {
        const fileStat = await stat(filePath);
        const id = stableId([filePath, String(fileStat.dev), String(fileStat.ino)]);
        files.push({
          id,
          path: path.resolve(filePath),
          sourceProfile: "session_log",
          agentHint: entry.logType,
          parserHint: entry.logType,
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ino: Number(fileStat.ino),
          dev: Number(fileStat.dev),
        });
      } catch {
        // ignore stale files
      }
    }
  }
  return files;
}

export async function discoverTraceFiles(config: AppConfig): Promise<DiscoveredTraceFile[]> {
  const dedup = new Map<string, DiscoveredTraceFile>();
  const sessionLogFiles = await discoverSessionLogDirectories(config);
  for (const file of sessionLogFiles) {
    dedup.set(file.id, file);
  }

  const names = Object.keys(config.sources).sort();
  for (const name of names) {
    const profileFiles = await discoverProfile(config, name);
    for (const file of profileFiles) {
      if (!dedup.has(file.id)) {
        dedup.set(file.id, file);
      }
    }
  }
  const all = Array.from(dedup.values());
  all.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
  return all;
}
