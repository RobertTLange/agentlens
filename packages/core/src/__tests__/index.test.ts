import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../config.js";
import { TraceIndex } from "../traceIndex.js";

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentlens-core-"));
}

describe("trace index", () => {
  it("defaults sessionLogDirectories to common agent homes with explicit log types", () => {
    const config = mergeConfig();
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.codex", logType: "codex" },
      { directory: "~/.claude", logType: "claude" },
      { directory: "~/.opencode", logType: "opencode" },
      { directory: "~/.cursor", logType: "cursor" },
    ]);
  });

  it("allows overriding sessionLogDirectories with an empty list", () => {
    const config = mergeConfig({ sessionLogDirectories: [] });
    expect(config.sessionLogDirectories).toEqual([]);
  });

  it("maps legacy sessionJsonlDirectories to typed entries for backwards compatibility", () => {
    const config = mergeConfig({ sessionJsonlDirectories: ["~/.codex", "~/custom-logs"] });
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.codex", logType: "codex" },
      { directory: "~/custom-logs", logType: "unknown" },
    ]);
  });

  it("parses codex home session files and computes overview", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "11");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "rollout-test.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "sess-1", cwd: "/tmp/project", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "build app" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_1",
          name: "run_command",
          call_id: "call_1",
          arguments: "{\"command\":\"echo hi\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "hi",
        },
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
        claude_projects: {
          name: "claude_projects",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        claude_history: {
          name: "claude_history",
          enabled: false,
          roots: [],
          includeGlobs: ["history.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        cursor_home: {
          name: "cursor_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_home: {
          name: "opencode_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const overview = index.getOverview();
    expect(overview.traceCount).toBe(1);
    expect(overview.eventCount).toBeGreaterThanOrEqual(2);

    const summaries = index.getSummaries();
    expect(summaries[0]?.agent).toBe("codex");
    expect(summaries[0]?.sessionId).toBe("sess-1");
    expect(summaries[0]?.eventCount).toBe(5);
    expect(summaries[0]?.toolUseCount).toBe(1);
    expect(summaries[0]?.toolResultCount).toBe(1);

    const detail = index.getSessionDetail(summaries[0]!.id);
    const toolUseEvent = detail.events.find((event) => event.eventKind === "tool_use") as
      | { toolName: string; functionName?: string; toolCallId?: string; toolArgsText?: string }
      | undefined;
    expect(toolUseEvent?.toolName).toBe("run_command");
    expect(toolUseEvent?.functionName).toBe("run_command");
    expect(toolUseEvent?.toolCallId).toBe("call_1");
    expect(toolUseEvent?.toolArgsText).toContain("echo hi");
  });

  it("parses claude project logs with tool_use/tool_result typing", async () => {
    const root = await createTempRoot();
    const claudeDir = path.join(root, ".claude", "projects", "proj");
    await mkdir(claudeDir, { recursive: true });

    const claudePath = path.join(claudeDir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        sessionId: "claude-session",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "echo hi" },
            },
            { type: "text", text: "running tool" },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "claude-session",
        uuid: "u1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              is_error: false,
              content: [{ type: "text", text: "hi" }],
            },
          ],
        },
      }),
    ];

    await writeFile(claudePath, lines.join("\n"), "utf8");

    const config = mergeConfig({
      sessionLogDirectories: [],
      sources: {
        claude_projects: {
          name: "claude_projects",
          enabled: true,
          roots: [path.join(root, ".claude", "projects")],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        codex_home: {
          name: "codex_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
        claude_history: {
          name: "claude_history",
          enabled: false,
          roots: [],
          includeGlobs: ["history.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        cursor_home: {
          name: "cursor_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_home: {
          name: "opencode_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.agent).toBe("claude");
    expect(summary?.toolUseCount).toBe(1);
    expect(summary?.toolResultCount).toBe(1);

    const detail = index.getSessionDetail(summary!.id);
    expect(detail.events.map((event) => event.eventKind)).toEqual(["tool_use", "assistant", "tool_result"]);

    const toolUseEvent = detail.events[0] as {
      toolName: string;
      toolArgsText?: string;
      toolCallId?: string;
      tocLabel?: string;
      parentEventId?: string;
    };
    expect(toolUseEvent.toolName).toBe("Bash");
    expect(toolUseEvent.toolArgsText).toContain("echo hi");
    expect(toolUseEvent.toolCallId).toBe("toolu_1");
    expect(toolUseEvent.tocLabel).toBe("Tool: Bash");
    expect(toolUseEvent.parentEventId).toBe("a1");

    const toolResultEvent = detail.events[2] as { toolResultText?: string; toolCallId?: string };
    expect(toolResultEvent.toolCallId).toBe("toolu_1");
    expect(toolResultEvent.toolResultText).toContain("hi");

    const page = index.getTracePage(summary!.id, { includeMeta: true, limit: 10 }) as unknown as {
      toc?: Array<{ label: string; eventKind: string }>;
    };
    expect(page.toc?.length).toBe(3);
    expect(page.toc?.[0]?.label).toBe("Tool: Bash");
    expect(page.toc?.[2]?.eventKind).toBe("tool_result");
  });

  it("parses unix epoch ts fields for trace start and updated timestamps", async () => {
    const root = await createTempRoot();
    const sessionRoot = path.join(root, "custom-session-root");
    const sessionDir = path.join(sessionRoot, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const historyPath = path.join(sessionDir, "history.jsonl");
    await writeFile(
      historyPath,
      [
        JSON.stringify({ session_id: "sess-ts", ts: 1_769_000_000, text: "first" }),
        JSON.stringify({ session_id: "sess-ts", ts: "1769000120", text: "last" }),
      ].join("\n"),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: sessionRoot, logType: "codex" }],
      sources: {
        codex_home: {
          name: "codex_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
        claude_projects: {
          name: "claude_projects",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        claude_history: {
          name: "claude_history",
          enabled: false,
          roots: [],
          includeGlobs: ["history.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        cursor_home: {
          name: "cursor_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_home: {
          name: "opencode_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.firstEventTs).toBe(1_769_000_000_000);
    expect(summary?.lastEventTs).toBe(1_769_000_120_000);
  });

  it("uses file order for first/last event timestamps", async () => {
    const root = await createTempRoot();
    const sessionRoot = path.join(root, "custom-session-root");
    const sessionDir = path.join(sessionRoot, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const historyPath = path.join(sessionDir, "history.jsonl");
    await writeFile(
      historyPath,
      [
        JSON.stringify({ session_id: "sess-order", ts: 1_769_000_200, text: "first row" }),
        JSON.stringify({ session_id: "sess-order", ts: 1_769_000_100, text: "second row" }),
      ].join("\n"),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: sessionRoot, logType: "codex" }],
      sources: {
        codex_home: {
          name: "codex_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
        claude_projects: {
          name: "claude_projects",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        claude_history: {
          name: "claude_history",
          enabled: false,
          roots: [],
          includeGlobs: ["history.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        cursor_home: {
          name: "cursor_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_home: {
          name: "opencode_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.firstEventTs).toBe(1_769_000_200_000);
    expect(summary?.lastEventTs).toBe(1_769_000_100_000);
  });

  it("indexes JSONL sessions from configured sessionLogDirectories with explicit parser type", async () => {
    const root = await createTempRoot();
    const sessionRoot = path.join(root, "custom-session-root");
    const codexDir = path.join(sessionRoot, "sessions", "2026", "02", "12");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "custom-session.jsonl");
    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "custom-sess-1" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from custom root" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(sessionRoot, "history.jsonl"),
      JSON.stringify({ session_id: "history-should-not-index", ts: 1_769_500_000, text: "do not include" }),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: sessionRoot, logType: "codex" }],
      sources: {
        codex_home: {
          name: "codex_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
        claude_projects: {
          name: "claude_projects",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        claude_history: {
          name: "claude_history",
          enabled: false,
          roots: [],
          includeGlobs: ["history.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        cursor_home: {
          name: "cursor_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_home: {
          name: "opencode_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.sessionId).toBe("custom-sess-1");
    expect(summary?.agent).toBe("codex");
    expect(summary?.sourceProfile).toBe("session_log");
    expect(summary?.parser).toBe("codex");
    expect(index.getSummaries().some((item) => item.path.endsWith("/history.jsonl"))).toBe(false);
  });
});
