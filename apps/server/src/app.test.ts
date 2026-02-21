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
  });

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
    expect(configPayload.config.cost.modelRates[0]?.model).toBe("gpt-5.3-codex");

    await server.close();
  });
});
