import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const DEFAULT_RECENT_TRACE_LIMIT = 50;
const MAX_RECENT_TRACE_LIMIT = 5000;
const MAX_TRACE_INPUT_TEXT_LENGTH = 2000;

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

interface SendTraceInputOptions {
  requesterPid?: number;
  sessionCwd?: string;
  text: string;
  submit?: boolean;
}

interface SendTraceInputResult {
  status: "sent_tmux" | "not_resolvable" | "failed";
  reason: string;
  pid: number | null;
  tty: string;
  target: TmuxPaneTarget | null;
  matchedPids: number[];
  alivePids: number[];
}

type SendTraceInputHandler = (
  summary: TraceSummary,
  options: SendTraceInputOptions,
) => Promise<SendTraceInputResult>;

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
  sendTraceInput?: SendTraceInputHandler;
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

function normalizeTraceInputText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parsePositiveInt(rawValue: string | undefined, fallback: number): number {
  if (!rawValue) return fallback;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(MAX_RECENT_TRACE_LIMIT, parsed));
}

function listRecentTraceSummaries(
  traceIndex: TraceIndex,
  options: { agent?: string; limit?: string },
): TraceSummary[] {
  const agent = options.agent?.trim().toLowerCase();
  const limit = parsePositiveInt(options.limit, DEFAULT_RECENT_TRACE_LIMIT);
  const filtered = traceIndex.getSummaries().filter((summary) => (agent ? summary.agent === agent : true));
  return filtered.slice(0, limit);
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

function parseProcessOpenFilePaths(output: string): string[] {
  const openPaths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line || line[0] !== "n") continue;
    const openPath = line.slice(1).trim();
    if (!openPath) continue;
    openPaths.push(openPath);
  }
  return openPaths;
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

