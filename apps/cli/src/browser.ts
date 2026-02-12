import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;

export interface LaunchBrowserOptions {
  host?: string;
  port?: string | number;
  configPath: string;
  runtimeDir?: string;
  startupTimeoutMs?: number;
  skipOpen?: boolean;
}

export interface LaunchBrowserResult {
  status: "reused" | "started";
  url: string;
  openedBrowser: boolean;
  pid?: number;
  logPath?: string;
  pidPath?: string;
}

interface OpenCommand {
  command: string;
  args: string[];
}

function resolveHost(host?: string): string {
  return host?.trim() || process.env.AGENTLENS_HOST || DEFAULT_HOST;
}

export function parsePort(port?: string | number): number {
  const raw = port ?? process.env.AGENTLENS_PORT ?? DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid port: ${String(raw)}`);
  }
  return parsed;
}

function parseStartupTimeoutMs(timeout?: number): number {
  const raw = timeout ?? Number(process.env.AGENTLENS_STARTUP_TIMEOUT_MS ?? DEFAULT_STARTUP_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`invalid startup timeout: ${String(raw)}`);
  }
  return Math.floor(raw);
}

function normalizeUrlHost(host: string): string {
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) {
    return `[${host}]`;
  }
  return host;
}

export function toBaseUrl(host: string, port: number): string {
  return `http://${normalizeUrlHost(host)}:${port}`;
}

function resolveRuntimeDir(input?: string): string {
  return input?.trim() || process.env.AGENTLENS_RUNTIME_DIR?.trim() || path.join(os.homedir(), ".agentlens");
}

function resolveServerEntrypoint(): string {
  const override = process.env.AGENTLENS_SERVER_ENTRYPOINT?.trim();
  if (override) return override;
  return require.resolve("@agentlens/server");
}

export function buildOpenCommand(platform: NodeJS.Platform, url: string): OpenCommand {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`command failed: ${command} ${args.join(" ")} (exit ${String(code)})`));
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  const { command, args } = buildOpenCommand(process.platform, url);
  await runCommand(command, args);
}

export async function isServerHealthy(healthUrl: string, timeoutMs = 1000): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer(healthUrl: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerHealthy(healthUrl, 1000)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function isPortBound(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function spawnServer({
  host,
  port,
  configPath,
  runtimeDir,
}: {
  host: string;
  port: number;
  configPath: string;
  runtimeDir: string;
}): Promise<{ pid: number; pidPath: string; logPath: string }> {
  const logPath = path.join(runtimeDir, "logs", "server.log");
  const pidPath = path.join(runtimeDir, "server.pid");
  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(path.dirname(pidPath), { recursive: true });

  const serverEntrypoint = resolveServerEntrypoint();
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [serverEntrypoint], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        AGENTLENS_HOST: host,
        AGENTLENS_PORT: String(port),
        AGENTLENS_CONFIG: configPath,
      },
    });

    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        if (!child.pid) {
          reject(new Error("failed to start AgentLens server"));
          return;
        }
        resolve(child.pid);
      });
    });

    child.unref();

    await writeFile(
      pidPath,
      JSON.stringify(
        {
          pid,
          host,
          port,
          url: toBaseUrl(host, port),
          logPath,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    return { pid, pidPath, logPath };
  } finally {
    closeSync(logFd);
  }
}

function shouldSkipOpen(skipOpen?: boolean): boolean {
  return skipOpen === true || process.env.AGENTLENS_SKIP_OPEN === "1";
}

export async function launchBrowser(options: LaunchBrowserOptions): Promise<LaunchBrowserResult> {
  const host = resolveHost(options.host);
  const port = parsePort(options.port);
  const startupTimeoutMs = parseStartupTimeoutMs(options.startupTimeoutMs);
  const runtimeDir = resolveRuntimeDir(options.runtimeDir);
  const url = toBaseUrl(host, port);
  const healthUrl = `${url}/api/healthz`;
  const skipOpen = shouldSkipOpen(options.skipOpen);

  if ((await isServerHealthy(healthUrl)) || (await isPortBound(host, port))) {
    if (!skipOpen) {
      await openBrowser(url);
    }
    return {
      status: "reused",
      url,
      openedBrowser: !skipOpen,
    };
  }

  const { pid, pidPath, logPath } = await spawnServer({
    host,
    port,
    configPath: options.configPath,
    runtimeDir,
  });

  const ready = await waitForServer(healthUrl, startupTimeoutMs);
  if (!ready) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // no-op
    }
    throw new Error(`timeout waiting for AgentLens server at ${url}. log: ${logPath}`);
  }

  if (!skipOpen) {
    await openBrowser(url);
  }

  return {
    status: "started",
    url,
    openedBrowser: !skipOpen,
    pid,
    pidPath,
    logPath,
  };
}
