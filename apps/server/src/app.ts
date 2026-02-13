import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig, TraceSummary } from "@agentlens/contracts";
import { DEFAULT_CONFIG_PATH, mergeConfig, saveConfig, TraceIndex } from "@agentlens/core";

const execFileAsync = promisify(execFile);
const STOP_SIGNAL_WAIT_MS = 1_200;
const STOP_FORCE_WAIT_MS = 700;
const STOP_WAIT_POLL_MS = 120;

type StopSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

interface StopTraceSessionOptions {
  force?: boolean;
  requesterPid?: number;
}

interface StopTraceSessionResult {
  status: "terminated" | "not_running" | "failed";
  reason: string;
  signal: StopSignal | null;
  matchedPids: number[];
  alivePids: number[];
}

type StopTraceSessionHandler = (
  summary: TraceSummary,
  options: StopTraceSessionOptions,
) => Promise<StopTraceSessionResult>;

interface OpenFileProcess {
  pid: number;
  command: string;
  user: string;
}

interface RunningProcess {
  pid: number;
  user: string;
  args: string;
}

interface CurrentUserIdentity { username: string; uid: string }

export interface CreateServerOptions {
  traceIndex: TraceIndex;
  configPath?: string;
  webDistPath?: string;
  enableStatic?: boolean;
  stopTraceSession?: StopTraceSessionHandler;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      out[key] = deepMergeConfig(baseValue, value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNoOpenFileMatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: string | number }).code;
  return code === 1 || code === "1";
}

function parseOpenFileProcesses(output: string): OpenFileProcess[] {
  const byPid = new Map<number, OpenFileProcess>();
  let currentPid = 0;

  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === "p") {
      const pid = Number.parseInt(value, 10);
      if (!Number.isInteger(pid) || pid <= 0) {
        currentPid = 0;
        continue;
      }
      currentPid = pid;
      if (!byPid.has(pid)) {
        byPid.set(pid, { pid, command: "", user: "" });
      }
      continue;
    }
    if (currentPid <= 0) continue;
    const current = byPid.get(currentPid);
    if (!current) continue;
    if (field === "c" && !current.command) {
      current.command = value;
      continue;
    }
    if (field === "u" && !current.user) {
      current.user = value;
    }
  }

  return Array.from(byPid.values());
}

function parseRunningProcesses(output: string): RunningProcess[] {
  const processes: RunningProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1] || "", 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const user = (match[2] || "").trim();
    const args = (match[3] || "").trim();
    if (!args) continue;
    processes.push({ pid, user, args });
  }
  return processes;
}

async function listOpenFileProcesses(filePath: string): Promise<OpenFileProcess[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-n", "-Fpcu", "--", filePath], {
      maxBuffer: 1_024 * 1_024,
    });
    return parseOpenFileProcesses(stdout);
  } catch (error) {
    if (isNoOpenFileMatchError(error)) {
      return [];
    }
    throw new Error(`failed to inspect open file handles: ${asErrorMessage(error)}`);
  }
}

async function listRunningProcesses(): Promise<RunningProcess[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,user=,args="], {
      maxBuffer: 8 * 1_024 * 1_024,
    });
    return parseRunningProcesses(stdout);
  } catch (error) {
    throw new Error(`failed to inspect running processes: ${asErrorMessage(error)}`);
  }
}

async function listProcessCwd(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-a", "-d", "cwd", "-n", "-Fpfn", "-p", String(pid)], {
      maxBuffer: 256 * 1_024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (line[0] !== "n") continue;
      return line.slice(1).trim();
    }
    return "";
  } catch {
    return "";
  }
}

function currentUserIdentity(): CurrentUserIdentity {
  try {
    const userInfo = os.userInfo();
    return { username: userInfo.username, uid: String(userInfo.uid) };
  } catch {
    return { username: "", uid: "" };
  }
}

export function matchesCurrentUser(userField: string, identity: CurrentUserIdentity): boolean {
  const candidate = userField.trim();
  if (!candidate) return true;
  if (!identity.username && !identity.uid) return true;
  return candidate === identity.username || candidate === identity.uid;
}

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase();
}