async function listProcessOpenFilePaths(pid: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("lsof", ["-n", "-Fn", "-p", String(pid)], {
      maxBuffer: 2 * 1_024 * 1_024,
    });
    return parseProcessOpenFilePaths(stdout);
  } catch {
    return [];
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

async function listProcessStartMs(pid: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      maxBuffer: 64 * 1_024,
    });
    const parsed = Date.parse(stdout.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
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

function isOpenCodeServeCommand(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (!/\bopencode\b/.test(normalized)) return false;
  return /\bserve\b/.test(normalized);
}

function isExcludedAgentCommand(command: string, agent: TraceSummary["agent"]): boolean {
  if (agent !== "opencode") return false;
  return isOpenCodeServeCommand(command);
}

function commandMatchesAgent(command: string, agent: TraceSummary["agent"]): boolean {
  const normalized = normalizeCommand(command);
  if (!normalized) return false;
  if (agent === "codex") return /\bcodex\b/.test(normalized);
  if (agent === "claude") return /\bclaude\b/.test(normalized);
  if (agent === "cursor") return /\bcursor\b/.test(normalized);
  if (agent === "gemini") return /\bgemini\b/.test(normalized);
  if (agent === "opencode") return /\bopencode\b/.test(normalized);
  return false;
}

interface OpenFileProcessSelectionInput {
  summary: Pick<TraceSummary, "agent" | "sessionId">;
  openFileProcesses: OpenFileProcess[];
  argsByPid: Map<number, string>;
  identity: CurrentUserIdentity;
  requesterPid: number;
}

export function selectOpenFileProcessPids(input: OpenFileProcessSelectionInput): number[] {
  const sameUserCandidates = input.openFileProcesses.filter((candidate) => {
    if (candidate.pid === input.requesterPid) return false;
    return matchesCurrentUser(candidate.user, input.identity);
  });
  if (sameUserCandidates.length === 0) return [];

  const normalizedSessionId = input.summary.sessionId.trim().toLowerCase();
  const agentCandidates = sameUserCandidates.filter((candidate) => {
    const resolvedCommand = input.argsByPid.get(candidate.pid) ?? candidate.command;
    if (!commandMatchesAgent(resolvedCommand, input.summary.agent)) return false;
    if (isExcludedAgentCommand(resolvedCommand, input.summary.agent)) return false;
    return true;
  });

  if (agentCandidates.length > 0) {
    if (normalizedSessionId) {
      const sessionCandidates = agentCandidates.filter((candidate) => {
        const resolvedCommand = input.argsByPid.get(candidate.pid) ?? candidate.command;
        return normalizeCommand(resolvedCommand).includes(normalizedSessionId);
      });
      if (sessionCandidates.length > 0) {
        return uniquePids(sessionCandidates.map((candidate) => candidate.pid));
      }
    }
    if (agentCandidates.length === 1) {
      return uniquePids([agentCandidates[0]?.pid ?? 0]);
    }
    return uniquePids(agentCandidates.map((candidate) => candidate.pid));
  }

  if (sameUserCandidates.length === 1) {
    return uniquePids([sameUserCandidates[0]?.pid ?? 0]);
  }
  return [];
}

export function extractClaudeDebugProcessPid(logContent: string): number {
  let resolvedPid = 0;
  for (const line of logContent.split(/\r?\n/)) {
    if (!line) continue;
    const tmpWriteMatch = line.match(/\.claude\.json\.tmp\.(\d+)\./);
    if (tmpWriteMatch) {
      const parsed = Number.parseInt(tmpWriteMatch[1] ?? "", 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        resolvedPid = parsed;
      }
      continue;
    }
    if (!line.includes("Acquired PID lock")) continue;
    const lockMatch = line.match(/\(PID\s+(\d+)\)/);
    if (!lockMatch) continue;
    const parsed = Number.parseInt(lockMatch[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      resolvedPid = parsed;
    }
  }
  return resolvedPid;
}

async function readClaudeDebugTail(sessionId: string): Promise<string> {
  const filePath = path.join(os.homedir(), ".claude", "debug", `${sessionId}.txt`);
  if (!existsSync(filePath)) return "";
  try {
    const { stdout } = await execFileAsync("tail", ["-n", "500", filePath], {
      maxBuffer: 512 * 1_024,
    });
    if (stdout.trim()) return stdout;
  } catch {
    // Fall through to full-file read below.
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

async function findClaudeProcessPidByDebugLog(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const sessionId = summary.sessionId.trim();
  if (!sessionId) return [];
  const debugTail = await readClaudeDebugTail(sessionId);
  if (!debugTail) return [];
  const debugPid = extractClaudeDebugProcessPid(debugTail);
  if (!debugPid || debugPid === requesterPid) return [];
  if (!isProcessAlive(debugPid)) return [];

  const runningProcesses = await listRunningProcesses();
  const matchedProcess = runningProcesses.find((processInfo) => processInfo.pid === debugPid);
  if (!matchedProcess) return [];
  if (!matchesCurrentUser(matchedProcess.user, identity)) return [];
  if (!commandMatchesAgent(matchedProcess.args, "claude")) return [];

  const projectKey = claudeProjectKeyFromTracePath(summary.path);
  if (projectKey) {
    const processCwd = await listProcessCwd(debugPid);
    if (claudeProjectKeyFromCwd(processCwd) !== projectKey) return [];
  }

  return [debugPid];
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

export function cursorProjectKeyFromTracePath(tracePath: string): string {
  const normalizedPath = tracePath.replace(/\\/g, "/");
  const marker = "/.cursor/projects/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex < 0) return "";
  const tail = normalizedPath.slice(markerIndex + marker.length);
  const projectKey = tail.split("/", 1)[0] ?? "";
  return projectKey.trim().toLowerCase();
}

export function cursorProjectKeyFromCwd(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  if (!normalized) return "";
  return normalized
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function geminiProjectHashFromTracePath(tracePath: string): string {
  const projectHash = geminiProjectKeyFromTracePath(tracePath);
  if (!/^[a-f0-9]{64}$/.test(projectHash)) return "";
  return projectHash;
}

export function geminiProjectKeyFromTracePath(tracePath: string): string {
  const normalizedPath = tracePath.replace(/\\/g, "/");
  const marker = "/.gemini/tmp/";
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex < 0) return "";
  const tail = normalizedPath.slice(markerIndex + marker.length);
  const projectKey = (tail.split("/", 1)[0] ?? "").trim().toLowerCase();
  if (!projectKey) return "";
  return projectKey;
}

export function geminiProjectHashesFromCwd(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return [];
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/g, "");
  const candidates = [trimmed, normalized].map((value) => value.trim()).filter((value) => value.length > 0);
  const uniqueValues = Array.from(new Set(candidates));
  return uniqueValues.map((value) => createHash("sha256").update(value).digest("hex"));
}

export function geminiProjectSlugsFromCwd(cwd: string): string[] {
  const trimmed = cwd.trim();
  if (!trimmed) return [];
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized) return [];

  const basename = normalized.split("/").filter(Boolean).at(-1) ?? "";
  const slugify = (value: string): string =>
    value
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();

  const slugs = [slugify(basename), slugify(normalized)].filter((value) => value.length > 0);
  return Array.from(new Set(slugs));
}

function geminiProjectKeyMatchesCwd(projectKey: string, cwd: string): boolean {
  const normalizedKey = projectKey.trim().toLowerCase();
  if (!normalizedKey) return false;
  if (/^[a-f0-9]{64}$/.test(normalizedKey)) {
    return geminiProjectHashesFromCwd(cwd).includes(normalizedKey);
  }
  return geminiProjectSlugsFromCwd(cwd).includes(normalizedKey);
}

export function extractCursorSessionIdsFromOpenPaths(openPaths: string[]): string[] {
  const sessionIds = new Set<string>();
  for (const openPath of openPaths) {
    const normalizedPath = openPath.replace(/\\/g, "/");
    const match = normalizedPath.match(
      /\/\.cursor\/chats\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/store\.db(?:-wal|-shm)?$/i,
    );
    if (!match || !match[1]) continue;
    sessionIds.add(match[1].toLowerCase());
  }
  return Array.from(sessionIds.values());
}

export function extractOpenCodeSessionIdsFromLogContent(logContent: string): string[] {
  const sessionIds = new Set<string>();
  const matcher = /sessionID=(ses_[A-Za-z0-9]+)/g;
  for (;;) {
    const match = matcher.exec(logContent);
    if (!match) break;
    const sessionId = (match[1] ?? "").trim();
    if (!sessionId) continue;
    sessionIds.add(sessionId);
  }
  return Array.from(sessionIds.values());
}

export function geminiLogsContainSessionId(logContent: string, sessionId: string): boolean {
  const normalizedSessionId = sessionId.trim().toLowerCase();
  if (!normalizedSessionId) return false;
  try {
    const parsed = JSON.parse(logContent) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.some((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = (entry as { sessionId?: unknown }).sessionId;
        return typeof candidate === "string" && candidate.trim().toLowerCase() === normalizedSessionId;
      });
    }
  } catch {
    // Fall through to string matching for malformed logs.
  }
  return logContent.toLowerCase().includes(normalizedSessionId);
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

  if (projectCandidates.length === 1) {
    return uniquePids([projectCandidates[0]?.pid ?? 0]);
  }
  return [];
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
    if (!commandMatchesAgent(processInfo.args, agent)) return false;
    if (isExcludedAgentCommand(processInfo.args, agent)) return false;
    return true;
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

  if (projectCandidates.length === 1) {
    return uniquePids([projectCandidates[0]?.pid ?? 0]);
  }
  return [];
}

export function selectAgentProcessPidsBySessionId(
  sessionId: string,
  agent: TraceSummary["agent"],
  processes: Pick<AgentCandidateProcess, "pid" | "user" | "args">[],
  identity: CurrentUserIdentity,
  requesterPid: number,
): number[] {
  const sameUserAgentCandidates = processes.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    if (!commandMatchesAgent(processInfo.args, agent)) return false;
    if (isExcludedAgentCommand(processInfo.args, agent)) return false;
    return true;
  });
  if (sameUserAgentCandidates.length === 0) return [];

  const normalizedSessionId = sessionId.trim().toLowerCase();
  if (normalizedSessionId) {
    const sessionCandidates = sameUserAgentCandidates.filter((processInfo) =>
      normalizeCommand(processInfo.args).includes(normalizedSessionId),
    );
    if (sessionCandidates.length > 0) {
      return uniquePids(sessionCandidates.map((processInfo) => processInfo.pid));
    }
  }

  if (sameUserAgentCandidates.length === 1) {
    return uniquePids([sameUserAgentCandidates[0]?.pid ?? 0]);
  }
  return [];
}

