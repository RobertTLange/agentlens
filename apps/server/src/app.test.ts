import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeConfig, saveConfig, TraceIndex } from "@agentlens/core";
import {
  createServer,
  extractCursorSessionIdsFromOpenPaths,
  extractOpenCodeSessionIdsFromLogContent,
  geminiLogsContainSessionId,
  geminiProjectHashFromTracePath,
  geminiProjectHashesFromCwd,
  geminiProjectKeyFromTracePath,
  geminiProjectSlugsFromCwd,
  inferSessionCwd,
  matchesCurrentUser,
  parseTmuxClients,
  resolveDefaultWebDistPath,
  extractClaudeDebugProcessPid,
  selectAgentProcessPidsBySessionId,
  selectPreferredTmuxClient,
  selectOpenFileProcessPids,
  selectAgentProjectProcessPids,
  selectClaudeProjectProcessPids,
  selectCursorProjectProcessPids,
  selectGeminiProjectProcessPids,
  selectPidGroupByNearestTimestamp,
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

async function buildFixtureWithCustomTrace(
  traceLog: string,
  sessionId: string,
): Promise<{ configPath: string; index: TraceIndex; sessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-server-custom-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });
  await writeFile(path.join(codexRoot, "custom-trace.jsonl"), traceLog, "utf8");

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
  return { configPath, index, sessionId };
}

