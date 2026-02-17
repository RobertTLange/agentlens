import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeConfig, saveConfig, TraceIndex } from "@agentlens/core";
import {
  createServer,
  matchesCurrentUser,
  parseTmuxClients,
  resolveDefaultWebDistPath,
  selectPreferredTmuxClient,
  selectAgentProjectProcessPids,
  selectClaudeProjectProcessPids,
  selectCursorProjectProcessPids,
} from "./app.js";

function buildTraceLog(sessionId: string, sequence: number, withToolEvents: boolean): string {
  const firstTs = new Date(Date.UTC(2026, 1, 11, 10, 0, sequence)).toISOString();
  const secondTs = new Date(Date.UTC(2026, 1, 11, 10, 0, sequence + 1)).toISOString();
  const thirdTs = new Date(Date.UTC(2026, 1, 11, 10, 0, sequence + 2)).toISOString();

  const rows: string[] = [
    JSON.stringify({
      timestamp: firstTs,
      type: "session_meta",
      payload: { id: sessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
    }),
  ];

  if (withToolEvents) {
    rows.push(
      JSON.stringify({
        timestamp: secondTs,
        type: "response_item",
        payload: {
          type: "function_call",
          id: `fc_${sequence}`,
          name: "run_command",
          call_id: `call_${sequence}`,
          arguments: "{\"command\":\"echo hi\"}",
        },
      }),
    );
    rows.push(
      JSON.stringify({
        timestamp: thirdTs,
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: `call_${sequence}`,
          output: "hi",
        },
      }),
    );
  }

  return rows.join("\n");
}

