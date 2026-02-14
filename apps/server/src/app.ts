import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppConfig, SessionDetail, TraceSummary } from "@agentlens/contracts";
import { DEFAULT_CONFIG_PATH, mergeConfig, saveConfig, TraceIndex } from "@agentlens/core";

const execFileAsync = promisify(execFile);
const STOP_SIGNAL_WAIT_MS = 1_200;
const STOP_FORCE_WAIT_MS = 700;
const STOP_WAIT_POLL_MS = 120;

type StopSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

interface StopTraceSessionOptions {
  force?: boolean;
  requesterPid?: number;
  sessionCwd?: string;
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

interface OpenTraceSessionOptions {
  requesterPid?: number;
  sessionCwd?: string;
}

interface TmuxPaneTarget {
  tmuxSession: string;
  windowIndex: number;
  paneIndex: number;
}

interface OpenTraceSessionResult {
  status: "focused_pane" | "ghostty_activated" | "not_resolvable" | "failed";
  reason: string;
  pid: number | null;
  tty: string;
  target: TmuxPaneTarget | null;
  matchedPids: number[];
  alivePids: number[];
}

type OpenTraceSessionHandler = (
  summary: TraceSummary,
  options: OpenTraceSessionOptions,
) => Promise<OpenTraceSessionResult>;

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

interface TmuxPaneInfo {
  socketPath: string;
  tmuxSession: string;
  windowIndex: number;
  paneIndex: number;
  paneTty: string;
}

interface TmuxPaneLookupResult {
  panes: TmuxPaneInfo[];
  scannedSockets: string[];
}

interface TmuxClientInfo {
  tty: string;
  activityEpoch: number;
  sessionName: string;
  flags: string[];
  isFocused: boolean;
}

interface SessionProcessResolution {
  matchedPids: number[];
  alivePids: number[];
}

export interface CreateServerOptions {
  traceIndex: TraceIndex;
  configPath?: string;
  webDistPath?: string;
  enableStatic?: boolean;
  stopTraceSession?: StopTraceSessionHandler;
  openTraceSession?: OpenTraceSessionHandler;
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

function asSessionCwd(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inferSessionCwd(detail: SessionDetail): string {
  for (const event of detail.events) {
    if (event.rawType !== "session_meta") continue;
    const rawPayload = (event.raw as { payload?: unknown }).payload;
    if (!rawPayload || typeof rawPayload !== "object") continue;
    const cwd = asSessionCwd((rawPayload as { cwd?: unknown }).cwd);
    if (cwd) return cwd;
  }
  return "";
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

function normalizeTtyPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "?") return "";
  return trimmed.startsWith("/dev/") ? trimmed : `/dev/${trimmed.replace(/^\/+/, "")}`;
}

async function listProcessTty(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "tty="], {
      maxBuffer: 64 * 1_024,
    });
    return normalizeTtyPath(stdout);
  } catch {
    return "";
  }
}

function tmuxArgs(socketPath: string, args: string[]): string[] {
  if (!socketPath) return args;
  return ["-S", socketPath, ...args];
}

async function runTmux(socketPath: string, args: string[], maxBuffer = 64 * 1_024): Promise<string> {
  const { stdout } = await execFileAsync("tmux", tmuxArgs(socketPath, args), {
    maxBuffer,
  });
  return stdout;
}

function parseTmuxPanes(output: string, socketPath: string): TmuxPaneInfo[] {
  const panes: TmuxPaneInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [tmuxSession = "", windowIndexRaw = "", paneIndexRaw = "", paneTtyRaw = ""] = line.split("\t");
    const windowIndex = Number.parseInt(windowIndexRaw, 10);
    const paneIndex = Number.parseInt(paneIndexRaw, 10);
    const paneTty = normalizeTtyPath(paneTtyRaw);
    if (!tmuxSession || !Number.isInteger(windowIndex) || !Number.isInteger(paneIndex) || !paneTty) continue;
    panes.push({
      socketPath,
      tmuxSession,
      windowIndex,
      paneIndex,
      paneTty,
    });
  }
  return panes;
}

