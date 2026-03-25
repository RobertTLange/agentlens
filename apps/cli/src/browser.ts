import { execFile, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_STARTUP_TIMEOUT_MS = 45000;
const STARTUP_TIMEOUT_GRACE_MS = 5000;

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

interface RuntimeState {
  host: string;
  logPath?: string;
  pid?: number;
  pidPath: string;
  port: number;
  url: string;
}

interface ReadinessProbeResult {
  status: "ready" | "not_ready" | "unavailable" | "error";
  startupError?: string;
}

interface StartupWaitResult {
  status: "ready" | "healthy" | "not_ready";
  startupError?: string;
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

async function probeServerReadiness(readyUrl: string, timeoutMs = 1000): Promise<ReadinessProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(readyUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (response.status === 404) {
      return { status: "unavailable" };
    }
    const data = (await response.json().catch(() => ({}))) as { ready?: boolean; startupError?: string };
    if (response.ok && data.ready === true) {
      return { status: "ready" };
    }
    if (data.ready === false || response.status === 503) {
      return {
        status: "not_ready",
        ...(typeof data.startupError === "string" && data.startupError.trim()
          ? { startupError: data.startupError.trim() }
          : {}),
      };
    }
    return { status: "error" };
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerStartup(
  readyUrl: string,
  healthUrl: string,
  timeoutMs: number,
): Promise<StartupWaitResult> {
  const start = Date.now();
  let latestNotReady: StartupWaitResult = { status: "not_ready" };
  while (Date.now() - start < timeoutMs) {
    const probe = await probeServerReadiness(readyUrl, 1000);
    if (probe.status === "ready") {
      return { status: "ready" };
    }
    if (probe.status === "unavailable") {
      if (await isServerHealthy(healthUrl, 1000)) {
        return { status: "healthy" };
      }
    } else if (probe.status === "not_ready") {
      latestNotReady = {
        status: "not_ready",
        ...(probe.startupError ? { startupError: probe.startupError } : {}),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latestNotReady;
}

function buildReadinessTimeoutMessage(url: string, logPath?: string, startupError?: string): string {
  const parts = [`timeout waiting for AgentLens readiness at ${url}`];
  if (logPath) {
    parts.push(`log: ${logPath}`);
  }
  parts.push("hint: increase AGENTLENS_STARTUP_TIMEOUT_MS for large trace indexes");
  if (startupError) {
    parts.push(`startup error: ${startupError}`);
  }
  return `${parts.join(". ")}.`;
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

async function resolveListeningPid(port: number): Promise<number | undefined> {
  if (process.platform === "win32") {
    return undefined;
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-Fp"], (error, fileStdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(fileStdout);
      });
    });
    const pidLine = stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => /^p\d+$/u.test(line));
    if (!pidLine) {
      return undefined;
    }
    const pid = Number(pidLine.slice(1));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function writeRuntimeState({
  host,
  logPath,
  pid,
  pidPath,
  port,
  url,
}: RuntimeState): Promise<void> {
  if (typeof logPath === "string") {
    await mkdir(path.dirname(logPath), { recursive: true });
  }
  await mkdir(path.dirname(pidPath), { recursive: true });
  await writeFile(
    pidPath,
    JSON.stringify(
      {
        ...(typeof pid === "number" ? { pid } : {}),
        host,
        port,
        url,
        ...(typeof logPath === "string" ? { logPath } : {}),
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

function getRuntimePaths(runtimeDir: string): { logPath: string; pidPath: string } {
  return {
    logPath: path.join(runtimeDir, "logs", "server.log"),
    pidPath: path.join(runtimeDir, "server.pid"),
  };
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
  const { logPath, pidPath } = getRuntimePaths(runtimeDir);
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

    await writeRuntimeState({
      host,
      logPath,
      pid,
      pidPath,
      port,
      url: toBaseUrl(host, port),
    });

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
  const readyUrl = `${url}/api/readyz`;
  const skipOpen = shouldSkipOpen(options.skipOpen);
  const { pidPath } = getRuntimePaths(runtimeDir);
  const readiness = await probeServerReadiness(readyUrl);
  const healthy = readiness.status === "unavailable" ? await isServerHealthy(healthUrl) : readiness.status === "ready";

  if (healthy || (await isPortBound(host, port))) {
    let reuseStatus: StartupWaitResult["status"] | "unknown" =
      readiness.status === "ready" ? "ready" : healthy ? "healthy" : "unknown";
    if (readiness.status === "not_ready") {
      const ready = await waitForServerStartup(readyUrl, healthUrl, startupTimeoutMs);
      const readyWithGrace = ready.status === "ready" || ready.status === "healthy"
        ? ready
        : await waitForServerStartup(readyUrl, healthUrl, STARTUP_TIMEOUT_GRACE_MS);
      if (readyWithGrace.status !== "ready" && readyWithGrace.status !== "healthy") {
        throw new Error(buildReadinessTimeoutMessage(url, undefined, readyWithGrace.startupError));
      }
      reuseStatus = readyWithGrace.status;
    }
    const isReusableAgentLens = reuseStatus === "ready" || reuseStatus === "healthy";
    const pid = isReusableAgentLens ? await resolveListeningPid(port) : undefined;
    if (isReusableAgentLens) {
      await writeRuntimeState({
        host,
        pidPath,
        port,
        url,
        ...(typeof pid === "number" ? { pid } : {}),
      });
    }
    if (!skipOpen) {
      await openBrowser(url);
    }
    return {
      status: "reused",
      url,
      openedBrowser: !skipOpen,
      ...(isReusableAgentLens ? { pidPath } : {}),
      ...(typeof pid === "number" ? { pid } : {}),
    };
  }

  const { pid, pidPath: spawnedPidPath, logPath: spawnedLogPath } = await spawnServer({
    host,
    port,
    configPath: options.configPath,
    runtimeDir,
  });

  const ready = await waitForServerStartup(readyUrl, healthUrl, startupTimeoutMs);
  const readyWithGrace = ready.status === "ready" || ready.status === "healthy"
    ? ready
    : await waitForServerStartup(readyUrl, healthUrl, STARTUP_TIMEOUT_GRACE_MS);
  if (readyWithGrace.status !== "ready" && readyWithGrace.status !== "healthy") {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // no-op
    }
    throw new Error(buildReadinessTimeoutMessage(url, spawnedLogPath, readyWithGrace.startupError));
  }

  if (!skipOpen) {
    await openBrowser(url);
  }

  return {
    status: "started",
    url,
    openedBrowser: !skipOpen,
    pid,
    pidPath: spawnedPidPath,
    logPath: spawnedLogPath,
  };
}
