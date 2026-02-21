import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeConfig, saveConfig } from "@agentlens/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const tsxBin = path.resolve(repoRoot, "node_modules/.bin/tsx");
const cliMain = path.resolve(repoRoot, "apps/cli/src/main.ts");

function buildFixtureConfig(codexSessionsRoot: string) {
  return mergeConfig({
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
    sources: {
      codex_home: {
        name: "codex_home",
        enabled: true,
        roots: [codexSessionsRoot],
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
}

async function buildFixture(): Promise<{ configPath: string; sessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cli-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });

  const sessionId = "cli-session-1";
  const tracePath = path.join(codexRoot, "rollout.jsonl");
  await writeFile(
    tracePath,
    [
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:02.000Z",
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
        timestamp: "2026-02-11T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "hi",
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const config = buildFixtureConfig(path.join(root, ".codex", "sessions"));

  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);
  return { configPath, sessionId };
}

async function buildLatestFixture(): Promise<{ configPath: string; latestSessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cli-latest-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });

  const oldSessionId = "cli-session-old";
  const latestSessionId = "cli-session-new";

  await writeFile(
    path.join(codexRoot, "older.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-02-11T09:00:00.000Z",
        type: "session_meta",
        payload: { id: oldSessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T09:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "old hello" }],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(codexRoot, "newer.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-02-11T11:00:00.000Z",
        type: "session_meta",
        payload: { id: latestSessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T11:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "new hello" }],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const config = buildFixtureConfig(path.join(root, ".codex", "sessions"));

  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);
  return { configPath, latestSessionId };
}

async function buildEmptyFixture(): Promise<{ configPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cli-empty-"));
  const codexRoot = path.join(root, ".codex", "sessions");
  await mkdir(codexRoot, { recursive: true });

  const config = buildFixtureConfig(codexRoot);

  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);
  return { configPath };
}

async function buildManySessionsFixture(count: number): Promise<{ configPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cli-many-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });

  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const sessionId = `cli-many-${String(index).padStart(3, "0")}`;
    const timestamp = new Date(now - index * 60_000).toISOString();
    await writeFile(
      path.join(codexRoot, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp,
          type: "session_meta",
          payload: { id: sessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `hello ${index}` }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
  }

  const config = buildFixtureConfig(path.join(root, ".codex", "sessions"));
  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);
  return { configPath };
}

async function buildRecencyFixture(): Promise<{ configPath: string; newestSessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cli-recency-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });

  const now = Date.now();
  const rows = [
    { sessionId: "cli-recency-today", timestampMs: now - 2 * 60 * 60 * 1000 },
    { sessionId: "cli-recency-week", timestampMs: now - 2 * 24 * 60 * 60 * 1000 },
    { sessionId: "cli-recency-old", timestampMs: now - 10 * 24 * 60 * 60 * 1000 },
  ];

  for (const row of rows) {
    const timestamp = new Date(row.timestampMs).toISOString();
    await writeFile(
      path.join(codexRoot, `${row.sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp,
          type: "session_meta",
          payload: { id: row.sessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
        }),
        JSON.stringify({
          timestamp,
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `message ${row.sessionId}` }],
          },
        }),
      ].join("\n"),
      "utf8",
    );
  }

  const config = buildFixtureConfig(path.join(root, ".codex", "sessions"));
  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);
  return { configPath, newestSessionId: rows[0]?.sessionId ?? "cli-recency-today" };
}

function runCli(args: string[]): string {
  return runCliWithEnv(args);
}

function runCliWithEnv(args: string[], extraEnv: NodeJS.ProcessEnv = {}): string {
  return execFileSync(tsxBin, [cliMain, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  }).trim();
}

async function runCliWithEnvAsync(args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      tsxBin,
      [cliMain, ...args],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, ...extraEnv },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${String(stderr)}`));
          return;
        }
        resolve(String(stdout).trim());
      },
    );
  });
}

function runCliFailure(args: string[]): string {
  try {
    runCli(args);
    throw new Error("expected command to fail");
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    return String(failure.stderr ?? "");
  }
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate test port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return address.port;
}