export function parseTmuxClients(output: string): TmuxClientInfo[] {
  const clients: TmuxClientInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ttyRaw = "", activityRaw = "", sessionName = "", flagsRaw = ""] = line.split("\t");
    const tty = normalizeTtyPath(ttyRaw);
    if (!tty) continue;
    const activityEpoch = Number.parseInt(activityRaw, 10);
    const flags = flagsRaw
      .split(",")
      .map((flag) => flag.trim())
      .filter(Boolean);
    clients.push({
      tty,
      activityEpoch: Number.isFinite(activityEpoch) ? activityEpoch : 0,
      sessionName: sessionName.trim(),
      flags,
      isFocused: flags.includes("focused"),
    });
  }
  return clients;
}

export function selectPreferredTmuxClient(clients: TmuxClientInfo[], targetSession: string): TmuxClientInfo | null {
  if (clients.length === 0) return null;
  const sorted = [...clients].sort((left, right) => {
    if (right.isFocused !== left.isFocused) return Number(right.isFocused) - Number(left.isFocused);
    if (right.activityEpoch !== left.activityEpoch) return right.activityEpoch - left.activityEpoch;
    return left.tty.localeCompare(right.tty);
  });
  const normalizedTargetSession = targetSession.trim();
  if (!normalizedTargetSession) return sorted[0] ?? null;
  const focusedSwitchingCandidate = sorted.find(
    (client) => client.isFocused && client.sessionName !== normalizedTargetSession,
  );
  if (focusedSwitchingCandidate) return focusedSwitchingCandidate;
  const focusedCandidate = sorted.find((client) => client.isFocused);
  if (focusedCandidate) return focusedCandidate;
  const switchingCandidate = sorted.find((client) => client.sessionName !== normalizedTargetSession);
  return switchingCandidate ?? sorted[0] ?? null;
}

function orderTmuxClientsForSwitch(clients: TmuxClientInfo[], preferredClient: TmuxClientInfo): TmuxClientInfo[] {
  const byTty = new Map<string, TmuxClientInfo>();
  for (const client of clients) {
    if (!client.tty) continue;
    byTty.set(client.tty, client);
  }
  const sorted = Array.from(byTty.values()).sort((left, right) => {
    if (right.isFocused !== left.isFocused) return Number(right.isFocused) - Number(left.isFocused);
    if (right.activityEpoch !== left.activityEpoch) return right.activityEpoch - left.activityEpoch;
    return left.tty.localeCompare(right.tty);
  });
  const preferredIndex = sorted.findIndex((candidate) => candidate.tty === preferredClient.tty);
  if (preferredIndex > 0) {
    const [candidate] = sorted.splice(preferredIndex, 1);
    if (candidate) sorted.unshift(candidate);
  }
  return sorted;
}

function discoverTmuxSocketPaths(identity: CurrentUserIdentity): string[] {
  const candidates = new Set<string>();
  const bases = [`/tmp/tmux-${identity.uid}`, `/private/tmp/tmux-${identity.uid}`];
  for (const base of bases) {
    if (!identity.uid || !existsSync(base)) continue;
    try {
      for (const entry of readdirSync(base)) {
        const socketPath = path.join(base, entry);
        candidates.add(socketPath);
      }
    } catch {
      // Ignore unreadable socket directories.
    }
  }
  if (candidates.size === 0) {
    candidates.add("");
  }
  return Array.from(candidates.values());
}

async function listTmuxPanes(identity: CurrentUserIdentity): Promise<TmuxPaneLookupResult> {
  const scannedSockets = discoverTmuxSocketPaths(identity);
  const panes: TmuxPaneInfo[] = [];
  for (const socketPath of scannedSockets) {
    try {
      const stdout = await runTmux(
        socketPath,
        ["list-panes", "-a", "-F", "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_tty}"],
        512 * 1_024,
      );
      panes.push(...parseTmuxPanes(stdout, socketPath));
    } catch {
      // Ignore stale/non-running tmux sockets.
    }
  }
  return {
    panes,
    scannedSockets,
  };
}

async function listTmuxClients(socketPath: string): Promise<TmuxClientInfo[]> {
  try {
    const stdout = await runTmux(
      socketPath,
      ["list-clients", "-F", "#{client_tty}\t#{client_activity}\t#{session_name}\t#{client_flags}"],
      128 * 1_024,
    );
    return parseTmuxClients(stdout);
  } catch {
    return [];
  }
}