async function buildFixtureWithTraceCount(
  traceCount: number,
): Promise<{ configPath: string; index: TraceIndex; sessionIds: string[] }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-server-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });

  const sessionIds: string[] = [];
  for (let traceIndex = 1; traceIndex <= traceCount; traceIndex += 1) {
    const sessionId = `server-session-${traceIndex}`;
    const tracePath = path.join(codexRoot, `rollout-${String(traceIndex).padStart(3, "0")}.jsonl`);
    sessionIds.push(sessionId);
    await writeFile(tracePath, buildTraceLog(sessionId, traceIndex, traceIndex === 1), "utf8");
  }

  const config = mergeConfig({
    scan: {
      mode: "adaptive",
      intervalSeconds: 5,
      intervalMinMs: 200,
      intervalMaxMs: 3000,
      fullRescanIntervalMs: 900_000,
      batchDebounceMs: 120,
      recentEventWindow: 200,
      includeMetaDefault: false,
      statusRunningTtlMs: 30_000,
      statusWaitingTtlMs: 300_000,
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

  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);

  const index = new TraceIndex(config);
  await index.refresh();

  return { configPath, index, sessionIds };
}

async function buildFixture(): Promise<{ configPath: string; index: TraceIndex; sessionId: string }> {
  const fixture = await buildFixtureWithTraceCount(1);
  const sessionId = fixture.sessionIds[0];
  if (!sessionId) {
    throw new Error("failed to build fixture session");
  }
  return {
    configPath: fixture.configPath,
    index: fixture.index,
    sessionId,
  };
}

describe("server api", () => {
  it("matches process owner by username and numeric uid", async () => {
    expect(matchesCurrentUser("rob", { username: "rob", uid: "501" })).toBe(true);
    expect(matchesCurrentUser("501", { username: "rob", uid: "501" })).toBe(true);
    expect(matchesCurrentUser("other", { username: "rob", uid: "501" })).toBe(false);
  });

  it("parses tmux clients and prioritizes focused clients", async () => {
    const clients = parseTmuxClients(
      [
        "/dev/ttys010\t1739544000\tmonitor\tattached,focused,UTF-8",
        "/dev/ttys011\t1739545000\tagent\tattached,UTF-8",
        "/dev/ttys012\t1739544900\tagent\tattached,UTF-8",
      ].join("\n"),
    );
    expect(clients).toEqual([
      {
        tty: "/dev/ttys010",
        activityEpoch: 1739544000,
        sessionName: "monitor",
        flags: ["attached", "focused", "UTF-8"],
        isFocused: true,
      },
      {
        tty: "/dev/ttys011",
        activityEpoch: 1739545000,
        sessionName: "agent",
        flags: ["attached", "UTF-8"],
        isFocused: false,
      },
      {
        tty: "/dev/ttys012",
        activityEpoch: 1739544900,
        sessionName: "agent",
        flags: ["attached", "UTF-8"],
        isFocused: false,
      },
    ]);
    expect(selectPreferredTmuxClient(clients, "agent")).toEqual({
      tty: "/dev/ttys010",
      activityEpoch: 1739544000,
      sessionName: "monitor",
      flags: ["attached", "focused", "UTF-8"],
      isFocused: true,
    });
    expect(selectPreferredTmuxClient(clients, "monitor")).toEqual({
      tty: "/dev/ttys010",
      activityEpoch: 1739544000,
      sessionName: "monitor",
      flags: ["attached", "focused", "UTF-8"],
      isFocused: true,
    });
  });

  it("prefers a non-target focused client over a focused target-session client", async () => {
    const clients = parseTmuxClients(
      [
        "/dev/ttys010\t1739544000\tagent\tattached,focused,UTF-8",
        "/dev/ttys011\t1739543000\tmonitor\tattached,focused,UTF-8",
        "/dev/ttys012\t1739545000\tagent\tattached,UTF-8",
      ].join("\n"),
    );
    expect(selectPreferredTmuxClient(clients, "agent")).toEqual({
      tty: "/dev/ttys011",
      activityEpoch: 1739543000,
      sessionName: "monitor",
      flags: ["attached", "focused", "UTF-8"],
      isFocused: true,
    });
  });

  it("returns null when no tmux clients are available", async () => {
    expect(parseTmuxClients("")).toEqual([]);
    expect(selectPreferredTmuxClient([], "main")).toBeNull();
  });

  it("falls back to the most recently active client when no focused client exists", async () => {
    const clients = parseTmuxClients(
      ["/dev/ttys010\t1739544000\tagent\tattached,UTF-8", "/dev/ttys011\t1739545000\tagent\tattached,UTF-8"].join(
        "\n",
      ),
    );
    expect(selectPreferredTmuxClient(clients, "agent")).toEqual({
      tty: "/dev/ttys011",
      activityEpoch: 1739545000,
      sessionName: "agent",
      flags: ["attached", "UTF-8"],
      isFocused: false,
    });
  });

  it("selects claude fallback process by matching project cwd", async () => {
    const selected = selectClaudeProjectProcessPids(
      {
        path: "/Users/rob/.claude/projects/-Users-rob-Dropbox-2026-sakana-agentlens/2356bd53-2142-4bad-a14f-a04e50069f51.jsonl",
        sessionId: "2356bd53-2142-4bad-a14f-a04e50069f51",
      },
      [
        {
          pid: 81230,
          user: "rob",
          args: "claude --dangerously-skip-permissions",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 27376,
          user: "rob",
          args: "/Applications/Claude.app/Contents/MacOS/Claude",
          cwd: "/Applications/Claude.app",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([81230]);
  });

  it("prefers claude fallback process whose args include the selected session id", async () => {
    const sessionId = "2356bd53-2142-4bad-a14f-a04e50069f51";
    const selected = selectClaudeProjectProcessPids(
      {
        path: `/Users/rob/.claude/projects/-Users-rob-Dropbox-2026-sakana-agentlens/${sessionId}.jsonl`,
        sessionId,
      },
      [
        {
          pid: 7001,
          user: "rob",
          args: "claude --resume 2356bd53-2142-4bad-a14f-a04e50069f51",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 7002,
          user: "rob",
          args: "claude --dangerously-skip-permissions",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([7001]);
  });

  it("selects codex fallback process by matching project cwd", async () => {
    const selected = selectAgentProjectProcessPids(
      "/Users/rob/Dropbox/2026_sakana/agentlens",
      "codex-session-123",
      "codex",
      [
        {
          pid: 6101,
          user: "rob",
          args: "node /Users/rob/.local/bin/codex --dangerously-bypass-approvals-and-sandbox",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 6102,
          user: "rob",
          args: "node /Users/rob/.local/bin/codex --dangerously-bypass-approvals-and-sandbox",
          cwd: "/Users/rob/Dropbox/other-project",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([6101]);
  });

  it("prefers agent fallback process whose args include selected session id", async () => {
    const sessionId = "codex-session-123";
    const selected = selectAgentProjectProcessPids(
      "/Users/rob/Dropbox/2026_sakana/agentlens",
      sessionId,
      "codex",
      [
        {
          pid: 6201,
          user: "rob",
          args: "node /Users/rob/.local/bin/codex --resume codex-session-123",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 6202,
          user: "rob",
          args: "node /Users/rob/.local/bin/codex --dangerously-bypass-approvals-and-sandbox",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([6201]);
  });

  it("ignores opencode serve daemons when selecting fallback agent process", async () => {
    const sessionId = "ses_opencode_123";
    const selected = selectAgentProjectProcessPids(
      "/Users/rob/Dropbox/2026_sakana/agentlens",
      sessionId,
      "opencode",
      [
        {
          pid: 6301,
          user: "rob",
          args: "/usr/local/bin/opencode serve --port 49957",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 6302,
          user: "rob",
          args: "/usr/local/bin/opencode --resume ses_opencode_123",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([6302]);
  });

  it("selects cursor fallback process by matching cursor transcript project key", async () => {
    const sessionId = "81907d70-7e5c-45d8-bbbb-22f66e9878f0";
    const selected = selectCursorProjectProcessPids(
      {
        path: `/Users/rob/.cursor/projects/Users-rob-Dropbox-Mac-2-Desktop/agent-transcripts/${sessionId}.txt`,
        sessionId,
      },
      [
        {
          pid: 53121,
          user: "rob",
          args: "/Users/rob/.local/bin/agent --use-system-ca /Users/rob/.local/share/cursor-agent/versions/2026.01.28-fd13201/index.js",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
        {
          pid: 65932,
          user: "rob",
          args: "/Applications/Cursor.app/Contents/MacOS/Cursor",
          cwd: "/Applications/Cursor.app",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([53121]);
  });

  it("prefers cursor fallback process whose args include selected session id", async () => {
    const sessionId = "81907d70-7e5c-45d8-bbbb-22f66e9878f0";
    const selected = selectCursorProjectProcessPids(
      {
        path: `/Users/rob/.cursor/projects/Users-rob-Dropbox-Mac-2-Desktop/agent-transcripts/${sessionId}.txt`,
        sessionId,
      },
      [
        {
          pid: 53121,
          user: "rob",
          args: "/Users/rob/.local/bin/agent --use-system-ca /Users/rob/.local/share/cursor-agent/versions/2026.01.28-fd13201/index.js",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
        {
          pid: 53122,
          user: "rob",
          args: "/Users/rob/.local/bin/agent --session-id 81907d70-7e5c-45d8-bbbb-22f66e9878f0 --use-system-ca /Users/rob/.local/share/cursor-agent/versions/2026.01.28-fd13201/index.js",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([53122]);
  });

  it("prefers monorepo web dist when both monorepo and packaged builds exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-web-dist-"));
    const packagedWebDistPath = path.join(root, "packaged-web-dist");
    const monorepoWebDistPath = path.join(root, "monorepo-web-dist");
    await mkdir(packagedWebDistPath, { recursive: true });
    await mkdir(monorepoWebDistPath, { recursive: true });

    expect(resolveDefaultWebDistPath(packagedWebDistPath, monorepoWebDistPath)).toBe(monorepoWebDistPath);
  });

  it("limits trace listing to 50 by default and respects explicit limits", async () => {
    const fixture = await buildFixtureWithTraceCount(75);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const defaultRes = await server.inject({ method: "GET", url: "/api/traces" });
    expect(defaultRes.statusCode).toBe(200);
    const defaultPayload = defaultRes.json() as { traces: Array<{ id: string; sessionId: string }> };
    expect(defaultPayload.traces).toHaveLength(50);

    const explicitRes = await server.inject({ method: "GET", url: "/api/traces?limit=12" });
    expect(explicitRes.statusCode).toBe(200);
    const explicitPayload = explicitRes.json() as { traces: Array<{ id: string; sessionId: string }> };
    expect(explicitPayload.traces).toHaveLength(12);

    const invalidRes = await server.inject({ method: "GET", url: "/api/traces?limit=0" });
    expect(invalidRes.statusCode).toBe(200);
    const invalidPayload = invalidRes.json() as { traces: Array<{ id: string; sessionId: string }> };
    expect(invalidPayload.traces).toHaveLength(50);

    const largeRes = await server.inject({ method: "GET", url: "/api/traces?limit=200" });
    expect(largeRes.statusCode).toBe(200);
    const largePayload = largeRes.json() as { traces: Array<{ id: string; sessionId: string }> };
    expect(largePayload.traces).toHaveLength(75);

    await server.close();
  });

  it("serves overview, trace listing, trace details, stop/open controls, and config updates", async () => {
    const fixture = await buildFixture();
    const stopTraceSession = vi.fn();
    const openTraceSession = vi.fn();
    stopTraceSession.mockResolvedValue({
      status: "terminated" as const,
      reason: "session process terminated with SIGINT",
      signal: "SIGINT" as const,
      matchedPids: [4242],
      alivePids: [],
    });
    openTraceSession.mockResolvedValue({
      status: "focused_pane" as const,
      reason: "focused tmux pane for session process",
      pid: 4242,
      tty: "/dev/ttys018",
      target: {
        tmuxSession: "main",
        windowIndex: 2,
        paneIndex: 1,
      },
      matchedPids: [4242],
      alivePids: [4242],
    });
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
      stopTraceSession,
      openTraceSession,
    });

    const health = await server.inject({ method: "GET", url: "/api/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const perfRes = await server.inject({ method: "GET", url: "/api/perf" });
    expect(perfRes.statusCode).toBe(200);
    expect(perfRes.json()).toMatchObject({
      perf: {
        refreshCount: expect.any(Number),
        trackedFiles: 1,
      },
    });

    const tracesRes = await server.inject({ method: "GET", url: "/api/traces" });
    expect(tracesRes.statusCode).toBe(200);
    const tracesPayload = tracesRes.json() as { traces: Array<{ id: string; sessionId: string }> };
    expect(tracesPayload.traces.length).toBe(1);

    const traceId = tracesPayload.traces[0]?.id;
    expect(traceId).toBeTruthy();

    const traceById = await server.inject({ method: "GET", url: `/api/trace/${traceId}` });
    expect(traceById.statusCode).toBe(200);
    const detail = traceById.json() as {
      summary: { sessionId: string };
      events: Array<{ toolCallId?: string; toolArgsText?: string; toolResultText?: string }>;
      toc?: Array<{ label: string; eventKind: string }>;
    };
    expect(detail.summary.sessionId).toBe(fixture.sessionId);
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.events[0]?.toolCallId).toBe("call_1");
    expect(detail.events[0]?.toolArgsText).toContain("echo hi");
    expect(detail.events[1]?.toolResultText).toContain("hi");
    expect(detail.toc?.length).toBeGreaterThan(0);
    expect(detail.toc?.[0]?.label).toBe("Tool: run_command");
    expect(detail.toc?.[0]?.eventKind).toBe("tool_use");

    const traceBySession = await server.inject({ method: "GET", url: `/api/trace/${fixture.sessionId}` });
    expect(traceBySession.statusCode).toBe(200);

    const stopRes = await server.inject({ method: "POST", url: `/api/trace/${traceId}/stop` });
    expect(stopRes.statusCode).toBe(200);
    const stopPayload = stopRes.json() as {
      ok: boolean;
      status: string;
      signal: string;
      pids: number[];
      alivePids: number[];
    };
    expect(stopPayload.ok).toBe(true);
    expect(stopPayload.status).toBe("terminated");
    expect(stopPayload.signal).toBe("SIGINT");
    expect(stopPayload.pids).toEqual([4242]);
    expect(stopPayload.alivePids).toEqual([]);
    expect(stopTraceSession).toHaveBeenCalledTimes(1);
    expect(stopTraceSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: fixture.sessionId }),
      expect.objectContaining({ requesterPid: expect.any(Number), sessionCwd: "/tmp/proj" }),
    );

    const openRes = await server.inject({ method: "POST", url: `/api/trace/${traceId}/open` });
    expect(openRes.statusCode).toBe(200);
    expect(openRes.json()).toMatchObject({
      ok: true,
      status: "focused_pane",
      pid: 4242,
      tty: "/dev/ttys018",
      target: {
        tmuxSession: "main",
        windowIndex: 2,
        paneIndex: 1,
      },
      pids: [4242],
      alivePids: [4242],
    });
    expect(openTraceSession).toHaveBeenCalledTimes(1);
    expect(openTraceSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: fixture.sessionId }),
      expect.objectContaining({ requesterPid: expect.any(Number), sessionCwd: "/tmp/proj" }),
    );

    openTraceSession.mockResolvedValueOnce({
      status: "not_resolvable",
      reason: "no active session process found",
      pid: null,
      tty: "",
      target: null,
      matchedPids: [],
      alivePids: [],
    });
    const openNotResolvable = await server.inject({ method: "POST", url: `/api/trace/${traceId}/open` });
    expect(openNotResolvable.statusCode).toBe(409);
    expect(openNotResolvable.json()).toMatchObject({
      ok: false,
      status: "not_resolvable",
      error: "no active session process found",
    });

    stopTraceSession.mockResolvedValueOnce({
      status: "not_running",
      reason: "no active session process found",
      signal: null,
      matchedPids: [],
      alivePids: [],
    });
    const stopNotRunning = await server.inject({ method: "POST", url: `/api/trace/${traceId}/stop` });
    expect(stopNotRunning.statusCode).toBe(409);
    expect(stopNotRunning.json()).toMatchObject({
      ok: false,
      status: "not_running",
      error: "no active session process found",
    });

    const openUnknown = await server.inject({ method: "POST", url: "/api/trace/unknown/open" });
    expect(openUnknown.statusCode).toBe(404);
    expect(openUnknown.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("unknown trace/session"),
    });

    const configPatch = await server.inject({
      method: "POST",
      url: "/api/config",
      payload: { scan: { intervalSeconds: 3 }, cost: { enabled: false } },
    });
    expect(configPatch.statusCode).toBe(200);
    const configPayload = configPatch.json() as {
      config: {
        scan: { intervalSeconds: number };
        cost: { enabled: boolean; modelRates: Array<{ model: string }> };
      };
    };
    expect(configPayload.config.scan.intervalSeconds).toBe(3);
    expect(configPayload.config.cost.enabled).toBe(false);
    expect(configPayload.config.cost.modelRates[0]?.model).toBe("gpt-5.3-codex");

    await server.close();
  });
});