function commandMatchesAgent(command: string, agent: TraceSummary["agent"]): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (agent === "codex") return /\bcodex\b/.test(normalized);
  if (agent === "claude") return /\bclaude\b/.test(normalized);
  return false;
}

export function claudeProjectKeyFromTracePath(tracePath: string): string {
  const normalizedPath = tracePath.replace(/\\/g, "/");
  const marker = "/.claude/projects/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex < 0) return "";
  const tail = normalizedPath.slice(markerIndex + marker.length);
  const nextSlashIndex = tail.indexOf("/");
  if (nextSlashIndex <= 0) return "";
  return tail.slice(0, nextSlashIndex);
}

export function claudeProjectKeyFromCwd(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute.replace(/[^A-Za-z0-9]+/g, "-");
}

interface ClaudeCandidateProcess {
  pid: number;
  user: string;
  args: string;
  cwd: string;
}

export function selectClaudeProjectProcessPids(
  summary: Pick<TraceSummary, "path" | "sessionId">,
  processes: ClaudeCandidateProcess[],
  identity: CurrentUserIdentity,
  requesterPid: number,
): number[] {
  const projectKey = claudeProjectKeyFromTracePath(summary.path);
  if (!projectKey) return [];

  const sameUserAgentCandidates = processes.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "claude");
  });
  if (sameUserAgentCandidates.length === 0) return [];

  const projectCandidates = sameUserAgentCandidates.filter(
    (processInfo) => claudeProjectKeyFromCwd(processInfo.cwd) === projectKey,
  );
  if (projectCandidates.length === 0) return [];

  const sessionId = summary.sessionId.trim();
  if (sessionId) {
    const normalizedSessionId = sessionId.toLowerCase();
    const sessionCandidates = projectCandidates.filter((processInfo) =>
      normalizeCommand(processInfo.args).includes(normalizedSessionId),
    );
    if (sessionCandidates.length > 0) {
      return uniquePids(sessionCandidates.map((processInfo) => processInfo.pid));
    }
  }

  return uniquePids(projectCandidates.map((processInfo) => processInfo.pid));
}

async function findClaudeProjectProcessPids(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const projectKey = claudeProjectKeyFromTracePath(summary.path);
  if (!projectKey) return [];

  const runningProcesses = await listRunningProcesses();
  const claudeProcesses = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "claude");
  });
  if (claudeProcesses.length === 0) return [];

  const withCwd: ClaudeCandidateProcess[] = await Promise.all(
    claudeProcesses.map(async (processInfo) => ({
      ...processInfo,
      cwd: await listProcessCwd(processInfo.pid),
    })),
  );
  return selectClaudeProjectProcessPids(summary, withCwd, identity, requesterPid);
}

function uniquePids(values: number[]): number[] {
  const unique = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value <= 0) continue;
    unique.add(value);
  }
  return Array.from(unique.values());
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const startedAtMs = Date.now();
  let alive = pids.filter((pid) => isProcessAlive(pid));
  while (alive.length > 0 && Date.now() - startedAtMs < timeoutMs) {
    await delay(STOP_WAIT_POLL_MS);
    alive = alive.filter((pid) => isProcessAlive(pid));
  }
  return alive;
}

async function signalThenWait(pids: number[], signal: StopSignal, timeoutMs: number): Promise<number[]> {
  const attempted: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
      attempted.push(pid);
    } catch {
      // Ignore dead/stale pid handles; exit state is checked below.
    }
  }
  if (attempted.length === 0) {
    return [];
  }
  return await waitForExit(attempted, timeoutMs);
}