export function selectCursorProjectProcessPids(
  summary: Pick<TraceSummary, "path" | "sessionId">,
  processes: AgentCandidateProcess[],
  identity: CurrentUserIdentity,
  requesterPid: number,
): number[] {
  const projectKey = cursorProjectKeyFromTracePath(summary.path);
  if (!projectKey) return [];

  const sameUserCursorCandidates = processes.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "cursor");
  });
  if (sameUserCursorCandidates.length === 0) return [];

  const projectCandidates = sameUserCursorCandidates.filter(
    (processInfo) => cursorProjectKeyFromCwd(processInfo.cwd) === projectKey,
  );
  if (projectCandidates.length === 0) return [];

  const normalizedSessionId = summary.sessionId.trim().toLowerCase();
  if (normalizedSessionId) {
    const sessionCandidates = projectCandidates.filter((processInfo) =>
      normalizeCommand(processInfo.args).includes(normalizedSessionId),
    );
    if (sessionCandidates.length > 0) {
      return uniquePids(sessionCandidates.map((processInfo) => processInfo.pid));
    }
  }

  if (projectCandidates.length === 1) {
    return uniquePids([projectCandidates[0]?.pid ?? 0]);
  }
  return [];
}

export function selectGeminiProjectProcessPids(
  summary: Pick<TraceSummary, "path" | "sessionId">,
  processes: AgentCandidateProcess[],
  identity: CurrentUserIdentity,
  requesterPid: number,
): number[] {
  const projectKey = geminiProjectKeyFromTracePath(summary.path);
  if (!projectKey) return [];

  const sameUserGeminiCandidates = processes.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "gemini");
  });
  if (sameUserGeminiCandidates.length === 0) return [];

  const projectCandidates = sameUserGeminiCandidates.filter((processInfo) =>
    geminiProjectKeyMatchesCwd(projectKey, processInfo.cwd),
  );
  if (projectCandidates.length === 0) return [];

  const normalizedSessionId = summary.sessionId.trim().toLowerCase();
  if (normalizedSessionId) {
    const sessionCandidates = projectCandidates.filter((processInfo) =>
      normalizeCommand(processInfo.args).includes(normalizedSessionId),
    );
    if (sessionCandidates.length > 0) {
      return uniquePids(sessionCandidates.map((processInfo) => processInfo.pid));
    }
  }

  if (projectCandidates.length === 1) {
    return uniquePids([projectCandidates[0]?.pid ?? 0]);
  }
  return [];
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
    if (!commandMatchesAgent(processInfo.args, agent)) return false;
    if (isExcludedAgentCommand(processInfo.args, agent)) return false;
    return true;
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

