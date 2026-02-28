import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../config.js";
import { TraceIndex } from "../traceIndex.js";

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentlens-core-compaction-"));
}

describe("compaction regression coverage", () => {
  it("tracks compaction count and last compaction timestamp in session summary", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "28");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "compaction-summary.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-28T09:06:40.000Z",
        type: "session_meta",
        payload: { id: "sess-compaction", cwd: "/tmp/project", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-28T09:06:42.000Z",
        type: "compacted",
        payload: { message: "Context compacted by agent", replacement_history: [] },
      }),
      JSON.stringify({
        timestamp: "2026-02-28T09:06:45.255Z",
        type: "event_msg",
        payload: { type: "context_compacted", message: "Auto compaction complete" },
      }),
    ];
    await writeFile(codexPath, lines.join("\n"), "utf8");

    const config = mergeConfig({
      sessionLogDirectories: [],
      sources: {
        codex_home: {
          name: "codex_home",
          enabled: true,
          roots: [path.join(root, ".codex", "sessions")],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.sessionId).toBe("sess-compaction");
    expect(summary?.compactionCount).toBe(2);
    expect(summary?.lastCompactionTs).toBe(Date.parse("2026-02-28T09:06:45.255Z"));
    expect(summary?.eventKindCounts.compaction).toBe(2);
  });

  it("ignores claude compact sidechain logs discovered from sessionLogDirectories", async () => {
    const root = await createTempRoot();
    const sessionDir = path.join(root, ".claude", "projects", "proj", "session-1");
    await mkdir(path.join(sessionDir, "subagents"), { recursive: true });

    const mainSessionPath = path.join(sessionDir, "session.jsonl");
    const compactSidechainPath = path.join(sessionDir, "subagents", "agent-acompact-90240fc4860d3bb9.jsonl");

    await writeFile(
      mainSessionPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "claude-main-session",
        timestamp: "2026-02-28T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Main session event" }],
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      compactSidechainPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "claude-compaction-sidechain",
        timestamp: "2026-02-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Sidechain compact event" }],
        },
      })}\n`,
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: path.join(root, ".claude"), logType: "claude" }],
      sources: {},
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summaries = index.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionId).toBe("claude-main-session");
    expect(summaries[0]?.path).toContain(path.sep + "session.jsonl");
    expect(summaries[0]?.path).not.toContain(`subagents${path.sep}agent-acompact-`);
  });

  it("excludes claude compact sidechain logs in source profile discovery", async () => {
    const root = await createTempRoot();
    const sessionDir = path.join(root, ".claude", "projects", "proj", "session-2");
    await mkdir(path.join(sessionDir, "subagents"), { recursive: true });

    const mainSessionPath = path.join(sessionDir, "session.jsonl");
    const compactSidechainPath = path.join(sessionDir, "subagents", "agent-acompact-fedcba123456.jsonl");

    await writeFile(
      mainSessionPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "claude-source-main-session",
        timestamp: "2026-02-28T11:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Main source-profile session event" }],
        },
      })}\n`,
      "utf8",
    );
    await writeFile(
      compactSidechainPath,
      `${JSON.stringify({
        type: "assistant",
        sessionId: "claude-source-sidechain",
        timestamp: "2026-02-28T11:01:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Sidechain source-profile event" }],
        },
      })}\n`,
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [],
      sources: {
        claude_projects: {
          name: "claude_projects",
          enabled: true,
          roots: [path.join(root, ".claude", "projects")],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: ["**/subagents/agent-acompact-*.jsonl"],
          maxDepth: 8,
          agentHint: "claude",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summaries = index.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionId).toBe("claude-source-main-session");
    expect(summaries[0]?.path).toContain(path.sep + "session.jsonl");
    expect(summaries[0]?.path).not.toContain(`subagents${path.sep}agent-acompact-`);
  });
});
