import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
      { directory: "~/.cursor", logType: "cursor" },
      { directory: "~/.gemini", logType: "gemini" },
      { directory: "~/.pi", logType: "pi" },
      { directory: "~/.local/share/opencode", logType: "opencode" },
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
      { directory: "~/.cursor", logType: "cursor" },
      { directory: "~/.gemini", logType: "gemini" },
      { directory: "~/.pi", logType: "pi" },
    ]);
  });

  it("auto-injects cursor, gemini, and pi session directories for legacy typed configs", () => {
    const config = mergeConfig({
      sessionLogDirectories: [
        { directory: "~/.codex", logType: "codex" },
        { directory: "~/.claude", logType: "claude" },
      ],
    });
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.codex", logType: "codex" },
      { directory: "~/.claude", logType: "claude" },
      { directory: "~/.cursor", logType: "cursor" },
      { directory: "~/.gemini", logType: "gemini" },
      { directory: "~/.pi", logType: "pi" },
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
          name: "exec_command",
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
    expect(summaries[0]?.residentTier).toBeTypeOf("string");
    expect(typeof summaries[0]?.isMaterialized).toBe("boolean");
    expect(index.getTopTools(3)[0]).toEqual({ name: "exec_command", count: 1 });
    expect(index.getPerformanceStats().refreshCount).toBeGreaterThan(0);

    const detail = index.getSessionDetail(summaries[0]!.id);
    const toolUseEvent = detail.events.find((event) => event.eventKind === "tool_use") as
      | { toolName: string; toolType?: string; functionName?: string; toolCallId?: string; toolArgsText?: string }
      | undefined;
    expect(toolUseEvent?.toolName).toBe("exec_command");
    expect(toolUseEvent?.functionName).toBe("exec_command");
    expect(toolUseEvent?.toolType).toBe("bash");
    expect(toolUseEvent?.toolCallId).toBe("call_1");
    expect(toolUseEvent?.toolArgsText).toContain("echo hi");

    const toolResultEvent = detail.events.find((event) => event.eventKind === "tool_result") as
      | { toolCallId?: string; toolType?: string }
      | undefined;
    expect(toolResultEvent?.toolCallId).toBe("call_1");
    expect(toolResultEvent?.toolType).toBe("bash");
  });

  it("parses cursor agent transcripts from .cursor projects", async () => {
    const root = await createTempRoot();
    const transcriptDir = path.join(root, ".cursor", "projects", "project-a", "agent-transcripts");
    await mkdir(transcriptDir, { recursive: true });

    const transcriptPath = path.join(transcriptDir, "cursor-session-1.txt");
    const transcript = [
      "user:",
      "<user_query>",
      "add cursor parser",
      "</user_query>",
      "",
      "assistant:",
      "[Thinking] Need parser + discovery updates.",
      "[Tool call] Read",
      "  path: packages/core/src/parsers/index.ts",
      "[Tool result] Read",
      "",
      "Implemented parser wiring and tests.",
    ].join("\n");
    await writeFile(transcriptPath, transcript, "utf8");

    const config = mergeConfig({
      sessionLogDirectories: [],
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
        cursor_agent_transcripts: {
          name: "cursor_agent_transcripts",
          enabled: true,
          roots: [path.join(root, ".cursor", "projects")],
          includeGlobs: ["**/agent-transcripts/*.txt", "**/agent-transcripts/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
        gemini_tmp: {
          name: "gemini_tmp",
          enabled: false,
          roots: [],
          includeGlobs: ["**/chats/session-*.json", "**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "gemini",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summaries = index.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.agent).toBe("cursor");
    expect(summaries[0]?.parser).toBe("cursor");
    expect(summaries[0]?.sessionId).toBe("cursor-session-1");
    expect(summaries[0]?.eventCount).toBeGreaterThanOrEqual(4);
    expect(summaries[0]?.toolUseCount).toBe(1);
    expect(summaries[0]?.toolResultCount).toBe(1);
    expect((summaries[0]?.tokenTotals?.inputTokens ?? 0) > 0).toBe(true);
    expect((summaries[0]?.tokenTotals?.outputTokens ?? 0) > 0).toBe(true);
    expect((summaries[0]?.tokenTotals?.totalTokens ?? 0) > 0).toBe(true);
  });

  it("parses gemini chat sessions and derives token metrics", async () => {
    const root = await createTempRoot();
    const geminiHome = path.join(root, ".gemini");
    const chatsDir = path.join(
      geminiHome,
      "tmp",
      "31961e5d2f9bdd62bbd56b581966e1a817d9d362afc8a1be751cf476cfdb454d",
      "chats",
    );
    await mkdir(chatsDir, { recursive: true });

    const sessionPath = path.join(chatsDir, "session-2026-02-17T01-07-50641617.json");
    await writeFile(
      sessionPath,
      JSON.stringify(
        {
          sessionId: "50641617-dd96-45e6-9649-0b711b8073ae",
          projectHash: "31961e5d2f9bdd62bbd56b581966e1a817d9d362afc8a1be751cf476cfdb454d",
          startTime: "2026-02-17T09:45:49.345Z",
          lastUpdated: "2026-02-17T09:45:57.249Z",
          messages: [
            {
              id: "u1",
              timestamp: "2026-02-17T09:45:49.345Z",
              type: "user",
              content: [{ text: "how is the weather in berlin today?" }],
            },
            {
              id: "a1",
              timestamp: "2026-02-17T09:45:55.244Z",
              type: "gemini",
              content: "",
              toolCalls: [
                {
                  id: "google_web_search-1",
                  name: "google_web_search",
                  args: { query: "weather in Berlin on February 17, 2026" },
                  result: [
                    {
                      functionResponse: {
                        id: "google_web_search-1",
                        name: "google_web_search",
                        response: { output: "Cloudy, around -2C with a chance of snow." },
                      },
                    },
                  ],
                  status: "success",
                },
              ],
              thoughts: [{ text: "I should call web search first." }],
              model: "gemini-3-flash-preview",
              tokens: {
                input: 12204,
                output: 31,
                cached: 0,
                thoughts: 93,
                tool: 0,
                total: 12328,
              },
            },
            {
              id: "a2",
              timestamp: "2026-02-17T09:45:57.249Z",
              type: "gemini",
              content: "Cloudy and cold, around -2C.",
              thoughts: [{ text: "Summarize result for user." }],
              model: "gemini-3-flash-preview",
              tokens: {
                input: 12727,
                output: 48,
                cached: 0,
                thoughts: 42,
                tool: 0,
                total: 12817,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: geminiHome, logType: "gemini" }],
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gemini-3-flash-preview",
            inputPer1MUsd: 0.1,
            outputPer1MUsd: 0.4,
            cachedReadPer1MUsd: 0.025,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0.4,
          },
        ],
      },
      models: {
        defaultContextWindowTokens: 200_000,
        contextWindows: [{ model: "gemini-3-flash-preview", contextWindowTokens: 1_000_000 }],
      },
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
        cursor_agent_transcripts: {
          name: "cursor_agent_transcripts",
          enabled: false,
          roots: [],
          includeGlobs: ["**/agent-transcripts/*.txt", "**/agent-transcripts/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
        gemini_tmp: {
          name: "gemini_tmp",
          enabled: false,
          roots: [],
          includeGlobs: ["**/chats/session-*.json", "**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "gemini",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.agent).toBe("gemini");
    expect(summary?.parser).toBe("gemini");
    expect(summary?.sessionId).toBe("50641617-dd96-45e6-9649-0b711b8073ae");
    expect(summary?.toolUseCount).toBe(1);
    expect(summary?.toolResultCount).toBe(1);
    expect(summary?.tokenTotals).toMatchObject({
      inputTokens: 24931,
      outputTokens: 79,
      reasoningOutputTokens: 135,
      totalTokens: 25145,
    });
    expect(summary?.costEstimateUsd).toBeCloseTo(0.002579, 6);
    expect(summary?.contextWindowPct).toBeCloseTo(1.2727, 4);

    const detail = index.getSessionDetail(summary!.id);
    const toolUseEvent = detail.events.find((event) => event.eventKind === "tool_use");
    const toolResultEvent = detail.events.find((event) => event.eventKind === "tool_result");
    expect(toolUseEvent?.toolName).toBe("google_web_search");
    expect(toolUseEvent?.toolType).toBe("websearch");
    expect(toolResultEvent?.toolResultText).toContain("Cloudy");
  });

  it("indexes new gemini session json files via dirty refresh and ignores project logs.json", async () => {
    const root = await createTempRoot();
    const geminiHome = path.join(root, ".gemini");
    const projectHash = "ab1a2dcf4db5d04597945f92d298533b91ee4b703c7cc87cfdd24ec5cdf55ab1";
    const projectDir = path.join(geminiHome, "tmp", projectHash);
    const chatsDir = path.join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });

    const config = mergeConfig({
      scan: {
        mode: "adaptive",
        intervalSeconds: 1,
        intervalMinMs: 60,
        intervalMaxMs: 200,
        fullRescanIntervalMs: 600_000,
        batchDebounceMs: 40,
        recentEventWindow: 400,
        includeMetaDefault: true,
        statusRunningTtlMs: 300_000,
        statusWaitingTtlMs: 900_000,
      },
      sessionLogDirectories: [{ directory: geminiHome, logType: "gemini" }],
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
        cursor_agent_transcripts: {
          name: "cursor_agent_transcripts",
          enabled: false,
          roots: [],
          includeGlobs: ["**/agent-transcripts/*.txt", "**/agent-transcripts/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
        gemini_tmp: {
          name: "gemini_tmp",
          enabled: false,
          roots: [],
          includeGlobs: ["**/chats/session-*.json", "**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "gemini",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(index.getSummaries()).toHaveLength(0);

      const sessionId = "54bc8ff5-57e7-4741-8bbc-18125dc656d0";
      const sessionPath = path.join(chatsDir, "session-2026-02-20T13-33-54bc8ff5.json");
      await writeFile(
        sessionPath,
        JSON.stringify(
          {
            sessionId,
            projectHash,
            startTime: "2026-02-20T13:33:54.000Z",
            lastUpdated: "2026-02-20T13:34:12.000Z",
            messages: [
              {
                id: "u1",
                timestamp: "2026-02-20T13:33:54.000Z",
                type: "user",
                content: [{ text: "hello" }],
              },
              {
                id: "a1",
                timestamp: "2026-02-20T13:33:55.000Z",
                type: "gemini",
                content: "hi there",
                model: "gemini-3-flash-preview",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const summary = index.getSummaries().find((item) => item.sessionId === sessionId);
        if (summary) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const geminiSummaries = index.getSummaries().filter((item) => item.agent === "gemini");
      expect(geminiSummaries).toHaveLength(1);
      expect(geminiSummaries[0]?.sessionId).toBe(sessionId);
      expect(geminiSummaries[0]?.path.endsWith("/chats/session-2026-02-20T13-33-54bc8ff5.json")).toBe(true);

      await writeFile(
        path.join(projectDir, "logs.json"),
        JSON.stringify([{ sessionId, messageId: 0, type: "user", message: "hi" }], null, 2),
        "utf8",
      );
      await new Promise((resolve) => setTimeout(resolve, 350));

      const updatedGeminiSummaries = index.getSummaries().filter((item) => item.agent === "gemini");
      expect(updatedGeminiSummaries).toHaveLength(1);
      expect(updatedGeminiSummaries[0]?.path.endsWith("/logs.json")).toBe(false);
    } finally {
      index.stop();
    }
  });

  it("indexes pi sessions via dirty refresh and derives pi metrics from usage", async () => {
    const root = await createTempRoot();
    const piHome = path.join(root, ".pi");
    const sessionsDir = path.join(
      piHome,
      "agent",
      "sessions",
      "--Users-rob-Dropbox-2026_sakana-agentlens--",
    );
    await mkdir(sessionsDir, { recursive: true });

    const config = mergeConfig({
      scan: {
        mode: "adaptive",
        intervalSeconds: 1,
        intervalMinMs: 60,
        intervalMaxMs: 200,
        fullRescanIntervalMs: 600_000,
        batchDebounceMs: 40,
        recentEventWindow: 400,
        includeMetaDefault: true,
        statusRunningTtlMs: 300_000,
        statusWaitingTtlMs: 900_000,
      },
      sessionLogDirectories: [{ directory: piHome, logType: "pi" }],
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
        cursor_agent_transcripts: {
          name: "cursor_agent_transcripts",
          enabled: false,
          roots: [],
          includeGlobs: ["**/agent-transcripts/*.txt", "**/agent-transcripts/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
        gemini_tmp: {
          name: "gemini_tmp",
          enabled: false,
          roots: [],
          includeGlobs: ["**/chats/session-*.json", "**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "gemini",
        },
        pi_agent_sessions: {
          name: "pi_agent_sessions",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "pi",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(index.getSummaries()).toHaveLength(0);

      const sessionId = "21e08b85-59b6-4acb-9811-a9dead258501";
      const sessionPath = path.join(sessionsDir, `2026-02-21T09-48-03-994Z_${sessionId}.jsonl`);
      await writeFile(
        sessionPath,
        [
          JSON.stringify({
            type: "session",
            version: 3,
            id: sessionId,
            timestamp: "2026-02-21T09:48:03.994Z",
            cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
          }),
          JSON.stringify({
            type: "message",
            id: "msg_user_1",
            timestamp: "2026-02-21T09:48:07.077Z",
            message: {
              role: "user",
              content: [{ type: "text", text: "hi there" }],
              timestamp: 1771667287065,
            },
          }),
          JSON.stringify({
            type: "message",
            id: "msg_assistant_1",
            timestamp: "2026-02-21T09:48:10.749Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Let me check using a tool." },
                { type: "thinking", thinking: "Need to call bash for this." },
                { type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "echo hi" } },
              ],
              model: "global.anthropic.claude-opus-4-6-v1",
              usage: {
                input: 4030,
                output: 43,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 4073,
                cost: { total: 0.021225 },
              },
            },
          }),
          JSON.stringify({
            type: "message",
            id: "msg_tool_result_1",
            timestamp: "2026-02-21T09:48:11.488Z",
            message: {
              role: "toolResult",
              toolCallId: "toolu_1",
              toolName: "bash",
              content: [{ type: "text", text: "hi" }],
              isError: false,
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const summary = index.getSummaries().find((item) => item.sessionId === sessionId);
        if (summary) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const summary = index.getSummaries().find((item) => item.sessionId === sessionId);
      expect(summary?.agent).toBe("pi");
      expect(summary?.parser).toBe("pi");
      expect(summary?.toolUseCount).toBe(1);
      expect(summary?.toolResultCount).toBe(1);
      expect(summary?.tokenTotals).toMatchObject({
        inputTokens: 4030,
        outputTokens: 43,
        cachedReadTokens: 0,
        cachedCreateTokens: 0,
        totalTokens: 4073,
      });
      expect(summary?.costEstimateUsd).toBeCloseTo(0.021225, 6);

      const initialEventCount = summary?.eventCount ?? 0;
      await appendFile(
        sessionPath,
        `\n${JSON.stringify({
          type: "message",
          id: "msg_assistant_2",
          timestamp: "2026-02-21T09:48:13.795Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
            model: "global.anthropic.claude-opus-4-6-v1",
            usage: {
              input: 1,
              output: 33,
              cacheRead: 0,
              cacheWrite: 4180,
              totalTokens: 4214,
              cost: { total: 0.026955 },
            },
          },
        })}`,
        "utf8",
      );

      const growthDeadline = Date.now() + 4000;
      while (Date.now() < growthDeadline) {
        const next = index.getSummaries().find((item) => item.sessionId === sessionId);
        if ((next?.eventCount ?? 0) > initialEventCount) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const updated = index.getSummaries().find((item) => item.sessionId === sessionId);
      expect((updated?.eventCount ?? 0) > initialEventCount).toBe(true);
      expect(updated?.costEstimateUsd).toBeCloseTo(0.04818, 6);
      expect(updated?.tokenTotals).toMatchObject({
        inputTokens: 4031,
        outputTokens: 76,
        cachedCreateTokens: 4180,
        totalTokens: 8287,
      });
    } finally {
      index.stop();
    }
  });

  it("parses opencode storage sessions with tool events and token metrics", async () => {
    const root = await createTempRoot();
    const storageRoot = path.join(root, ".local", "share", "opencode", "storage");
    const sessionId = "ses_opencode_1";
    const sessionDir = path.join(storageRoot, "session", "global");
    const messageDir = path.join(storageRoot, "message", sessionId);
    const userPartDir = path.join(storageRoot, "part", "msg_user_1");
    const assistantPartDir = path.join(storageRoot, "part", "msg_assistant_1");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(messageDir, { recursive: true });
    await mkdir(userPartDir, { recursive: true });
    await mkdir(assistantPartDir, { recursive: true });

    await writeFile(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        slug: "steady-ridge",
        version: "1.2.0",
        projectID: "global",
        directory: "/tmp/opencode-proj",
        title: "OpenCode trace test",
        time: { created: 1_771_200_000_000, updated: 1_771_200_005_000 },
      }),
      "utf8",
    );
    await writeFile(
      path.join(messageDir, "msg_user_1.json"),
      JSON.stringify({
        id: "msg_user_1",
        sessionID: sessionId,
        role: "user",
        time: { created: 1_771_200_000_100 },
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.3-codex" },
      }),
      "utf8",
    );
    await writeFile(
      path.join(messageDir, "msg_assistant_1.json"),
      JSON.stringify({
        id: "msg_assistant_1",
        sessionID: sessionId,
        role: "assistant",
        time: { created: 1_771_200_000_200, completed: 1_771_200_000_900 },
        parentID: "msg_user_1",
        modelID: "gpt-5.3-codex",
        providerID: "openai",
        cost: 0.001,
        tokens: {
          total: 600,
          input: 250,
          output: 220,
          reasoning: 30,
          cache: { read: 100, write: 0 },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(userPartDir, "prt_user_text_1.json"),
      JSON.stringify({
        id: "prt_user_text_1",
        sessionID: sessionId,
        messageID: "msg_user_1",
        type: "text",
        text: "run tests",
      }),
      "utf8",
    );
    await writeFile(
      path.join(assistantPartDir, "prt_reasoning_1.json"),
      JSON.stringify({
        id: "prt_reasoning_1",
        sessionID: sessionId,
        messageID: "msg_assistant_1",
        type: "reasoning",
        text: "Need to run the suite first",
        time: { start: 1_771_200_000_250, end: 1_771_200_000_300 },
      }),
      "utf8",
    );
    await writeFile(
      path.join(assistantPartDir, "prt_tool_1.json"),
      JSON.stringify({
        id: "prt_tool_1",
        sessionID: sessionId,
        messageID: "msg_assistant_1",
        type: "tool",
        callID: "call_opencode_1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "npm test --silent" },
          output: "ok",
          title: "npm test --silent",
          metadata: {},
          time: { start: 1_771_200_000_350, end: 1_771_200_000_700 },
        },
      }),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [],
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.3-codex",
            inputPer1MUsd: 1.5,
            outputPer1MUsd: 6,
            cachedReadPer1MUsd: 0.375,
            cachedCreatePer1MUsd: 0.375,
            reasoningOutputPer1MUsd: 0,
          },
        ],
      },
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
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: true,
          roots: [path.join(storageRoot, "session")],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.agent).toBe("opencode");
    expect(summary?.parser).toBe("opencode");
    expect(summary?.sessionId).toBe(sessionId);
    expect(summary?.toolUseCount).toBe(1);
    expect(summary?.toolResultCount).toBe(1);
    expect(summary?.tokenTotals?.inputTokens).toBe(250);
    expect(summary?.tokenTotals?.cachedReadTokens).toBe(100);
    expect(summary?.tokenTotals?.outputTokens).toBe(220);
    expect(summary?.costEstimateUsd).not.toBeNull();

    const detail = index.getSessionDetail(summary!.id);
    expect(detail.events.map((event) => event.eventKind)).toEqual(["meta", "user", "reasoning", "tool_use", "tool_result"]);
    const toolUseEvent = detail.events.find((event) => event.eventKind === "tool_use");
    expect(toolUseEvent?.toolType).toBe("bash");
    expect(toolUseEvent?.toolArgsText).toContain("npm test");
  });

  it("indexes opencode session_diff entries when session files are absent", async () => {
    const root = await createTempRoot();
    const opencodeHome = path.join(root, ".local", "share", "opencode");
    const sessionId = "ses_opencode_diff_only";
    const sessionDiffDir = path.join(opencodeHome, "storage", "session_diff");
    await mkdir(sessionDiffDir, { recursive: true });
    await writeFile(path.join(sessionDiffDir, `${sessionId}.json`), "[]", "utf8");

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: opencodeHome, logType: "opencode" }],
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
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();
    const summaries = index.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.agent).toBe("opencode");
    expect(summaries[0]?.parser).toBe("opencode");
    expect(summaries[0]?.sessionId).toBe(sessionId);
    expect(summaries[0]?.path.includes("/storage/session_diff/")).toBe(true);
    expect(summaries[0]?.parseError).toBe("");
    expect(summaries[0]?.eventCount).toBe(1);
  });

  it("prefers opencode session files over duplicate session_diff placeholders", async () => {
    const root = await createTempRoot();
    const opencodeHome = path.join(root, ".local", "share", "opencode");
    const storageRoot = path.join(opencodeHome, "storage");
    const sessionId = "ses_opencode_session_preferred";
    const sessionDir = path.join(storageRoot, "session", "global");
    const sessionDiffDir = path.join(storageRoot, "session_diff");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(sessionDiffDir, { recursive: true });

    await writeFile(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        slug: "steady-ridge",
        version: "1.2.0",
        projectID: "global",
        directory: "/tmp/opencode-proj",
        title: "OpenCode session file",
        time: { created: 1_771_200_000_000, updated: 1_771_200_001_000 },
      }),
      "utf8",
    );
    await writeFile(path.join(sessionDiffDir, `${sessionId}.json`), "[]", "utf8");

    const config = mergeConfig({
      sessionLogDirectories: [{ directory: opencodeHome, logType: "opencode" }],
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
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();
    const summaries = index.getSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.sessionId).toBe(sessionId);
    expect(summaries[0]?.path.includes("/storage/session/")).toBe(true);
    expect(summaries[0]?.path.includes("/storage/session_diff/")).toBe(false);
  });

  it("reparses opencode sessions when message/part files change without session mtime updates", async () => {
    const root = await createTempRoot();
    const opencodeHome = path.join(root, ".local", "share", "opencode");
    const storageRoot = path.join(opencodeHome, "storage");
    const sessionId = "ses_opencode_live";
    const sessionDir = path.join(storageRoot, "session", "global");
    const messageDir = path.join(storageRoot, "message", sessionId);
    const userPartDir = path.join(storageRoot, "part", "msg_user_live");
    await mkdir(sessionDir, { recursive: true });
    await mkdir(messageDir, { recursive: true });
    await mkdir(userPartDir, { recursive: true });

    await writeFile(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({
        id: sessionId,
        slug: "live-session",
        version: "1.2.0",
        projectID: "global",
        directory: "/tmp/opencode-live",
        title: "OpenCode live session test",
        time: { created: 1_771_200_100_000, updated: 1_771_200_100_500 },
      }),
      "utf8",
    );
    await writeFile(
      path.join(messageDir, "msg_user_live.json"),
      JSON.stringify({
        id: "msg_user_live",
        sessionID: sessionId,
        role: "user",
        time: { created: 1_771_200_100_100 },
      }),
      "utf8",
    );
    await writeFile(
      path.join(userPartDir, "prt_user_live_1.json"),
      JSON.stringify({
        id: "prt_user_live_1",
        sessionID: sessionId,
        messageID: "msg_user_live",
        type: "text",
        text: "start live run",
      }),
      "utf8",
    );

    const config = mergeConfig({
      scan: {
        mode: "adaptive",
        intervalSeconds: 1,
        intervalMinMs: 60,
        intervalMaxMs: 200,
        fullRescanIntervalMs: 600_000,
        batchDebounceMs: 40,
        recentEventWindow: 400,
        includeMetaDefault: true,
        statusRunningTtlMs: 300_000,
        statusWaitingTtlMs: 900_000,
      },
      sessionLogDirectories: [{ directory: opencodeHome, logType: "opencode" }],
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
        opencode_storage_session: {
          name: "opencode_storage_session",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.json"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const initialSummary = index.getSummaries()[0];
      expect(initialSummary?.agent).toBe("opencode");
      expect(initialSummary?.eventCount).toBe(2);
      const initialLastEventTs = initialSummary?.lastEventTs ?? 0;

      const assistantMessageId = "msg_assistant_live";
      const assistantPartDir = path.join(storageRoot, "part", assistantMessageId);
      await mkdir(assistantPartDir, { recursive: true });
      await writeFile(
        path.join(messageDir, `${assistantMessageId}.json`),
        JSON.stringify({
          id: assistantMessageId,
          sessionID: sessionId,
          role: "assistant",
          parentID: "msg_user_live",
          time: { created: 1_771_200_100_800, completed: 1_771_200_101_000 },
        }),
        "utf8",
      );
      await writeFile(
        path.join(assistantPartDir, "prt_assistant_live_1.json"),
        JSON.stringify({
          id: "prt_assistant_live_1",
          sessionID: sessionId,
          messageID: assistantMessageId,
          type: "text",
          text: "live response received",
          time: { start: 1_771_200_100_850, end: 1_771_200_100_950 },
        }),
        "utf8",
      );

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const summary = index.getSummaries()[0];
        if ((summary?.eventCount ?? 0) >= 3 && (summary?.lastEventTs ?? 0) > initialLastEventTs) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const summary = index.getSummaries()[0];
      expect(summary?.eventCount).toBe(3);
      expect(summary?.lastEventTs).toBeGreaterThan(initialLastEventTs);
      const detail = index.getSessionDetail(summary!.id);
      expect(detail.events.map((event) => event.eventKind)).toEqual(["meta", "user", "assistant"]);
    } finally {
      index.stop();
    }
  });

  it("normalizes web_search_call actions into toolType tags", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "11");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "rollout-web-search.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "sess-web", cwd: "/tmp/project", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", query: "agentlens parser" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: { type: "open_page", url: "https://example.com" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: { type: "find_in_page", query: "toolType" },
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
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    const detail = index.getSessionDetail(summary!.id);
    const webEvents = detail.events.filter((event) => event.rawType === "web_search_call");
    expect(webEvents.map((event) => event.toolType)).toEqual(["web:search", "web:open", "web:find"]);

    const page = index.getTracePage(summary!.id, { includeMeta: true, limit: 10 }) as unknown as {
      toc?: Array<{ toolType: string }>;
    };
    const webTocTags = (page.toc ?? []).map((entry) => entry.toolType).filter((value) => value.startsWith("web"));
    expect(webTocTags).toEqual(["web:search", "web:open", "web:find"]);
  });

  it("formats codex reasoning summary_text previews", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "11");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "rollout-reasoning-summary.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "sess-reasoning", cwd: "/tmp/project", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          content: [{ type: "summary_text", text: "**Summarizing cost calculation details**" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "reasoning", content: [{ type: "summary_text", text: "**Second reasoning summary**" }] }],
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
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    const detail = index.getSessionDetail(summary!.id);
    const reasoningEvents = detail.events.filter((event) => event.eventKind === "reasoning");
    expect(reasoningEvents.map((event) => event.preview)).toEqual([
      "Summary: **Summarizing cost calculation details**",
      "Summary: **Second reasoning summary**",
    ]);
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

  it("computes codex token totals, top model shares, context ratio, and session cost estimate", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "13");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "rollout-metrics.jsonl");
    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: "2026-02-13T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "sess-metrics", cwd: "/tmp/project", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.3-codex" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 20,
                output_tokens: 10,
                reasoning_output_tokens: 5,
                total_tokens: 135,
              },
              last_token_usage: {
                input_tokens: 120,
                cached_input_tokens: 20,
                output_tokens: 10,
                reasoning_output_tokens: 5,
                total_tokens: 155,
              },
              model_context_window: 1000,
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:03.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.2-codex" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:04.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 200,
                cached_input_tokens: 40,
                output_tokens: 20,
                reasoning_output_tokens: 10,
                total_tokens: 270,
              },
              last_token_usage: {
                input_tokens: 180,
                cached_input_tokens: 30,
                output_tokens: 10,
                reasoning_output_tokens: 4,
                total_tokens: 224,
              },
              model_context_window: 1000,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [],
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.3-codex",
            inputPer1MUsd: 1,
            outputPer1MUsd: 1,
            cachedReadPer1MUsd: 1,
            cachedCreatePer1MUsd: 1,
            reasoningOutputPer1MUsd: 1,
          },
          {
            model: "gpt-5.2-codex",
            inputPer1MUsd: 1,
            outputPer1MUsd: 1,
            cachedReadPer1MUsd: 1,
            cachedCreatePer1MUsd: 1,
            reasoningOutputPer1MUsd: 1,
          },
        ],
      },
      models: {
        defaultContextWindowTokens: 500,
        contextWindows: [
          { model: "gpt-5.3-codex", contextWindowTokens: 1000 },
          { model: "gpt-5.2-codex", contextWindowTokens: 1000 },
        ],
      },
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
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.tokenTotals?.totalTokens).toBe(270);
    expect(summary?.tokenTotals?.inputTokens).toBe(200);
    expect(summary?.modelTokenSharesTop?.length).toBeGreaterThan(0);
    expect((summary?.modelTokenSharesTop ?? []).map((row) => row.model)).toEqual(
      expect.arrayContaining(["gpt-5.3-codex", "gpt-5.2-codex"]),
    );
    expect(summary?.modelTokenSharesEstimated).toBe(true);
    expect(summary?.contextWindowPct).not.toBeNull();
    expect((summary?.contextWindowPct ?? 0) > 0).toBe(true);
    expect(summary?.costEstimateUsd).not.toBeNull();
    expect((summary?.costEstimateUsd ?? 0) > 0).toBe(true);
  });

  it("does not double bill codex cached input tokens in cost estimate", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "13");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "rollout-cost-cached.jsonl");
    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: "2026-02-13T11:00:00.000Z",
          type: "session_meta",
          payload: { id: "sess-cost-cached", cwd: "/tmp/project", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T11:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.3-codex" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T11:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 900,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 1000,
              },
              last_token_usage: {
                input_tokens: 1000,
                cached_input_tokens: 900,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: 1000,
              },
              model_context_window: 10000,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [],
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.3-codex",
            inputPer1MUsd: 1,
            outputPer1MUsd: 0,
            cachedReadPer1MUsd: 0,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
          },
        ],
      },
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
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.costEstimateUsd).toBe(0.0001);
  });

  it("deduplicates repeated claude usage rows by request id for cost estimation", async () => {
    const root = await createTempRoot();
    const claudeDir = path.join(root, ".claude", "projects", "proj");
    await mkdir(claudeDir, { recursive: true });

    const claudePath = path.join(claudeDir, "session-cost.jsonl");
    await writeFile(
      claudePath,
      [
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-cost-sess",
          uuid: "u1",
          requestId: "req_1",
          message: {
            model: "claude-sonnet-4-5-20250929",
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "first" }],
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 600,
              cache_read_input_tokens: 300,
              cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 0 },
              output_tokens: 50,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-cost-sess",
          uuid: "u2",
          requestId: "req_1",
          message: {
            model: "claude-sonnet-4-5-20250929",
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "echo hi" } }],
            usage: {
              input_tokens: 100,
              cache_creation_input_tokens: 600,
              cache_read_input_tokens: 300,
              cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 0 },
              output_tokens: 50,
            },
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-cost-sess",
          uuid: "u3",
          requestId: "req_2",
          message: {
            model: "claude-sonnet-4-5-20250929",
            id: "msg_2",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "second" }],
            usage: {
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
              output_tokens: 5,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const config = mergeConfig({
      sessionLogDirectories: [],
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "claude-sonnet-4-5-20250929",
            inputPer1MUsd: 1,
            outputPer1MUsd: 1,
            cachedReadPer1MUsd: 1,
            cachedCreatePer1MUsd: 1,
            reasoningOutputPer1MUsd: 0,
          },
        ],
      },
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
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    expect(summary?.costEstimateUsd).toBe(0.001065);
  });

  it("redacts secret-like values from event previews and raw payloads", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "13");
    await mkdir(codexDir, { recursive: true });

    const codexPath = path.join(codexDir, "rollout-redaction.jsonl");
    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: "2026-02-13T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "sess-redact", cwd: "/tmp/project", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "fc_1",
            name: "exec_command",
            call_id: "call_1",
            arguments: "{\"token\":\"sk-secret-123\"}",
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_1",
            result: {
              OPENAI_API_KEY: "sk-secret-456",
              ok: true,
            },
          },
        }),
      ].join("\n"),
      "utf8",
    );

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
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();

    const summary = index.getSummaries()[0];
    const detail = index.getSessionDetail(summary!.id);
    const toolUse = detail.events.find((event) => event.eventKind === "tool_use");
    const toolResult = detail.events.find((event) => event.eventKind === "tool_result");

    expect(toolUse?.toolArgsText.includes("sk-secret")).toBe(false);
    expect(toolUse?.toolArgsText.includes("[REDACTED]")).toBe(true);
    expect(JSON.stringify(toolResult?.raw).includes("sk-secret")).toBe(false);
    expect(JSON.stringify(toolResult?.raw).includes("[REDACTED]")).toBe(true);
  });

  it("uses incremental append parsing for hot traces", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "13");
    await mkdir(codexDir, { recursive: true });
    const codexPath = path.join(codexDir, "rollout-incremental.jsonl");

    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: "2026-02-13T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "sess-incremental", cwd: "/tmp/project", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "fc_1",
            name: "exec_command",
            call_id: "call_1",
            arguments: "{\"command\":\"echo one\"}",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const config = mergeConfig({
      scan: {
        mode: "adaptive",
        intervalSeconds: 1,
        intervalMinMs: 60,
        intervalMaxMs: 200,
        fullRescanIntervalMs: 600_000,
        batchDebounceMs: 40,
        recentEventWindow: 400,
        includeMetaDefault: true,
        statusRunningTtlMs: 300_000,
        statusWaitingTtlMs: 900_000,
      },
      retention: {
        strategy: "aggressive_recency",
        hotTraceCount: 5,
        warmTraceCount: 0,
        maxResidentEventsPerHotTrace: 1000,
        maxResidentEventsPerWarmTrace: 50,
        detailLoadMode: "lazy_from_disk",
      },
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
      },
    });

    const index = new TraceIndex(config);
    await index.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await appendFile(
        codexPath,
        `${JSON.stringify({
          timestamp: "2026-02-13T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call_1",
            output: "one",
          },
        })}\n`,
        "utf8",
      );

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const summary = index.getSummaries()[0];
        if ((summary?.eventCount ?? 0) >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const summary = index.getSummaries()[0];
      expect(summary?.eventCount).toBe(3);
      const perf = index.getPerformanceStats();
      expect(perf.incrementalAppendCount).toBeGreaterThan(0);
      expect(perf.fullReparseCount).toBeGreaterThan(0);
    } finally {
      index.stop();
    }
  });

  it("keeps codex model and cost metrics after appends with strict redaction", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "13");
    await mkdir(codexDir, { recursive: true });
    const codexPath = path.join(codexDir, "rollout-incremental-metrics.jsonl");

    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: "2026-02-13T11:00:00.000Z",
          type: "session_meta",
          payload: { id: "sess-incremental-metrics", cwd: "/tmp/project", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T11:00:01.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.3-codex" },
        }),
        JSON.stringify({
          timestamp: "2026-02-13T11:00:02.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 0,
                output_tokens: 20,
                reasoning_output_tokens: 0,
                total_tokens: 120,
              },
              last_token_usage: {
                input_tokens: 90,
                cached_input_tokens: 0,
                output_tokens: 10,
                reasoning_output_tokens: 0,
                total_tokens: 100,
              },
              model_context_window: 1000,
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const config = mergeConfig({
      scan: {
        mode: "adaptive",
        intervalSeconds: 1,
        intervalMinMs: 60,
        intervalMaxMs: 200,
        fullRescanIntervalMs: 600_000,
        batchDebounceMs: 40,
        recentEventWindow: 400,
        includeMetaDefault: true,
        statusRunningTtlMs: 300_000,
        statusWaitingTtlMs: 900_000,
      },
      retention: {
        strategy: "aggressive_recency",
        hotTraceCount: 5,
        warmTraceCount: 0,
        maxResidentEventsPerHotTrace: 1000,
        maxResidentEventsPerWarmTrace: 50,
        detailLoadMode: "lazy_from_disk",
      },
      sessionLogDirectories: [],
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.3-codex",
            inputPer1MUsd: 1,
            outputPer1MUsd: 1,
            cachedReadPer1MUsd: 1,
            cachedCreatePer1MUsd: 1,
            reasoningOutputPer1MUsd: 1,
          },
        ],
      },
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
      },
    });

    const index = new TraceIndex(config);
    await index.start();
    try {
      const baselineDeadline = Date.now() + 12_000;
      while (Date.now() < baselineDeadline) {
        const summary = index.getSummaries()[0];
        if ((summary?.eventCount ?? 0) >= 3 && (summary?.costEstimateUsd ?? null) !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await appendFile(
        codexPath,
        `${JSON.stringify({
          timestamp: "2026-02-13T11:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 150,
                cached_input_tokens: 0,
                output_tokens: 50,
                reasoning_output_tokens: 0,
                total_tokens: 200,
              },
              last_token_usage: {
                input_tokens: 50,
                cached_input_tokens: 0,
                output_tokens: 30,
                reasoning_output_tokens: 0,
                total_tokens: 80,
              },
              model_context_window: 1000,
            },
          },
        })}\n`,
        "utf8",
      );

      await index.refresh();

      const summary = index.getSummaries()[0];
      expect((summary?.eventCount ?? 0) >= 3).toBe(true);
      expect(summary?.tokenTotals?.totalTokens).toBe(200);
      expect((summary?.modelTokenSharesTop ?? []).some((row) => row.model === "gpt-5.3-codex")).toBe(true);
      expect(summary?.costEstimateUsd).not.toBeNull();
      expect((summary?.costEstimateUsd ?? 0) > 0).toBe(true);
    } finally {
      index.stop();
    }
  }, 20_000);
});