async function stopTraceSessionProcess(
  summary: TraceSummary,
  options: StopTraceSessionOptions,
): Promise<StopTraceSessionResult> {
  const requesterPid = options.requesterPid ?? process.pid;
  const openFileProcesses = await listOpenFileProcesses(summary.path);
  const identity = currentUserIdentity();
  const sameUserCandidates = openFileProcesses.filter((candidate) => {
    if (candidate.pid === requesterPid) return false;
    return matchesCurrentUser(candidate.user, identity);
  });
  const agentScopedCandidates = sameUserCandidates.filter((candidate) =>
    commandMatchesAgent(candidate.command, summary.agent),
  );
  const chosenCandidates = agentScopedCandidates.length > 0 ? agentScopedCandidates : sameUserCandidates;
  let matchedPids = uniquePids(chosenCandidates.map((candidate) => candidate.pid));
  if (matchedPids.length === 0 && summary.agent === "claude") {
    matchedPids = await findClaudeProjectProcessPids(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0) {
    return {
      status: "not_running",
      reason: "no active session process found",
      signal: null,
      matchedPids: [],
      alivePids: [],
    };
  }

  let alivePids = matchedPids.filter((pid) => isProcessAlive(pid));
  if (alivePids.length === 0) {
    return {
      status: "not_running",
      reason: "session process already exited",
      signal: null,
      matchedPids,
      alivePids: [],
    };
  }

  alivePids = await signalThenWait(alivePids, "SIGINT", STOP_SIGNAL_WAIT_MS);
  if (alivePids.length === 0) {
    return {
      status: "terminated",
      reason: "session process terminated with SIGINT",
      signal: "SIGINT",
      matchedPids,
      alivePids: [],
    };
  }

  alivePids = await signalThenWait(alivePids, "SIGTERM", STOP_SIGNAL_WAIT_MS);
  if (alivePids.length === 0) {
    return {
      status: "terminated",
      reason: "session process terminated with SIGTERM",
      signal: "SIGTERM",
      matchedPids,
      alivePids: [],
    };
  }

  if (options.force) {
    alivePids = await signalThenWait(alivePids, "SIGKILL", STOP_FORCE_WAIT_MS);
    if (alivePids.length === 0) {
      return {
        status: "terminated",
        reason: "session process terminated with SIGKILL",
        signal: "SIGKILL",
        matchedPids,
        alivePids: [],
      };
    }
  }

  return {
    status: "failed",
    reason: options.force ? "session process did not exit after SIGKILL" : "session process did not exit after SIGTERM",
    signal: options.force ? "SIGKILL" : "SIGTERM",
    matchedPids,
    alivePids,
  };
}

export function resolveDefaultWebDistPath(packagedWebDistPath: string, monorepoWebDistPath: string): string {
  if (existsSync(monorepoWebDistPath)) {
    return monorepoWebDistPath;
  }
  if (existsSync(packagedWebDistPath)) {
    return packagedWebDistPath;
  }
  return monorepoWebDistPath;
}

export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  const traceIndex = options.traceIndex;
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const stopTraceSession = options.stopTraceSession ?? stopTraceSessionProcess;
  const packagedWebDistPath = fileURLToPath(new URL("./web", import.meta.url));
  const monorepoWebDistPath = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const defaultWebDistPath = resolveDefaultWebDistPath(packagedWebDistPath, monorepoWebDistPath);
  const webDistPath = options.webDistPath ?? defaultWebDistPath;

  if ((options.enableStatic ?? true) && existsSync(webDistPath)) {
    await server.register(fastifyStatic, {
      root: webDistPath,
      prefix: "/",
    });
  }

  server.get("/api/healthz", async () => ({ ok: true }));

  server.get("/api/overview", async () => ({ overview: traceIndex.getOverview() }));

  server.get("/api/traces", async (request) => {
    const query = request.query as { agent?: string };
    const agent = query.agent?.trim().toLowerCase();
    const traces = traceIndex
      .getSummaries()
      .filter((summary) => (agent ? summary.agent === agent : true));
    return { traces };
  });

  server.get("/api/trace/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { limit?: string; before?: string; include_meta?: string };

    try {
      const resolvedId = traceIndex.resolveId(params.id);
      const pageOptions: { limit?: number; before?: string; includeMeta?: boolean } = {};
      if (query.include_meta !== undefined) {
        pageOptions.includeMeta = query.include_meta === "1" || query.include_meta === "true";
      }
      if (query.limit) {
        pageOptions.limit = Number(query.limit);
      }
      if (query.before) {
        pageOptions.before = query.before;
      }
      const page = traceIndex.getTracePage(resolvedId, pageOptions);
      return page;
    } catch (error) {
      reply.code(404);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });

  server.post("/api/trace/:id/stop", async (request, reply) => {
    const params = request.params as { id: string };
    const query = request.query as { force?: string };
    const force = query.force === "1" || query.force === "true";

    try {
      const resolvedId = traceIndex.resolveId(params.id);
      const summary = traceIndex.getSessionDetail(resolvedId).summary;
      const result = await stopTraceSession(summary, { force, requesterPid: process.pid });
      if (result.status === "terminated") {
        return {
          ok: true,
          status: result.status,
          traceId: summary.id,
          sessionId: summary.sessionId,
          signal: result.signal,
          pids: result.matchedPids,
          alivePids: result.alivePids,
          message: result.reason,
        };
      }
      if (result.status === "not_running") {
        reply.code(409);
      } else {
        reply.code(500);
      }
      return {
        ok: false,
        status: result.status,
        traceId: summary.id,
        sessionId: summary.sessionId,
        signal: result.signal,
        pids: result.matchedPids,
        alivePids: result.alivePids,
        error: result.reason,
      };
    } catch (error) {
      const message = asErrorMessage(error);
      if (message.startsWith("unknown trace/session:")) {
        reply.code(404);
      } else {
        reply.code(500);
      }
      return { ok: false, error: message };
    }
  });

  server.get("/api/config", async () => ({ config: traceIndex.getConfig() }));

  server.post("/api/config", async (request) => {
    const body = request.body as Partial<AppConfig>;
    const mergedInput = deepMergeConfig(
      traceIndex.getConfig() as unknown as Record<string, unknown>,
      (body ?? {}) as Record<string, unknown>,
    ) as Partial<AppConfig>;
    const merged = mergeConfig(mergedInput);
    await saveConfig(merged, configPath);
    traceIndex.setConfig(merged);
    await traceIndex.refresh();
    return { config: merged };
  });

  server.get("/api/stream", async (request, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");

    reply.raw.write(
      `event: snapshot\ndata: ${JSON.stringify({
        id: "0",
        type: "snapshot",
        version: 0,
        payload: {
          traces: traceIndex.getSummaries(),
          overview: traceIndex.getOverview(),
        },
      })}\n\n`,
    );

    const onStream = ({ envelope }: { envelope: Record<string, unknown> }) => {
      reply.raw.write(`event: ${String(envelope.type ?? "message")}\ndata: ${JSON.stringify(envelope)}\n\n`);
    };

    const heartbeat = setInterval(() => {
      reply.raw.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, 15000);

    traceIndex.on("stream", onStream);

    request.raw.on("close", () => {
      clearInterval(heartbeat);
      traceIndex.off("stream", onStream);
      reply.raw.end();
    });
  });

  server.get("/", async (_request, reply) => {
    if (!existsSync(webDistPath)) {
      reply.type("text/html");
      return `<!doctype html>
<html><body style="font-family: sans-serif; padding: 2rem;">
<h1>AgentLens server running</h1>
<p>Web app not built yet.</p>
<p>Build once: <code>npm -w apps/web run build</code></p>
<p>Or run dev UI: <code>npm -w apps/web run dev</code> then open <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a>.</p>
<p>API: <a href="/api/overview">/api/overview</a></p>
</body></html>`;
    }
    return reply.sendFile("index.html");
  });

  return server;
}

export interface RunServerOptions {
  host?: string;
  port?: number;
  configPath?: string;
  enableStatic?: boolean;
}

export async function runServer(options: RunServerOptions = {}): Promise<void> {
  const host = options.host ?? process.env.AGENTLENS_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.AGENTLENS_PORT ?? "8787");
  const configPath = options.configPath ?? process.env.AGENTLENS_CONFIG ?? DEFAULT_CONFIG_PATH;

  const traceIndex = await TraceIndex.fromConfigPath(configPath);
  await traceIndex.start();

  const createOptions: CreateServerOptions = {
    traceIndex,
    configPath,
  };
  if (options.enableStatic !== undefined) {
    createOptions.enableStatic = options.enableStatic;
  }
  const server = await createServer(createOptions);

  await server.listen({ host, port });

  process.on("SIGINT", async () => {
    traceIndex.stop();
    await server.close();
    process.exit(0);
  });

  // eslint-disable-next-line no-console
  console.log(`AgentLens server: http://${host}:${port}`);
}