async function findAgentProcessPidsBySessionId(
  sessionId: string,
  agent: TraceSummary["agent"],
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const runningProcesses = await listRunningProcesses();
  return selectAgentProcessPidsBySessionId(sessionId, agent, runningProcesses, identity, requesterPid);
}

async function findCursorProjectProcessPids(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const projectKey = cursorProjectKeyFromTracePath(summary.path);
  if (!projectKey) return [];

  const runningProcesses = await listRunningProcesses();
  const cursorProcesses = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "cursor");
  });
  if (cursorProcesses.length === 0) return [];

  const withCwd: AgentCandidateProcess[] = await Promise.all(
    cursorProcesses.map(async (processInfo) => ({
      ...processInfo,
      cwd: await listProcessCwd(processInfo.pid),
    })),
  );
  return selectCursorProjectProcessPids(summary, withCwd, identity, requesterPid);
}

async function findGeminiProjectProcessPids(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const projectKey = geminiProjectKeyFromTracePath(summary.path);
  if (!projectKey) return [];

  const runningProcesses = await listRunningProcesses();
  const geminiProcesses = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "gemini");
  });
  if (geminiProcesses.length === 0) return [];

  const withCwd: AgentCandidateProcess[] = await Promise.all(
    geminiProcesses.map(async (processInfo) => ({
      ...processInfo,
      cwd: await listProcessCwd(processInfo.pid),
    })),
  );
  return selectGeminiProjectProcessPids(summary, withCwd, identity, requesterPid);
}