async function listTmuxClientsWithFocusWarmup(socketPath: string): Promise<TmuxClientInfo[]> {
  const initialClients = await listTmuxClients(socketPath);
  if (initialClients.some((client) => client.isFocused)) {
    return initialClients;
  }
  await delay(120);
  const warmedClients = await listTmuxClients(socketPath);
  return warmedClients.length > 0 ? warmedClients : initialClients;
}

async function focusTmuxPane(target: TmuxPaneInfo): Promise<{
  focusedClient: string;
  previousSession: string;
  switchedClients: string[];
  preferredWasFocused: boolean;
}> {
  const clients = await listTmuxClientsWithFocusWarmup(target.socketPath);
  const preferredClient = selectPreferredTmuxClient(clients, target.tmuxSession);
  if (!preferredClient) {
    throw new Error("no attached tmux clients");
  }

  await runTmux(target.socketPath, ["select-window", "-t", `${target.tmuxSession}:${target.windowIndex}`]);
  await runTmux(target.socketPath, ["select-pane", "-t", `${target.tmuxSession}:${target.windowIndex}.${target.paneIndex}`]);
  const orderedClients = orderTmuxClientsForSwitch(clients, preferredClient);
  const switchedClients: string[] = [];
  for (const client of orderedClients) {
    try {
      await runTmux(target.socketPath, ["switch-client", "-c", client.tty, "-t", target.tmuxSession]);
      await runTmux(target.socketPath, ["refresh-client", "-t", client.tty]);
      switchedClients.push(client.tty);
    } catch {
      // Ignore clients that disappear while switching.
    }
  }
  if (switchedClients.length === 0) {
    throw new Error("failed to switch any attached tmux client");
  }
  return {
    focusedClient: preferredClient.tty,
    previousSession: preferredClient.sessionName,
    switchedClients,
    preferredWasFocused: preferredClient.isFocused,
  };
}

function isGhosttyFrontmost(name: string): boolean {
  return name.trim().toLowerCase().includes("ghostty");
}

async function frontmostAppName(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "osascript",
      ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'],
      {
        maxBuffer: 64 * 1_024,
      },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

async function waitForGhosttyFrontmost(): Promise<string> {
  let observed = "";
  for (let index = 0; index < 4; index += 1) {
    observed = await frontmostAppName();
    if (isGhosttyFrontmost(observed)) return observed;
    await delay(80);
  }
  return observed;
}

async function activateGhostty(): Promise<{ method: string; frontmostApp: string }> {
  const strategies: Array<{ method: string; run: () => Promise<void> }> = [
    {
      method: "app_id_activate",
      run: async () => {
        await execFileAsync("osascript", ["-e", 'tell application id "com.mitchellh.ghostty" to activate'], {
          maxBuffer: 64 * 1_024,
        });
      },
    },
    {
      method: "app_name_activate",
      run: async () => {
        await execFileAsync("osascript", ["-e", 'tell application "Ghostty" to activate'], {
          maxBuffer: 64 * 1_024,
        });
      },
    },
    {
      method: "open_app",
      run: async () => {
        await execFileAsync("open", ["-a", "Ghostty"], {
          maxBuffer: 64 * 1_024,
        });
      },
    },
  ];

  let lastError = "";
  let lastFrontmost = "";
  for (const strategy of strategies) {
    try {
      await strategy.run();
      const frontmost = await waitForGhosttyFrontmost();
      if (isGhosttyFrontmost(frontmost)) {
        return {
          method: strategy.method,
          frontmostApp: frontmost,
        };
      }
      lastFrontmost = frontmost;
    } catch (error) {
      lastError = asErrorMessage(error);
    }
  }

  const frontmost = lastFrontmost || (await frontmostAppName()) || "unknown";
  const suffix = lastError ? `; last activation error: ${lastError}` : "";
  throw new Error(`Ghostty did not become frontmost (frontmost: ${frontmost}${suffix})`);
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

interface AgentCandidateProcess {
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

export function selectAgentProjectProcessPids(
  processCwd: string,
  sessionId: string,
  agent: TraceSummary["agent"],
  processes: AgentCandidateProcess[],
  identity: CurrentUserIdentity,
  requesterPid: number,
): number[] {
  const projectKey = claudeProjectKeyFromCwd(processCwd);
  if (!projectKey) return [];

  const sameUserAgentCandidates = processes.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, agent);
  });
  if (sameUserAgentCandidates.length === 0) return [];

  const projectCandidates = sameUserAgentCandidates.filter(
    (processInfo) => claudeProjectKeyFromCwd(processInfo.cwd) === projectKey,
  );
  if (projectCandidates.length === 0) return [];

  const normalizedSessionId = sessionId.trim().toLowerCase();
  if (normalizedSessionId) {
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

async function findAgentProjectProcessPids(
  sessionCwd: string,
  sessionId: string,
  agent: TraceSummary["agent"],
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const projectKey = claudeProjectKeyFromCwd(sessionCwd);
  if (!projectKey) return [];

  const runningProcesses = await listRunningProcesses();
  const agentProcesses = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, agent);
  });
  if (agentProcesses.length === 0) return [];

  const withCwd: AgentCandidateProcess[] = await Promise.all(
    agentProcesses.map(async (processInfo) => ({
      ...processInfo,
      cwd: await listProcessCwd(processInfo.pid),
    })),
  );

  return selectAgentProjectProcessPids(sessionCwd, sessionId, agent, withCwd, identity, requesterPid);
}