describe("server api", () => {
  it("infers session cwd from both session_meta and session events", async () => {
    const codexDetail = {
      events: [{ rawType: "session_meta", raw: { payload: { cwd: " /tmp/codex " } } }],
    } as unknown as Parameters<typeof inferSessionCwd>[0];
    const piDetail = {
      events: [{ rawType: "session", raw: { cwd: " /tmp/pi " } }],
    } as unknown as Parameters<typeof inferSessionCwd>[0];

    expect(inferSessionCwd(codexDetail)).toBe("/tmp/codex");
    expect(inferSessionCwd(piDetail)).toBe("/tmp/pi");
  });

  it("matches process owner by username and numeric uid", async () => {
    expect(matchesCurrentUser("rob", { username: "rob", uid: "501" })).toBe(true);
    expect(matchesCurrentUser("501", { username: "rob", uid: "501" })).toBe(true);
    expect(matchesCurrentUser("other", { username: "rob", uid: "501" })).toBe(false);
  });

  it("selects tty pid group nearest to a target timestamp", async () => {
    const selected = selectPidGroupByNearestTimestamp(
      [
        { pid: 22125, tty: "/dev/ttys062", startedAtMs: Date.UTC(2026, 1, 20, 14, 33, 13) },
        { pid: 22268, tty: "/dev/ttys062", startedAtMs: Date.UTC(2026, 1, 20, 14, 33, 24) },
        { pid: 12511, tty: "/dev/ttys043", startedAtMs: Date.UTC(2026, 1, 20, 15, 29, 19) },
        { pid: 12653, tty: "/dev/ttys043", startedAtMs: Date.UTC(2026, 1, 20, 15, 29, 23) },
      ],
      Date.UTC(2026, 1, 20, 14, 30, 7),
    );
    expect(selected).toEqual([22125, 22268]);
  });

  it("returns empty nearest-timestamp selection on tie distances", async () => {
    const selected = selectPidGroupByNearestTimestamp(
      [
        { pid: 1, tty: "/dev/ttys001", startedAtMs: Date.UTC(2026, 1, 20, 14, 30, 0) },
        { pid: 2, tty: "/dev/ttys002", startedAtMs: Date.UTC(2026, 1, 20, 14, 34, 0) },
      ],
      Date.UTC(2026, 1, 20, 14, 32, 0),
    );
    expect(selected).toEqual([]);
  });

  it("extracts cursor session ids from open cursor chat sqlite paths", async () => {
    const sessionIds = extractCursorSessionIdsFromOpenPaths([
      "/Users/rob/.cursor/chats/6495969ecf39864527998827d28315cf/61ebb431-fb1e-4f54-95ae-37fd618dcd7b/store.db",
      "/Users/rob/.cursor/chats/6495969ecf39864527998827d28315cf/61ebb431-fb1e-4f54-95ae-37fd618dcd7b/store.db-wal",
      "/Users/rob/.cursor/chats/6495969ecf39864527998827d28315cf/00000000-0000-0000-0000-000000000000/store.db-shm",
      "/Users/rob/.cursor/ai-tracking/ai-code-tracking.db",
    ]);

    expect(sessionIds).toEqual([
      "61ebb431-fb1e-4f54-95ae-37fd618dcd7b",
      "00000000-0000-0000-0000-000000000000",
    ]);
  });

  it("extracts opencode session ids from runtime logs", async () => {
    const sessionIds = extractOpenCodeSessionIdsFromLogContent(
      [
        "INFO service=llm sessionID=ses_384b9485fffe16L9n0yOcy6UP2 stream",
        "INFO service=session.prompt sessionID=ses_384b9485fffe16L9n0yOcy6UP2 loop",
        "INFO service=session.prompt sessionID=ses_38dea287bffeJsge8iSz4N9Lal loop",
      ].join("\n"),
    );

    expect(sessionIds).toEqual([
      "ses_384b9485fffe16L9n0yOcy6UP2",
      "ses_38dea287bffeJsge8iSz4N9Lal",
    ]);
  });

  it("checks gemini logs for session ids across json and fallback text modes", async () => {
    expect(
      geminiLogsContainSessionId(
        JSON.stringify([
          { sessionId: "54bc8ff5-57e7-4741-8bbc-18125dc656d0", messageId: 0, type: "user" },
          { sessionId: "another-session", messageId: 1, type: "user" },
        ]),
        "54bc8ff5-57e7-4741-8bbc-18125dc656d0",
      ),
    ).toBe(true);
    expect(
      geminiLogsContainSessionId(
        "line with sessionId 54bc8ff5-57e7-4741-8bbc-18125dc656d0 in malformed payload",
        "54bc8ff5-57e7-4741-8bbc-18125dc656d0",
      ),
    ).toBe(true);
    expect(
      geminiLogsContainSessionId(
        JSON.stringify([{ sessionId: "different-session", messageId: 0, type: "user" }]),
        "54bc8ff5-57e7-4741-8bbc-18125dc656d0",
      ),
    ).toBe(false);
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

  it("extracts the most recent claude process pid from debug log lines", async () => {
    const pid = extractClaudeDebugProcessPid(
      [
        "2026-02-20T13:18:11.060Z [DEBUG] Writing to temp file: /Users/rob/.claude.json.tmp.2440.1771593491060",
        "2026-02-20T13:18:25.075Z [DEBUG] Writing to temp file: /Users/rob/.claude.json.tmp.2493.1771593505075",
      ].join("\n"),
    );
    expect(pid).toBe(2493);
  });

  it("falls back to acquired pid lock when no temp-write pid lines exist", async () => {
    const pid = extractClaudeDebugProcessPid(
      [
        "2026-02-20T13:18:11.060Z [DEBUG] Acquired PID lock for 2.1.49 (PID 2440)",
        "2026-02-20T13:18:25.075Z [DEBUG] Acquired PID lock for 2.1.49 (PID 2493)",
      ].join("\n"),
    );
    expect(pid).toBe(2493);
  });

  it("matches open-file candidates by full process args when lsof command is generic", async () => {
    const selected = selectOpenFileProcessPids({
      summary: {
        agent: "claude",
        sessionId: "2356bd53-2142-4bad-a14f-a04e50069f51",
      },
      openFileProcesses: [
        {
          pid: 9101,
          command: "node",
          user: "rob",
        },
      ],
      argsByPid: new Map<number, string>([
        [9101, "node /usr/local/bin/claude --dangerously-skip-permissions"],
      ]),
      identity: { username: "rob", uid: "501" },
      requesterPid: 1000,
    });

    expect(selected).toEqual([9101]);
  });

  it("prefers open-file candidate whose args include selected session id", async () => {
    const sessionId = "2356bd53-2142-4bad-a14f-a04e50069f51";
    const selected = selectOpenFileProcessPids({
      summary: {
        agent: "claude",
        sessionId,
      },
      openFileProcesses: [
        {
          pid: 9102,
          command: "node",
          user: "rob",
        },
        {
          pid: 9103,
          command: "node",
          user: "rob",
        },
      ],
      argsByPid: new Map<number, string>([
        [9102, "node /usr/local/bin/claude --dangerously-skip-permissions"],
        [9103, `node /usr/local/bin/claude --resume ${sessionId}`],
      ]),
      identity: { username: "rob", uid: "501" },
      requesterPid: 1000,
    });

    expect(selected).toEqual([9103]);
  });

  it("falls back to a single same-user open-file process when args are unavailable", async () => {
    const selected = selectOpenFileProcessPids({
      summary: {
        agent: "claude",
        sessionId: "2356bd53-2142-4bad-a14f-a04e50069f51",
      },
      openFileProcesses: [
        {
          pid: 9104,
          command: "node",
          user: "rob",
        },
      ],
      argsByPid: new Map<number, string>(),
      identity: { username: "rob", uid: "501" },
      requesterPid: 1000,
    });

    expect(selected).toEqual([9104]);
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

  it("returns no claude fallback process when project match is ambiguous and args lack session id", async () => {
    const sessionId = "2356bd53-2142-4bad-a14f-a04e50069f51";
    const selected = selectClaudeProjectProcessPids(
      {
        path: `/Users/rob/.claude/projects/-Users-rob-Dropbox-2026-sakana-agentlens/${sessionId}.jsonl`,
        sessionId,
      },
      [
        {
          pid: 7011,
          user: "rob",
          args: "claude --dangerously-skip-permissions",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 7012,
          user: "rob",
          args: "claude --dangerously-skip-permissions",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([]);
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

  it("returns no agent fallback process when project match is ambiguous and args lack session id", async () => {
    const sessionId = "codex-session-123";
    const selected = selectAgentProjectProcessPids(
      "/Users/rob/Dropbox/2026_sakana/agentlens",
      sessionId,
      "codex",
      [
        {
          pid: 6221,
          user: "rob",
          args: "node /Users/rob/.local/bin/codex --dangerously-bypass-approvals-and-sandbox",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 6222,
          user: "rob",
          args: "node /Users/rob/.local/bin/codex --dangerously-bypass-approvals-and-sandbox",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([]);
  });

  it("selects gemini fallback process by matching project cwd", async () => {
    const selected = selectAgentProjectProcessPids(
      "/Users/rob/Dropbox/2026_sakana/agentlens",
      "50641617-dd96-45e6-9649-0b711b8073ae",
      "gemini",
      [
        {
          pid: 6211,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini --resume 50641617-dd96-45e6-9649-0b711b8073ae",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
        {
          pid: 6212,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/another-project",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([6211]);
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

  it("falls back to gemini session-id matching when cwd is unavailable", async () => {
    const sessionId = "50641617-dd96-45e6-9649-0b711b8073ae";
    const selected = selectAgentProcessPidsBySessionId(
      sessionId,
      "gemini",
      [
        {
          pid: 6321,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
        },
        {
          pid: 6322,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini --resume 50641617-dd96-45e6-9649-0b711b8073ae",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([6322]);
  });

  it("falls back to pi session-id matching with strict pi command detection", async () => {
    const sessionId = "21e08b85-59b6-4acb-9811-a9dead258501";
    const selected = selectAgentProcessPidsBySessionId(
      sessionId,
      "pi",
      [
        {
          pid: 68074,
          user: "rob",
          args: "pi --resume 21e08b85-59b6-4acb-9811-a9dead258501",
        },
        {
          pid: 68075,
          user: "rob",
          args: "bash /tmp/run.sh --agent pi --resume 21e08b85-59b6-4acb-9811-a9dead258501",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([68074]);
  });

  it("matches pi open-file candidates only when process args resolve to pi command", async () => {
    const sessionId = "21e08b85-59b6-4acb-9811-a9dead258501";
    const selected = selectOpenFileProcessPids({
      summary: {
        agent: "pi",
        sessionId,
      },
      openFileProcesses: [
        {
          pid: 7001,
          command: "bash",
          user: "rob",
        },
        {
          pid: 7002,
          command: "npx",
          user: "rob",
        },
      ],
      argsByPid: new Map<number, string>([
        [7001, "bash /tmp/run.sh --agent pi --resume 21e08b85-59b6-4acb-9811-a9dead258501"],
        [7002, "npx --yes @mariozechner/pi-coding-agent --resume 21e08b85-59b6-4acb-9811-a9dead258501"],
      ]),
      identity: { username: "rob", uid: "501" },
      requesterPid: 1000,
    });

    expect(selected).toEqual([7002]);
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

  it("returns no cursor fallback process when project match is ambiguous and args lack session id", async () => {
    const sessionId = "81907d70-7e5c-45d8-bbbb-22f66e9878f0";
    const selected = selectCursorProjectProcessPids(
      {
        path: `/Users/rob/.cursor/projects/Users-rob-Dropbox-Mac-2-Desktop/agent-transcripts/${sessionId}.txt`,
        sessionId,
      },
      [
        {
          pid: 53131,
          user: "rob",
          args: "/Users/rob/.local/bin/agent --use-system-ca /Users/rob/.local/share/cursor-agent/versions/2026.01.28-fd13201/index.js",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
        {
          pid: 53132,
          user: "rob",
          args: "/Users/rob/.local/bin/agent --use-system-ca /Users/rob/.local/share/cursor-agent/versions/2026.01.28-fd13201/index.js",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([]);
  });

  it("derives gemini project hash from trace path and cwd", async () => {
    const projectCwd = "/Users/rob/Dropbox/Mac (2)/Desktop";
    const projectHash = "31961e5d2f9bdd62bbd56b581966e1a817d9d362afc8a1be751cf476cfdb454d";
    expect(
      geminiProjectHashFromTracePath(
        `/Users/rob/.gemini/tmp/${projectHash}/chats/session-2026-02-17T01-07-50641617.json`,
      ),
    ).toBe(projectHash);
    expect(geminiProjectHashesFromCwd(projectCwd)).toContain(projectHash);
  });

  it("derives gemini project key and cwd slug for non-hash tmp directories", async () => {
    const projectCwd = "/Users/rob/Dropbox/2026_sakana/robs_homepage";
    expect(
      geminiProjectKeyFromTracePath(
        "/Users/rob/.gemini/tmp/robs-homepage/chats/session-2026-02-20T14-29-cb0f65b5.json",
      ),
    ).toBe("robs-homepage");
    expect(geminiProjectSlugsFromCwd(projectCwd)).toContain("robs-homepage");
  });

  it("selects gemini fallback process by matching gemini project slug cwd", async () => {
    const sessionId = "cb0f65b5-35fe-4588-9b44-47b7316204fa";
    const selected = selectGeminiProjectProcessPids(
      {
        path: "/Users/rob/.gemini/tmp/robs-homepage/chats/session-2026-02-20T14-29-cb0f65b5.json",
        sessionId,
      },
      [
        {
          pid: 22125,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/2026_sakana/robs_homepage",
        },
        {
          pid: 22126,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([22125]);
  });

  it("selects gemini fallback process by matching gemini project hash", async () => {
    const sessionId = "50641617-dd96-45e6-9649-0b711b8073ae";
    const selected = selectGeminiProjectProcessPids(
      {
        path: `/Users/rob/.gemini/tmp/31961e5d2f9bdd62bbd56b581966e1a817d9d362afc8a1be751cf476cfdb454d/chats/session-2026-02-17T01-07-50641617.json`,
        sessionId,
      },
      [
        {
          pid: 64100,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
        {
          pid: 64101,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([64100]);
  });

  it("prefers gemini hash-matched process whose args include selected session id", async () => {
    const sessionId = "50641617-dd96-45e6-9649-0b711b8073ae";
    const selected = selectGeminiProjectProcessPids(
      {
        path: `/Users/rob/.gemini/tmp/31961e5d2f9bdd62bbd56b581966e1a817d9d362afc8a1be751cf476cfdb454d/chats/session-2026-02-17T01-07-50641617.json`,
        sessionId,
      },
      [
        {
          pid: 64110,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
        {
          pid: 64111,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini --resume 50641617-dd96-45e6-9649-0b711b8073ae",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([64111]);
  });

  it("returns no gemini fallback process when hash match is ambiguous and args lack session id", async () => {
    const sessionId = "50641617-dd96-45e6-9649-0b711b8073ae";
    const selected = selectGeminiProjectProcessPids(
      {
        path: `/Users/rob/.gemini/tmp/31961e5d2f9bdd62bbd56b581966e1a817d9d362afc8a1be751cf476cfdb454d/chats/session-2026-02-17T01-07-50641617.json`,
        sessionId,
      },
      [
        {
          pid: 64121,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
        {
          pid: 64122,
          user: "rob",
          args: "node /Users/rob/.local/bin/gemini",
          cwd: "/Users/rob/Dropbox/Mac (2)/Desktop",
        },
      ],
      { username: "rob", uid: "501" },
      1000,
    );

    expect(selected).toEqual([]);
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
  }, 20_000);

  it("serves local-day agent activity bins with break markers and dominant colors", async () => {
    const fixture = await buildFixtureWithTraceCount(3);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/activity/day?date=2026-02-11&tz_offset_min=0&bin_min=5&break_min=10",
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      activity: {
        dateLocal: string;
        binMinutes: number;
        breakMinutes: number;
        totalSessionsInWindow: number;
        bins: Array<{
          startMs: number;
          activeSessionCount: number;
          dominantAgent: string;
          dominantEventKind: string;
          eventCount: number;
          isBreak: boolean;
        }>;
      };
    };
    expect(payload.activity.dateLocal).toBe("2026-02-11");
    expect(payload.activity.binMinutes).toBe(5);
    expect(payload.activity.breakMinutes).toBe(10);
    expect(payload.activity.bins[0]?.startMs).toBe(Date.UTC(2026, 1, 11, 7, 0, 0));
    expect(payload.activity.bins[1]?.startMs).toBe(Date.UTC(2026, 1, 11, 7, 5, 0));
    expect(payload.activity.totalSessionsInWindow).toBe(3);
    expect(payload.activity.bins.length).toBeGreaterThan(200);
    const activeBins = payload.activity.bins.filter((bin) => bin.activeSessionCount > 0);
    expect(activeBins.length).toBeGreaterThan(0);
    expect(activeBins.every((bin) => bin.dominantAgent === "codex")).toBe(true);
    expect(payload.activity.bins.some((bin) => bin.isBreak)).toBe(true);
    expect(payload.activity.bins.some((bin) => bin.eventCount > 0 && bin.dominantEventKind !== "none")).toBe(true);

    await server.close();
  }, 20_000);

  it("serves weekly heatmap activity windows from 6am to 2am", async () => {
    const fixture = await buildFixtureWithTraceCount(3);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/activity/week?end_date=2026-02-11&tz_offset_min=0&day_count=7&slot_min=30&hour_start=6&hour_end=2",
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      activity: {
        dayCount: number;
        slotMinutes: number;
        hourStartLocal: number;
        hourEndLocal: number;
        days: Array<{ dateLocal: string; bins: Array<{ startMs: number; activeSessionCount: number }> }>;
      };
    };

    expect(payload.activity.dayCount).toBe(7);
    expect(payload.activity.slotMinutes).toBe(30);
    expect(payload.activity.hourStartLocal).toBe(6);
    expect(payload.activity.hourEndLocal).toBe(2);
    expect(payload.activity.days).toHaveLength(7);
    expect(payload.activity.days.every((day) => day.bins.length === 40)).toBe(true);
    expect(payload.activity.days.some((day) => day.bins.some((bin) => bin.activeSessionCount > 0))).toBe(true);
    expect(payload.activity.days[0]?.dateLocal).toBe("2026-02-05");
    expect(payload.activity.days[6]?.dateLocal).toBe("2026-02-11");
    expect(payload.activity.days[0]?.bins[0]?.startMs).toBe(Date.UTC(2026, 1, 5, 6, 0, 0));
    expect(payload.activity.days[0]?.bins[1]?.startMs).toBe(Date.UTC(2026, 1, 5, 6, 30, 0));

    await server.close();
  }, 20_000);

  it("supports year-to-date style activity windows with daily aggregation", async () => {
    const fixture = await buildFixtureWithTraceCount(3);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/activity/week?end_date=2026-02-22&tz_offset_min=0&day_count=53&slot_min=30&hour_start=7&hour_end=7",
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      activity: {
        dayCount: number;
        days: Array<{ dateLocal: string; bins: Array<unknown> }>;
      };
    };

    expect(payload.activity.dayCount).toBe(53);
    expect(payload.activity.days).toHaveLength(53);
    expect(payload.activity.days[0]?.dateLocal).toBe("2026-01-01");
    expect(payload.activity.days[52]?.dateLocal).toBe("2026-02-22");
    expect(payload.activity.days.every((day) => day.bins.length === 48)).toBe(true);

    await server.close();
  }, 20_000);

  it("returns validation errors for invalid activity day query params", async () => {
    const fixture = await buildFixtureWithTraceCount(1);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const invalidDate = await server.inject({
      method: "GET",
      url: "/api/activity/day?date=2026-99-11&tz_offset_min=0",
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.json()).toEqual({ error: "invalid date" });

    const invalidTz = await server.inject({
      method: "GET",
      url: "/api/activity/day?date=2026-02-11&tz_offset_min=abc",
    });
    expect(invalidTz.statusCode).toBe(400);
    expect(invalidTz.json()).toEqual({ error: "invalid tz_offset_min" });

    await server.close();
  }, 20_000);

  it("returns validation errors for invalid activity week params and supports equal hour windows", async () => {
    const fixture = await buildFixtureWithTraceCount(1);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const invalidSlot = await server.inject({
      method: "GET",
      url: "/api/activity/week?end_date=2026-02-11&tz_offset_min=0&slot_min=abc",
    });
    expect(invalidSlot.statusCode).toBe(400);
    expect(invalidSlot.json()).toEqual({ error: "invalid slot_min" });

    const equalHourWindow = await server.inject({
      method: "GET",
      url: "/api/activity/week?end_date=2026-02-11&tz_offset_min=0&hour_start=6&hour_end=6",
    });
    expect(equalHourWindow.statusCode).toBe(200);
    const equalHourPayload = equalHourWindow.json() as {
      activity: {
        hourStartLocal: number;
        hourEndLocal: number;
        days: Array<{ bins: Array<unknown> }>;
      };
    };
    expect(equalHourPayload.activity.hourStartLocal).toBe(6);
    expect(equalHourPayload.activity.hourEndLocal).toBe(6);
    expect(equalHourPayload.activity.days[0]?.bins.length).toBe(48);

    await server.close();
  }, 20_000);

  it("filters out idle session gaps with no events for over twenty minutes", async () => {
    const sessionId = "server-session-gap";
    const traceLog = [
      JSON.stringify({
        timestamp: "2026-02-11T07:00:00.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T07:05:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_gap_1",
          name: "run_command",
          call_id: "call_gap_1",
          arguments: "{\"command\":\"echo hi\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T07:06:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_gap_1",
          output: "hi",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T13:00:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_gap_2",
          name: "run_command",
          call_id: "call_gap_2",
          arguments: "{\"command\":\"echo later\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T13:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_gap_2",
          output: "later",
        },
      }),
    ].join("\n");

    const fixture = await buildFixtureWithCustomTrace(traceLog, sessionId);
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/activity/day?date=2026-02-11&tz_offset_min=0&bin_min=5&break_min=10",
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as {
      activity: {
        totalSessionsInWindow: number;
        bins: Array<{ startMs: number; activeSessionCount: number }>;
      };
    };
    expect(payload.activity.totalSessionsInWindow).toBe(1);

    const byStart = new Map(payload.activity.bins.map((bin) => [bin.startMs, bin.activeSessionCount]));
    expect(byStart.get(Date.UTC(2026, 1, 11, 7, 5, 0))).toBe(1);
    expect(byStart.get(Date.UTC(2026, 1, 11, 7, 10, 0))).toBe(0);
    expect(byStart.get(Date.UTC(2026, 1, 11, 10, 0, 0))).toBe(0);
    expect(byStart.get(Date.UTC(2026, 1, 11, 13, 0, 0))).toBe(1);

    await server.close();
  }, 20_000);

  it("serves overview, trace listing, trace details, stop/open controls, and config updates", async () => {
    const fixture = await buildFixture();
    const stopTraceSession = vi.fn();
    const openTraceSession = vi.fn();
    const sendTraceInput = vi.fn();
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
    sendTraceInput.mockResolvedValue({
      status: "sent_tmux" as const,
      reason: "sent input to tmux pane",
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
      sendTraceInput,
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
      summary: { sessionId: string; path: string };
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
    const traceFilePath = detail.summary.path;
    const traceFileToken = Buffer.from(traceFilePath, "utf8").toString("base64url");
    const traceByFile = await server.inject({ method: "GET", url: `/api/tracefile?path=${encodeURIComponent(traceFileToken)}` });
    expect(traceByFile.statusCode).toBe(200);
    expect(traceByFile.json()).toMatchObject({
      summary: {
        path: traceFilePath,
        sessionId: fixture.sessionId,
      },
    });
    const traceByFileMeta = await server.inject({
      method: "GET",
      url: `/api/tracefile?path=${encodeURIComponent(traceFileToken)}&include_meta=1&limit=1`,
    });
    expect(traceByFileMeta.statusCode).toBe(200);
    expect((traceByFileMeta.json() as { events: unknown[] }).events.length).toBe(1);
    const traceByFileInvalidToken = await server.inject({ method: "GET", url: "/api/tracefile?path=%2A%2A%2A" });
    expect(traceByFileInvalidToken.statusCode).toBe(400);
    expect(traceByFileInvalidToken.json()).toEqual({
      error: "invalid trace file token",
    });
    const missingPathToken = Buffer.from("/tmp/agentlens-missing-file.jsonl", "utf8").toString("base64url");
    const traceByFileMissing = await server.inject({
      method: "GET",
      url: `/api/tracefile?path=${encodeURIComponent(missingPathToken)}`,
    });
    expect(traceByFileMissing.statusCode).toBe(404);
    expect(traceByFileMissing.json()).toEqual({
      error: "trace file not found",
    });

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

    const inputRes = await server.inject({
      method: "POST",
      url: `/api/trace/${traceId}/input`,
      payload: { text: "Continue", submit: true },
    });
    expect(inputRes.statusCode).toBe(200);
    expect(inputRes.json()).toMatchObject({
      ok: true,
      status: "sent_tmux",
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
    expect(sendTraceInput).toHaveBeenCalledTimes(1);
    expect(sendTraceInput).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: fixture.sessionId }),
      expect.objectContaining({
        requesterPid: expect.any(Number),
        sessionCwd: "/tmp/proj",
        text: "Continue",
        submit: true,
      }),
    );

    const inputTooLong = await server.inject({
      method: "POST",
      url: `/api/trace/${traceId}/input`,
      payload: { text: "x".repeat(2001) },
    });
    expect(inputTooLong.statusCode).toBe(400);
    expect(inputTooLong.json()).toMatchObject({
      ok: false,
      error: "input text too long (max 2000 chars)",
    });
    expect(sendTraceInput).toHaveBeenCalledTimes(1);

    const inputEmpty = await server.inject({
      method: "POST",
      url: `/api/trace/${traceId}/input`,
      payload: { text: "   " },
    });
    expect(inputEmpty.statusCode).toBe(400);
    expect(inputEmpty.json()).toMatchObject({
      ok: false,
      error: "input text is required",
    });
    expect(sendTraceInput).toHaveBeenCalledTimes(1);

    sendTraceInput.mockResolvedValueOnce({
      status: "not_resolvable",
      reason: "no active session process found",
      pid: null,
      tty: "",
      target: null,
      matchedPids: [],
      alivePids: [],
    });
    const inputNotResolvable = await server.inject({
      method: "POST",
      url: `/api/trace/${traceId}/input`,
      payload: { text: "Continue" },
    });
    expect(inputNotResolvable.statusCode).toBe(409);
    expect(inputNotResolvable.json()).toMatchObject({
      ok: false,
      status: "not_resolvable",
      error: "no active session process found",
    });
    expect(sendTraceInput).toHaveBeenCalledTimes(2);

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

    const inputUnknown = await server.inject({
      method: "POST",
      url: "/api/trace/unknown/input",
      payload: { text: "Continue" },
    });
    expect(inputUnknown.statusCode).toBe(404);
    expect(inputUnknown.json()).toMatchObject({
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
    expect(configPayload.config.cost.modelRates.some((rate) => rate.model === "gpt-5.3-codex")).toBe(true);

    await server.close();
  }, 20_000);

  it("serves web index for trace-file deep-link routes when static assets exist", async () => {
    const fixture = await buildFixture();
    const webDistPath = await mkdtemp(path.join(os.tmpdir(), "agentlens-web-dist-"));
    await writeFile(path.join(webDistPath, "index.html"), "<!doctype html><html><body>trace-file-deep-link</body></html>", "utf8");
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      webDistPath,
      enableStatic: true,
    });

    const response = await server.inject({ method: "GET", url: "/trace-file/demo-token" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("trace-file-deep-link");

    await server.close();
  });
});