function isOpenCodeLogPath(openPath: string): boolean {
  const normalizedPath = openPath.replace(/\\/g, "/");
  return normalizedPath.includes("/.local/share/opencode/log/") && normalizedPath.endsWith(".log");
}

async function readTextFileTail(filePath: string, lines: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tail", ["-n", String(Math.max(1, lines)), filePath], {
      maxBuffer: 512 * 1_024,
    });
    if (stdout.trim()) return stdout;
  } catch {
    // Fall through to whole-file read.
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

async function findCursorProcessPidsByChatStoreSession(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const normalizedSessionId = summary.sessionId.trim().toLowerCase();
  if (!normalizedSessionId) return [];

  const runningProcesses = await listRunningProcesses();
  const cursorCandidates = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "cursor");
  });
  if (cursorCandidates.length === 0) return [];

  const matchedPids: number[] = [];
  await Promise.all(
    cursorCandidates.map(async (processInfo) => {
      const openPaths = await listProcessOpenFilePaths(processInfo.pid);
      const sessionIds = extractCursorSessionIdsFromOpenPaths(openPaths);
      if (sessionIds.includes(normalizedSessionId)) {
        matchedPids.push(processInfo.pid);
      }
    }),
  );
  return uniquePids(matchedPids);
}

async function findOpenCodeProcessPidsByLogSession(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const sessionId = summary.sessionId.trim();
  if (!sessionId) return [];

  const runningProcesses = await listRunningProcesses();
  const openCodeCandidates = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    if (!commandMatchesAgent(processInfo.args, "opencode")) return false;
    if (isExcludedAgentCommand(processInfo.args, "opencode")) return false;
    return true;
  });
  if (openCodeCandidates.length === 0) return [];

  const matchedPids: number[] = [];
  await Promise.all(
    openCodeCandidates.map(async (processInfo) => {
      const openPaths = await listProcessOpenFilePaths(processInfo.pid);
      const logPaths = openPaths.filter((openPath) => isOpenCodeLogPath(openPath));
      if (logPaths.length === 0) return;
      for (const logPath of logPaths) {
        const logTail = await readTextFileTail(logPath, 800);
        if (!logTail) continue;
        if (extractOpenCodeSessionIdsFromLogContent(logTail).includes(sessionId)) {
          matchedPids.push(processInfo.pid);
          return;
        }
        let fullContent = "";
        try {
          fullContent = readFileSync(logPath, "utf8");
        } catch {
          fullContent = "";
        }
        if (fullContent && extractOpenCodeSessionIdsFromLogContent(fullContent).includes(sessionId)) {
          matchedPids.push(processInfo.pid);
          return;
        }
      }
    }),
  );
  return uniquePids(matchedPids);
}