async function startHealthServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === "/api/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start health server");
  }
  return {
    port: address.port,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function waitForHealth(url: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean };
        if (body.ok === true) {
          return;
        }
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server never became healthy: ${url}`);
}

async function stopProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // no-op
  }
}

describe("cli", () => {
  it("supports summary, sessions list/show/events outputs", async () => {
    const fixture = await buildFixture();

    const summary = JSON.parse(runCli(["--config", fixture.configPath, "summary", "--json"])) as {
      traces: number;
      sessions: number;
      events: number;
      topTools?: Array<{ name: string; count: number }>;
    };
    expect(summary.traces).toBe(1);
    expect(summary.sessions).toBe(1);
    expect(summary.events).toBeGreaterThan(1);
    expect(summary.topTools?.[0]?.name).toBe("run_command");
    expect(summary.topTools?.[0]?.count).toBe(1);

    const list = JSON.parse(runCli(["--config", fixture.configPath, "sessions", "list", "--json"])) as Array<{
      id: string;
      sessionId: string;
    }>;
    expect(list.length).toBe(1);
    expect(list[0]?.sessionId).toBe(fixture.sessionId);

    const show = JSON.parse(
      runCli(["--config", fixture.configPath, "session", fixture.sessionId, "--json"]),
    ) as { summary: { sessionId: string }; events: unknown[] };
    expect(show.summary.sessionId).toBe(fixture.sessionId);
    expect(show.events.length).toBeGreaterThan(0);

    const sessionDetail = JSON.parse(
      runCli(["--config", fixture.configPath, "session", fixture.sessionId, "--json", "--show-tools"]),
    ) as {
      summary: { sessionId: string };
      events: Array<{ toolArgsText?: string; toolResultText?: string }>;
    };
    expect(sessionDetail.summary.sessionId).toBe(fixture.sessionId);
    expect(sessionDetail.events.some((event) => String(event.toolArgsText ?? "").includes("echo hi"))).toBe(true);
    expect(sessionDetail.events.some((event) => String(event.toolResultText ?? "").includes("hi"))).toBe(true);

    const eventsOutput = runCli([
      "--config",
      fixture.configPath,
      "sessions",
      "events",
      fixture.sessionId,
      "--jsonl",
      "--limit",
      "2",
    ]);
    const eventLines = eventsOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(eventLines.length).toBe(2);
    const parsed = JSON.parse(eventLines[0] ?? "{}") as { index?: number };
    expect(parsed.index).toBeTypeOf("number");
  });

  it("renders deterministic llm summary/session/events tables for chained agent calls", async () => {
    const fixture = await buildFixture();

    const summaryLlm = runCli(["--config", fixture.configPath, "summary", "--llm"]);
    expect(summaryLlm).toContain("## overview");
    expect(summaryLlm).toContain("## by_status");
    expect(summaryLlm).toContain("## candidate_sessions");
    expect(summaryLlm).toContain("trace_id");
    expect(summaryLlm).toContain(fixture.sessionId);

    const sessionLlm = runCli(["--config", fixture.configPath, "session", fixture.sessionId, "--llm"]);
    expect(sessionLlm).toContain("## session_summary");
    expect(sessionLlm).toContain("## next_calls");
    expect(sessionLlm).toContain("agentlens sessions events");

    const eventsLlm = runCli(["--config", fixture.configPath, "sessions", "events", fixture.sessionId, "--llm", "--limit", "3"]);
    expect(eventsLlm).toContain("## events");
    expect(eventsLlm).toMatch(/idx\s+\|\s+kind\s+\|\s+time\s+\|\s+tool\s+\|\s+call_id\s+\|\s+preview/);
  });

  it("uses default sessions list limit of 50", async () => {
    const fixture = await buildManySessionsFixture(55);
    const list = JSON.parse(runCli(["--config", fixture.configPath, "sessions", "list", "--json"])) as Array<{
      id: string;
      sessionId: string;
    }>;
    expect(list.length).toBe(50);
  });

  it("supports llm recency grouping for historical sessions", async () => {
    const fixture = await buildRecencyFixture();
    const grouped = runCli(["--config", fixture.configPath, "sessions", "list", "--llm", "--group-by", "recency"]);
    expect(grouped).toContain("## today");
    expect(grouped).toContain("## last_7d");
    expect(grouped).toContain("## older");
    expect(grouped).toContain("cli-recency-today");
    expect(grouped).toContain("cli-recency-week");
    expect(grouped).toContain("cli-recency-old");
  });

  it("supports latest alias for session/show/events commands", async () => {
    const fixture = await buildLatestFixture();

    const sessionLatest = JSON.parse(
      runCli(["--config", fixture.configPath, "session", "latest", "--json"]),
    ) as { summary: { sessionId: string } };
    expect(sessionLatest.summary.sessionId).toBe(fixture.latestSessionId);

    const showLatest = JSON.parse(
      runCli(["--config", fixture.configPath, "sessions", "show", "latest", "--json"]),
    ) as { summary: { sessionId: string } };
    expect(showLatest.summary.sessionId).toBe(fixture.latestSessionId);

    const eventsOutput = runCli(["--config", fixture.configPath, "sessions", "events", "latest", "--jsonl", "--limit", "5"]);
    const eventLines = eventsOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    expect(eventLines.length).toBeGreaterThan(0);
    const parsed = eventLines.map((line) => JSON.parse(line) as { sessionId?: string; preview?: string });
    expect(parsed.every((event) => event.sessionId === fixture.latestSessionId)).toBe(true);
    expect(parsed.some((event) => String(event.preview ?? "").includes("new hello"))).toBe(true);
  });

  it("shows clear error when latest is requested with no sessions", async () => {
    const fixture = await buildEmptyFixture();
    const failureStderr = runCliFailure(["--config", fixture.configPath, "session", "latest"]);
    expect(failureStderr).toContain('no sessions found (cannot resolve "latest")');
  });

  it("shows usage for --help and no-args", () => {
    const helpOutput = runCli(["--help"]);
    expect(helpOutput).toContain("Usage: agentlens");
    expect(helpOutput).toContain("--browser");

    const noArgsOutput = runCli([]);
    expect(noArgsOutput).toContain("Usage: agentlens");
  });

  it("reuses running server in --browser mode", async () => {
    const healthServer = await startHealthServer();
    try {
      const output = await runCliWithEnvAsync(
        ["--browser", "--host", "127.0.0.1", "--port", String(healthServer.port)],
        { AGENTLENS_SKIP_OPEN: "1" },
      );
      expect(output).toContain(`AgentLens already running: http://127.0.0.1:${healthServer.port}`);
    } finally {
      await healthServer.close();
    }
  });

  it("starts detached server in --browser mode", async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "agentlens-runtime-"));
    const fakeEntrypoint = path.join(runtimeDir, "fake-server.mjs");
    const port = await getFreePort();

    await writeFile(
      fakeEntrypoint,
      `import { createServer } from "node:http";
const host = process.env.AGENTLENS_HOST ?? "127.0.0.1";
const port = Number(process.env.AGENTLENS_PORT ?? "8787");
const server = createServer((request, response) => {
  if (request.url === "/api/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});
server.listen(port, host);
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});`,
      "utf8",
    );

    let pid: number | undefined;
    try {
      const output = runCliWithEnv(
        ["--browser", "--host", "127.0.0.1", "--port", String(port)],
        {
          AGENTLENS_SKIP_OPEN: "1",
          AGENTLENS_RUNTIME_DIR: runtimeDir,
          AGENTLENS_SERVER_ENTRYPOINT: fakeEntrypoint,
          AGENTLENS_STARTUP_TIMEOUT_MS: "5000",
        },
      );

      expect(output).toContain(`AgentLens started in background: http://127.0.0.1:${port}`);

      const pidPath = path.join(runtimeDir, "server.pid");
      const pidInfo = JSON.parse(await readFile(pidPath, "utf8")) as { pid?: number };
      expect(typeof pidInfo.pid).toBe("number");
      pid = pidInfo.pid;
      await waitForHealth(`http://127.0.0.1:${port}/api/healthz`);
    } finally {
      if (pid) {
        await stopProcess(pid);
      }
    }
  });
});
