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

  const config = mergeConfig({
    scan: {
      intervalSeconds: 5,
      recentEventWindow: 200,
      includeMetaDefault: false,
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

  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);
  return { configPath, sessionId };
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