async function findGeminiProcessPidsByProjectLog(
  summary: TraceSummary,
  identity: CurrentUserIdentity,
  requesterPid: number,
): Promise<number[]> {
  const projectKey = geminiProjectKeyFromTracePath(summary.path);
  const sessionId = summary.sessionId.trim();
  if (!projectKey || !sessionId) return [];

  const logsPath = path.join(os.homedir(), ".gemini", "tmp", projectKey, "logs.json");
  if (!existsSync(logsPath)) return [];

  let content = await readTextFileTail(logsPath, 500);
  if (!content || !geminiLogsContainSessionId(content, sessionId)) {
    try {
      content = readFileSync(logsPath, "utf8");
    } catch {
      content = "";
    }
  }
  if (!content || !geminiLogsContainSessionId(content, sessionId)) return [];

  const runningProcesses = await listRunningProcesses();
  const geminiCandidates = runningProcesses.filter((processInfo) => {
    if (processInfo.pid === requesterPid) return false;
    if (!matchesCurrentUser(processInfo.user, identity)) return false;
    return commandMatchesAgent(processInfo.args, "gemini");
  });
  if (geminiCandidates.length === 0) return [];

  const withCwd: AgentCandidateProcess[] = await Promise.all(
    geminiCandidates.map(async (processInfo) => ({
      ...processInfo,
      cwd: await listProcessCwd(processInfo.pid),
    })),
  );
  const projectCandidates = withCwd.filter((processInfo) => geminiProjectKeyMatchesCwd(projectKey, processInfo.cwd));
  if (projectCandidates.length === 0) return [];

  const normalizedSessionId = sessionId.toLowerCase();
  const sessionArgCandidates = projectCandidates.filter((processInfo) =>
    normalizeCommand(processInfo.args).includes(normalizedSessionId),
  );
  if (sessionArgCandidates.length > 0) {
    return uniquePids(sessionArgCandidates.map((processInfo) => processInfo.pid));
  }
  return uniquePids(projectCandidates.map((processInfo) => processInfo.pid));
}

async function excludeOpenCodeServePids(pids: number[]): Promise<number[]> {
  if (pids.length === 0) return [];
  try {
    const runningProcesses = await listRunningProcesses();
    const argsByPid = new Map<number, string>();
    for (const processInfo of runningProcesses) {
      argsByPid.set(processInfo.pid, processInfo.args);
    }
    return pids.filter((pid) => !isOpenCodeServeCommand(argsByPid.get(pid) ?? ""));
  } catch {
    // If process listing fails, keep original candidates to avoid false negatives.
    return pids;
  }
}

interface TimedPidCandidate {
  pid: number;
  tty: string;
  startedAtMs: number;
}

export function selectPidGroupByNearestTimestamp(candidates: TimedPidCandidate[], targetTimestampMs: number): number[] {
  if (!Number.isFinite(targetTimestampMs) || targetTimestampMs <= 0) return [];
  const byTty = new Map<string, TimedPidCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.tty || candidate.startedAtMs <= 0) continue;
    const current = byTty.get(candidate.tty) ?? [];
    current.push(candidate);
    byTty.set(candidate.tty, current);
  }
  if (byTty.size === 0) return [];

  const scored = Array.from(byTty.values()).map((group) => {
    const anchor = Math.min(...group.map((item) => item.startedAtMs));
    return {
      group,
      distance: Math.abs(anchor - targetTimestampMs),
      anchor,
    };
  });
  scored.sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.anchor !== right.anchor) return left.anchor - right.anchor;
    return left.group[0]?.tty.localeCompare(right.group[0]?.tty ?? "") ?? 0;
  });
  const best = scored[0];
  const second = scored[1];
  if (!best) return [];
  if (second && second.distance === best.distance) return [];
  return uniquePids(best.group.map((item) => item.pid));
}