async function resolveSessionProcessPids(
  summary: TraceSummary,
  requesterPid: number,
  sessionCwd = "",
): Promise<SessionProcessResolution> {
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
  if (matchedPids.length === 0 && sessionCwd) {
    matchedPids = await findAgentProjectProcessPids(
      sessionCwd,
      summary.sessionId,
      summary.agent,
      identity,
      requesterPid,
    );
  }
  const alivePids = matchedPids.filter((pid) => isProcessAlive(pid));
  return {
    matchedPids,
    alivePids,
  };
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
  const { matchedPids, alivePids: initiallyAlivePids } = await resolveSessionProcessPids(
    summary,
    requesterPid,
    options.sessionCwd ?? "",
  );
  if (matchedPids.length === 0) {
    return {
      status: "not_running",
      reason: "no active session process found",
      signal: null,
      matchedPids: [],
      alivePids: [],
    };
  }

  let alivePids = initiallyAlivePids;
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

async function openTraceSessionProcess(
  summary: TraceSummary,
  options: OpenTraceSessionOptions,
): Promise<OpenTraceSessionResult> {
  const requesterPid = options.requesterPid ?? process.pid;
  const { matchedPids, alivePids } = await resolveSessionProcessPids(summary, requesterPid, options.sessionCwd ?? "");
  if (matchedPids.length === 0) {
    try {
      const activation = await activateGhostty();
      return {
        status: "ghostty_activated",
        reason: `activated Ghostty via ${activation.method} (frontmost ${activation.frontmostApp}; session process not resolved)`,
        pid: null,
        tty: "",
        target: null,
        matchedPids: [],
        alivePids: [],
      };
    } catch (error) {
      return {
        status: "not_resolvable",
        reason: `failed to open terminal: ${asErrorMessage(error)}`,
        pid: null,
        tty: "",
        target: null,
        matchedPids: [],
        alivePids: [],
      };
    }
  }

  const pid = alivePids[0] ?? matchedPids[0] ?? null;
  if (!pid) {
    return {
      status: "not_resolvable",
      reason: "no session process target found",
      pid: null,
      tty: "",
      target: null,
      matchedPids,
      alivePids,
    };
  }

  const tty = await listProcessTty(pid);
  if (tty) {
    const tmuxLookup = await listTmuxPanes(currentUserIdentity());
    const paneMatch = tmuxLookup.panes.find((pane) => pane.paneTty === tty);
    if (paneMatch) {
      try {
        let preActivationNote = "";
        try {
          const preActivation = await activateGhostty();
          preActivationNote = `; pre-frontmost ${preActivation.frontmostApp} via ${preActivation.method}`;
        } catch (error) {
          preActivationNote = `; pre-activation failed: ${asErrorMessage(error)}`;
        }
        await delay(120);
        const { focusedClient, previousSession, switchedClients, preferredWasFocused } = await focusTmuxPane(paneMatch);
        let postActivationNote = "";
        try {
          const postActivation = await activateGhostty();
          postActivationNote = `; post-frontmost ${postActivation.frontmostApp} via ${postActivation.method}`;
        } catch (error) {
          postActivationNote = `; post-activation failed: ${asErrorMessage(error)}`;
        }
        return {
          status: "focused_pane",
          reason: `focused tmux pane via client ${focusedClient} (from session ${previousSession || "unknown"}; switched ${switchedClients.length} client${switchedClients.length === 1 ? "" : "s"}; preferred client ${preferredWasFocused ? "was" : "was not"} focused)${preActivationNote}${postActivationNote}`,
          pid,
          tty,
          target: {
            tmuxSession: paneMatch.tmuxSession,
            windowIndex: paneMatch.windowIndex,
            paneIndex: paneMatch.paneIndex,
          },
          matchedPids,
          alivePids,
        };
      } catch (error) {
        const reason = asErrorMessage(error);
        try {
          const activation = await activateGhostty();
          return {
            status: "ghostty_activated",
            reason: `activated Ghostty via ${activation.method} (frontmost ${activation.frontmostApp}; tmux focus failed: ${reason})`,
            pid,
            tty,
            target: null,
            matchedPids,
            alivePids,
          };
        } catch {
          // Fall through to generic fallback below.
        }
      }
    } else {
      const scanned = tmuxLookup.scannedSockets.join(", ") || "default socket";
      try {
        const activation = await activateGhostty();
        return {
          status: "ghostty_activated",
          reason: `activated Ghostty via ${activation.method} (frontmost ${activation.frontmostApp}; pane focus unavailable: tty ${tty} not found in tmux sockets ${scanned})`,
          pid,
          tty,
          target: null,
          matchedPids,
          alivePids,
        };
      } catch {
        // Fall back to app-level focus below.
      }
    }
  }

  try {
    const activation = await activateGhostty();
    return {
      status: "ghostty_activated",
      reason: tty
        ? `activated Ghostty via ${activation.method} (frontmost ${activation.frontmostApp}; pane focus unavailable)`
        : `activated Ghostty via ${activation.method} (frontmost ${activation.frontmostApp})`,
      pid,
      tty,
      target: null,
      matchedPids,
      alivePids,
    };
  } catch (error) {
    return {
      status: "not_resolvable",
      reason: `failed to open terminal: ${asErrorMessage(error)}`,
      pid,
      tty,
      target: null,
      matchedPids,
      alivePids,
    };
  }
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
  const openTraceSession = options.openTraceSession ?? openTraceSessionProcess;
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
      const detail = traceIndex.getSessionDetail(resolvedId);
      const summary = detail.summary;
      const sessionCwd = inferSessionCwd(detail);
      const result = await stopTraceSession(summary, { force, requesterPid: process.pid, sessionCwd });
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

  server.post("/api/trace/:id/open", async (request, reply) => {
    const params = request.params as { id: string };

    try {
      const resolvedId = traceIndex.resolveId(params.id);
      const detail = traceIndex.getSessionDetail(resolvedId);
      const summary = detail.summary;
      const sessionCwd = inferSessionCwd(detail);
      const result = await openTraceSession(summary, { requesterPid: process.pid, sessionCwd });
      if (result.status === "focused_pane" || result.status === "ghostty_activated") {
        return {
          ok: true,
          status: result.status,
          traceId: summary.id,
          sessionId: summary.sessionId,
          pid: result.pid,
          tty: result.tty,
          target: result.target,
          pids: result.matchedPids,
          alivePids: result.alivePids,
          message: result.reason,
        };
      }
      if (result.status === "not_resolvable") {
        reply.code(409);
      } else {
        reply.code(500);
      }
      return {
        ok: false,
        status: result.status,
        traceId: summary.id,
        sessionId: summary.sessionId,
        pid: result.pid,
        tty: result.tty,
        target: result.target,
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