function geminiSessionAnchorTimestampMs(tracePath: string): number {
  try {
    const content = readFileSync(tracePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    const record = parsed as {
      startTime?: unknown;
      lastUpdated?: unknown;
      messages?: unknown;
    };
    const parseCandidate = (value: unknown): number => {
      if (typeof value !== "string") return 0;
      const parsedValue = Date.parse(value);
      return Number.isFinite(parsedValue) ? parsedValue : 0;
    };
    const startTimeMs = parseCandidate(record.startTime);
    if (startTimeMs > 0) return startTimeMs;
    const messages = Array.isArray(record.messages) ? record.messages : [];
    const firstMessage = (messages[0] ?? {}) as { timestamp?: unknown };
    const firstMessageTimestampMs = parseCandidate(firstMessage.timestamp);
    if (firstMessageTimestampMs > 0) return firstMessageTimestampMs;
    return parseCandidate(record.lastUpdated);
  } catch {
    return 0;
  }
}

async function disambiguateGeminiMatchedPids(summary: TraceSummary, pids: number[]): Promise<number[]> {
  const unique = uniquePids(pids);
  if (unique.length <= 1) return unique;
  const targetTimestampMs = geminiSessionAnchorTimestampMs(summary.path);
  if (targetTimestampMs <= 0) return unique;

  const timedCandidates: TimedPidCandidate[] = await Promise.all(
    unique.map(async (pid) => ({
      pid,
      tty: await listProcessTty(pid),
      startedAtMs: await listProcessStartMs(pid),
    })),
  );
  const selected = selectPidGroupByNearestTimestamp(timedCandidates, targetTimestampMs);
  if (selected.length === 0) return unique;
  return selected;
}

async function disambiguateMatchedPidsByTty(pids: number[]): Promise<number[]> {
  const unique = uniquePids(pids);
  if (unique.length <= 1) return unique;
  const ttyPairs = await Promise.all(
    unique.map(async (pid) => ({
      pid,
      tty: await listProcessTty(pid),
    })),
  );
  if (ttyPairs.some((pair) => !pair.tty)) {
    return [];
  }
  const uniqueTtys = new Set(ttyPairs.map((pair) => pair.tty));
  if (uniqueTtys.size !== 1) {
    return [];
  }
  return unique;
}

async function resolveSessionProcessPids(
  summary: TraceSummary,
  requesterPid: number,
  sessionCwd = "",
): Promise<SessionProcessResolution> {
  const openFileProcesses = await listOpenFileProcesses(summary.path);
  const identity = currentUserIdentity();
  let argsByPid = new Map<number, string>();
  if (openFileProcesses.length > 0) {
    try {
      const runningProcesses = await listRunningProcesses();
      argsByPid = new Map<number, string>(runningProcesses.map((processInfo) => [processInfo.pid, processInfo.args]));
    } catch {
      argsByPid = new Map<number, string>();
    }
  }
  let matchedPids = selectOpenFileProcessPids({
    summary,
    openFileProcesses,
    argsByPid,
    identity,
    requesterPid,
  });
  if (summary.agent === "opencode" && matchedPids.length > 0) {
    matchedPids = await excludeOpenCodeServePids(matchedPids);
  }
  if (matchedPids.length === 0 && summary.agent === "claude") {
    matchedPids = await findClaudeProcessPidByDebugLog(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "claude") {
    matchedPids = await findClaudeProjectProcessPids(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "cursor") {
    matchedPids = await findCursorProcessPidsByChatStoreSession(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "cursor") {
    matchedPids = await findCursorProjectProcessPids(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "cursor") {
    matchedPids = await findAgentProcessPidsBySessionId(summary.sessionId, "cursor", identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "gemini") {
    matchedPids = await findGeminiProcessPidsByProjectLog(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "gemini") {
    matchedPids = await findGeminiProjectProcessPids(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "gemini") {
    matchedPids = await findAgentProcessPidsBySessionId(summary.sessionId, "gemini", identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "opencode") {
    matchedPids = await findOpenCodeProcessPidsByLogSession(summary, identity, requesterPid);
  }
  if (matchedPids.length === 0 && summary.agent === "opencode") {
    matchedPids = await findAgentProcessPidsBySessionId(summary.sessionId, "opencode", identity, requesterPid);
    if (matchedPids.length > 0) {
      matchedPids = await excludeOpenCodeServePids(matchedPids);
    }
  }
  if (matchedPids.length === 0 && sessionCwd) {
    matchedPids = await findAgentProjectProcessPids(
      sessionCwd,
      summary.sessionId,
      summary.agent,
      identity,
      requesterPid,
    );
    if (summary.agent === "opencode" && matchedPids.length > 0) {
      matchedPids = await excludeOpenCodeServePids(matchedPids);
    }
  }
  if (summary.agent === "gemini" && matchedPids.length > 1) {
    matchedPids = await disambiguateGeminiMatchedPids(summary, matchedPids);
  }
  if (matchedPids.length > 1) {
    matchedPids = await disambiguateMatchedPidsByTty(matchedPids);
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
    return {
      status: "not_resolvable",
      reason: "no active session process found",
      pid: null,
      tty: "",
      target: null,
      matchedPids: [],
      alivePids: [],
    };
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
        return {
          status: "not_resolvable",
          reason: `failed to focus tmux pane: ${asErrorMessage(error)}`,
          pid,
          tty,
          target: null,
          matchedPids,
          alivePids,
        };
      }
    } else {
      const scanned = tmuxLookup.scannedSockets.join(", ") || "default socket";
      return {
        status: "not_resolvable",
        reason: `pane focus unavailable: tty ${tty} not found in tmux sockets ${scanned}`,
        pid,
        tty,
        target: null,
        matchedPids,
        alivePids,
      };
    }
  }

  return {
    status: "not_resolvable",
    reason: "session process has no resolvable tmux tty",
    pid,
    tty,
    target: null,
    matchedPids,
    alivePids,
  };
}

async function sendTraceSessionInput(
  summary: TraceSummary,
  options: SendTraceInputOptions,
): Promise<SendTraceInputResult> {
  const requesterPid = options.requesterPid ?? process.pid;
  const text = normalizeTraceInputText(options.text);
  const submit = options.submit ?? true;
  const { matchedPids, alivePids } = await resolveSessionProcessPids(summary, requesterPid, options.sessionCwd ?? "");

  if (matchedPids.length === 0) {
    return {
      status: "not_resolvable",
      reason: "no active session process found",
      pid: null,
      tty: "",
      target: null,
      matchedPids: [],
      alivePids: [],
    };
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
      const targetName = `${paneMatch.tmuxSession}:${paneMatch.windowIndex}.${paneMatch.paneIndex}`;
      try {
        await runTmux(paneMatch.socketPath, ["send-keys", "-t", targetName, "-l", text], 256 * 1_024);
        if (submit) {
          await runTmux(paneMatch.socketPath, ["send-keys", "-t", targetName, "Enter"]);
        }
        return {
          status: "sent_tmux",
          reason: `sent input via tmux send-keys to ${targetName}${submit ? " + Enter" : ""}`,
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
        return {
          status: "failed",
          reason: `failed tmux input send: ${asErrorMessage(error)}`,
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
      }
    }
    const scanned = tmuxLookup.scannedSockets.join(", ") || "default socket";
    return {
      status: "not_resolvable",
      reason: `input requires tmux pane match; tty ${tty} not found in tmux sockets ${scanned}`,
      pid,
      tty,
      target: null,
      matchedPids,
      alivePids,
    };
  }

  return {
    status: "not_resolvable",
    reason: "input requires tmux pane targeting; session process has no resolvable tmux tty",
    pid,
    tty,
    target: null,
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
  const openTraceSession = options.openTraceSession ?? openTraceSessionProcess;
  const sendTraceInput = options.sendTraceInput ?? sendTraceSessionInput;
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
  server.get("/api/perf", async () => ({ perf: traceIndex.getPerformanceStats() }));

  server.get("/api/traces", async (request) => {
    const query = request.query as { agent?: string; limit?: string };
    const traces = listRecentTraceSummaries(traceIndex, query);
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

  server.post("/api/trace/:id/input", async (request, reply) => {
    const params = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: unknown; submit?: unknown };
    const textRaw = typeof body.text === "string" ? body.text : "";
    const text = normalizeTraceInputText(textRaw);
    const submit = body.submit === false ? false : true;

    if (!text.trim()) {
      reply.code(400);
      return { ok: false, error: "input text is required" };
    }
    if (text.length > MAX_TRACE_INPUT_TEXT_LENGTH) {
      reply.code(400);
      return {
        ok: false,
        error: `input text too long (max ${MAX_TRACE_INPUT_TEXT_LENGTH} chars)`,
      };
    }

    try {
      const resolvedId = traceIndex.resolveId(params.id);
      const detail = traceIndex.getSessionDetail(resolvedId);
      const summary = detail.summary;
      const sessionCwd = inferSessionCwd(detail);
      const result = await sendTraceInput(summary, {
        requesterPid: process.pid,
        sessionCwd,
        text,
        submit,
      });
      if (result.status === "sent_tmux") {
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
    const query = request.query as { agent?: string; limit?: string };
    const traces = listRecentTraceSummaries(traceIndex, query);

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
          traces,
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
