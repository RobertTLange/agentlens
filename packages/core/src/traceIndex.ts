import { EventEmitter } from "node:events";
import path from "node:path";
import { open, stat } from "node:fs/promises";
import chokidar, { type FSWatcher } from "chokidar";
import type {
  ActivityBinsMode,
  AppConfig,
  EventKind,
  IndexPerformanceStats,
  NamedCount,
  NormalizedEvent,
  OverviewStats,
  ResidentTier,
  SessionActivityStatus,
  SessionDetail,
  StreamEnvelope,
  TracePage,
  TraceTocItem,
  TraceSummary,
} from "@agentlens/contracts";
import { discoverTraceFiles, type DiscoveredTraceFile } from "./discovery.js";
import { ParserRegistry } from "./parsers/index.js";
import { loadConfig } from "./config.js";
import { deriveSessionMetrics } from "./metrics.js";
import { redactEvents } from "./redaction.js";
import { asRecord, asString, expandHome, nowMs, stableId } from "./utils.js";

const EVENT_KIND_KEYS: EventKind[] = [
  "system",
  "assistant",
  "user",
  "tool_use",
  "tool_result",
  "reasoning",
  "meta",
];

const WAITING_INPUT_PATTERN =
  /\b(?:await(?:ing)?\s+(?:user|input)|waiting\s+for\s+(?:user|input|approval)|user\s+input\s+required|needs?\s+user\s+input|permission\s+required|approval\s+required|confirm(?:ation)?\s+(?:required|needed)|press\s+enter\s+to\s+continue)\b/i;
const WAITING_PROMPT_PATTERN =
  /\b(?:do\s+you\s+want(?:\s+me)?|would\s+you\s+like(?:\s+me)?|should\s+i\b|can\s+you\s+confirm|please\s+confirm|let\s+me\s+know\s+if\s+you(?:'d)?\s+like|which\s+(?:option|approach)|choose\s+(?:one|an?\s+option)|pick\s+(?:one|an?\s+option)|approve(?:\s+this)?|permission\s+to)\b/i;
const ACTIVITY_BIN_COUNT = 12;
const MATERIALIZED_TTL_MS = 5 * 60_000;
const DIRTY_BATCH_LIMIT = 64;

interface TraceEntry {
  file: DiscoveredTraceFile;
  summary: TraceSummary;
  residentEvents: NormalizedEvent[];
  cachedFullEvents: NormalizedEvent[] | null;
  pinnedMaterializedAtMs: number;
}

export interface TracePageOptions {
  limit?: number;
  before?: string;
  includeMeta?: boolean;
}

export interface TraceIndexEvent {
  envelope: StreamEnvelope;
}

interface ActivityStatus {
  status: SessionActivityStatus;
  reason: string;
}

interface ActivityStatusOptions {
  events: NormalizedEvent[];
  unmatchedToolUses: number;
  updatedMs: number;
  nowMs: number;
  scanConfig: AppConfig["scan"];
}

interface ActivityBinsMeta {
  bins: number[];
  mode: ActivityBinsMode;
  binCount: number;
  windowMinutes?: number;
  binMinutes?: number;
}

interface RefreshStats {
  parsedFileCount: number;
  dirtyPathCount: number;
  usedFullRefresh: boolean;
  hadFileMutations: boolean;
}

interface ParserCursorState {
  parsedSizeBytes: number;
  pendingText: string;
  parserName: string;
}

function emptyEventKindCounts(): Record<EventKind, number> {
  return {
    system: 0,
    assistant: 0,
    user: 0,
    tool_use: 0,
    tool_result: 0,
    reasoning: 0,
    meta: 0,
  };
}

function normalizeActivityCounts(counts: number[]): number[] {
  let maxCount = 0;
  for (const count of counts) {
    if (count > maxCount) maxCount = count;
  }
  if (maxCount <= 0) return counts.map(() => 0);
  return counts.map((count) => count / maxCount);
}

function buildTimeActivityBins(timestampMsValues: number[]): ActivityBinsMeta | undefined {
  if (timestampMsValues.length < 2) return undefined;
  const firstTimestampMs = timestampMsValues[0] ?? 0;
  const lastTimestampMs = timestampMsValues[timestampMsValues.length - 1] ?? 0;
  const spanMs = lastTimestampMs - firstTimestampMs;
  if (spanMs <= 0) return undefined;

  const bins = Array.from({ length: ACTIVITY_BIN_COUNT }, () => 0);
  for (const timestampMs of timestampMsValues) {
    const elapsedMs = timestampMs - firstTimestampMs;
    const rawBinIndex = Math.floor((elapsedMs / spanMs) * ACTIVITY_BIN_COUNT);
    const binIndex = Math.max(0, Math.min(ACTIVITY_BIN_COUNT - 1, rawBinIndex));
    bins[binIndex] = (bins[binIndex] ?? 0) + 1;
  }

  const windowMinutes = spanMs / 60_000;
  return {
    bins: normalizeActivityCounts(bins),
    mode: "time",
    binCount: ACTIVITY_BIN_COUNT,
    windowMinutes,
    binMinutes: windowMinutes / ACTIVITY_BIN_COUNT,
  };
}

function buildEventIndexActivityBins(events: NormalizedEvent[]): ActivityBinsMeta {
  const bins = Array.from({ length: ACTIVITY_BIN_COUNT }, () => 0);
  const totalEvents = events.length;

  for (let index = 0; index < totalEvents; index += 1) {
    const rawBinIndex = Math.floor((index / totalEvents) * ACTIVITY_BIN_COUNT);
    const binIndex = Math.max(0, Math.min(ACTIVITY_BIN_COUNT - 1, rawBinIndex));
    bins[binIndex] = (bins[binIndex] ?? 0) + 1;
  }

  return {
    bins: normalizeActivityCounts(bins),
    mode: "event_index",
    binCount: ACTIVITY_BIN_COUNT,
  };
}

function buildActivityBins(events: NormalizedEvent[]): ActivityBinsMeta {
  const timestampMsValues: number[] = [];
  for (const event of events) {
    const timestampMs = event.timestampMs;
    if (timestampMs === null || timestampMs <= 0) continue;
    timestampMsValues.push(timestampMs);
  }
  return buildTimeActivityBins(timestampMsValues) ?? buildEventIndexActivityBins(events);
}

function numericMetaEqual(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return Math.abs(left - right) <= 1e-9;
}

function activityBinsEqual(left: number[] | undefined, right: number[]): boolean {
  if (!left || left.length !== right.length) return false;
  for (let idx = 0; idx < right.length; idx += 1) {
    const lhs = left[idx];
    const rhs = right[idx] ?? 0;
    if (lhs === undefined || Math.abs(lhs - rhs) > 1e-9) return false;
  }
  return true;
}

function normalizeMarkerText(value: unknown): string {
  return asString(value)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

function isStructuredWaitingValue(value: unknown): boolean {
  const normalized = normalizeMarkerText(value);
  if (!normalized) return false;

  if (normalized === "waiting") return true;
  if (normalized.includes("awaiting") && (normalized.includes("user") || normalized.includes("input"))) return true;
  if (normalized.includes("waiting for") && (normalized.includes("user") || normalized.includes("input"))) return true;
  if ((normalized.includes("needs") || normalized.includes("requires")) && normalized.includes("input")) return true;
  if (normalized.includes("approval required") || normalized.includes("permission required")) return true;
  if (normalized.includes("confirmation required") || normalized.includes("confirmation needed")) return true;
  if (normalized.includes("press enter to continue")) return true;
  return false;
}

function hasStructuredWaitingSignal(event: NormalizedEvent): boolean {
  const raw = asRecord(event.raw);
  const payload = asRecord(raw.payload);
  const part = asRecord(raw.part);
  const partState = asRecord(part.state);
  const message = asRecord(raw.message);

  const candidates: unknown[] = [
    event.rawType,
    raw.type,
    raw.subtype,
    raw.status,
    raw.state,
    raw.phase,
    raw.reason,
    payload.type,
    payload.subtype,
    payload.status,
    payload.state,
    payload.phase,
    payload.reason,
    part.type,
    part.status,
    part.state,
    part.phase,
    part.reason,
    partState.status,
    partState.state,
    partState.phase,
    partState.reason,
    message.status,
    message.state,
    message.phase,
  ];

  return candidates.some((value) => isStructuredWaitingValue(value));
}

function hasTextWaitingSignal(event: NormalizedEvent): boolean {
  const latestText = [
    event.rawType,
    event.preview,
    ...event.textBlocks,
    event.toolArgsText,
    event.toolResultText,
  ].join(" ");
  return WAITING_INPUT_PATTERN.test(latestText) || WAITING_PROMPT_PATTERN.test(latestText);
}

function isWaitResolutionEvent(event: NormalizedEvent): boolean {
  return event.eventKind === "user" || event.eventKind === "tool_use" || event.eventKind === "tool_result";
}

function findPendingWaitSignalEvent(events: NormalizedEvent[]): NormalizedEvent | undefined {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx];
    if (!event) continue;
    if (isWaitResolutionEvent(event)) return undefined;
    if (hasStructuredWaitingSignal(event) || hasTextWaitingSignal(event)) return event;
  }
  return undefined;
}

function applyFreshnessTtl(
  activity: ActivityStatus,
  updatedMs: number,
  nowMsValue: number,
  scanConfig: AppConfig["scan"],
  ttlOverrideMs?: number,
): ActivityStatus {
  if (activity.status === "idle") return activity;
  if (updatedMs <= 0) return { status: "idle", reason: "stale_timeout" };

  const ageMs = Math.max(0, nowMsValue - updatedMs);
  const ttlMs =
    ttlOverrideMs !== undefined
      ? Math.max(0, ttlOverrideMs)
      : activity.status === "running"
        ? Math.max(0, scanConfig.statusRunningTtlMs)
        : Math.max(0, scanConfig.statusWaitingTtlMs);
  if (ageMs > ttlMs) {
    return { status: "idle", reason: "stale_timeout" };
  }
  return activity;
}

function deriveActivityStatus(options: ActivityStatusOptions): ActivityStatus {
  const pendingWaitSignalEvent = findPendingWaitSignalEvent(options.events);
  if (pendingWaitSignalEvent) {
    return applyFreshnessTtl(
      { status: "waiting_input", reason: "explicit_wait_marker_fresh" },
      options.updatedMs,
      options.nowMs,
      options.scanConfig,
    );
  }

  if (options.unmatchedToolUses > 0) {
    return applyFreshnessTtl(
      { status: "running", reason: "pending_tool_use_fresh" },
      options.updatedMs,
      options.nowMs,
      options.scanConfig,
      options.scanConfig.statusWaitingTtlMs,
    );
  }

  if (options.updatedMs > 0) {
    const runningAgeMs = Math.max(0, options.nowMs - options.updatedMs);
    const runningTtlMs = Math.max(0, options.scanConfig.statusRunningTtlMs);
    if (runningAgeMs <= runningTtlMs) {
      return { status: "running", reason: "recent_activity_fresh" };
    }

    const waitingTtlMs = Math.max(0, options.scanConfig.statusWaitingTtlMs);
    if (runningAgeMs > runningTtlMs && runningAgeMs <= waitingTtlMs) {
      return { status: "waiting_input", reason: "recent_activity_cooling" };
    }
  }

  return { status: "idle", reason: "no_active_signal" };
}

function withDerivedActivityStatus(
  summary: TraceSummary,
  events: NormalizedEvent[],
  fileMtimeMs: number,
  scanConfig: AppConfig["scan"],
  nowMsValue: number,
): TraceSummary {
  const activityBinsMeta = buildActivityBins(events);
  const activityStatus = deriveActivityStatus({
    events,
    unmatchedToolUses: summary.unmatchedToolUses,
    updatedMs: Math.max(summary.lastEventTs ?? 0, fileMtimeMs),
    nowMs: nowMsValue,
    scanConfig,
  });
  const activityMetaUnchanged =
    summary.activityBinsMode === activityBinsMeta.mode &&
    summary.activityBinCount === activityBinsMeta.binCount &&
    numericMetaEqual(summary.activityWindowMinutes, activityBinsMeta.windowMinutes) &&
    numericMetaEqual(summary.activityBinMinutes, activityBinsMeta.binMinutes);
  const binsUnchanged = activityBinsEqual(summary.activityBins, activityBinsMeta.bins);
  if (
    summary.activityStatus === activityStatus.status &&
    summary.activityReason === activityStatus.reason &&
    binsUnchanged &&
    activityMetaUnchanged
  ) {
    return summary;
  }
  const { activityWindowMinutes: _prevWindowMinutes, activityBinMinutes: _prevBinMinutes, ...rest } = summary;
  return {
    ...rest,
    activityStatus: activityStatus.status,
    activityReason: activityStatus.reason,
    activityBins: activityBinsMeta.bins,
    activityBinsMode: activityBinsMeta.mode,
    activityBinCount: activityBinsMeta.binCount,
    ...(activityBinsMeta.windowMinutes !== undefined ? { activityWindowMinutes: activityBinsMeta.windowMinutes } : {}),
    ...(activityBinsMeta.binMinutes !== undefined ? { activityBinMinutes: activityBinsMeta.binMinutes } : {}),
  };
}

function withAgedActivityStatus(summary: TraceSummary, fileMtimeMs: number, scanConfig: AppConfig["scan"], nowMsValue: number): TraceSummary {
  if (summary.activityStatus === "idle") return summary;
  const updatedMs = Math.max(summary.lastEventTs ?? 0, fileMtimeMs);
  if (updatedMs <= 0) {
    return { ...summary, activityStatus: "idle", activityReason: "stale_timeout" };
  }

  const ageMs = Math.max(0, nowMsValue - updatedMs);
  const runningTtlMs = Math.max(0, scanConfig.statusRunningTtlMs);
  const waitingTtlMs = Math.max(0, scanConfig.statusWaitingTtlMs);

  if (ageMs > waitingTtlMs) {
    return { ...summary, activityStatus: "idle", activityReason: "stale_timeout" };
  }
  if (summary.unmatchedToolUses > 0) {
    if (summary.activityStatus === "running" && summary.activityReason === "pending_tool_use_fresh") return summary;
    return { ...summary, activityStatus: "running", activityReason: "pending_tool_use_fresh" };
  }
  if (summary.activityStatus === "running" && ageMs > runningTtlMs && ageMs <= waitingTtlMs) {
    if (summary.activityReason === "recent_activity_cooling") return summary;
    return { ...summary, activityStatus: "waiting_input", activityReason: "recent_activity_cooling" };
  }
  return summary;
}

function summarize(
  file: DiscoveredTraceFile,
  agent: TraceSummary["agent"],
  parser: string,
  sessionId: string,
  events: NormalizedEvent[],
  parseError: string,
  config: AppConfig,
  nowMsValue: number,
): TraceSummary {
  const eventKindCounts = emptyEventKindCounts();
  const topToolCounts = new Map<string, number>();
  let errorCount = 0;
  let toolUseCount = 0;
  let toolResultCount = 0;
  let firstEventTs: number | null = null;
  let lastEventTs: number | null = null;

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const event of events) {
    eventKindCounts[event.eventKind] += 1;
    if (event.hasError) errorCount += 1;
    if (event.eventKind === "tool_use") {
      toolUseCount += 1;
      const toolName = event.toolName || event.functionName;
      if (toolName) {
        topToolCounts.set(toolName, (topToolCounts.get(toolName) ?? 0) + 1);
      }
      if (event.toolUseId) toolUseIds.add(event.toolUseId);
    }
    if (event.eventKind === "tool_result") {
      toolResultCount += 1;
      if (event.toolUseId) toolResultIds.add(event.toolUseId);
    }
    if (event.timestampMs !== null) {
      // Preserve file order semantics: start = first timestamped event in file, updated = last.
      firstEventTs ??= event.timestampMs;
      lastEventTs = event.timestampMs;
    }
  }

  let unmatchedToolUses = 0;
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) unmatchedToolUses += 1;
  }

  let unmatchedToolResults = 0;
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) unmatchedToolResults += 1;
  }

  const updatedMs = Math.max(lastEventTs ?? 0, file.mtimeMs);
  const activityStatus = deriveActivityStatus({
    events,
    unmatchedToolUses,
    updatedMs,
    nowMs: nowMsValue,
    scanConfig: config.scan,
  });
  const activityBinsMeta = buildActivityBins(events);
  const sessionMetrics = deriveSessionMetrics(events, agent, config);
  const topTools: NamedCount[] = Array.from(topToolCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }));

  return {
    id: file.id,
    sourceProfile: file.sourceProfile,
    path: file.path,
    agent,
    parser,
    sessionId,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    firstEventTs,
    lastEventTs,
    eventCount: events.length,
    parseable: parseError.length === 0,
    parseError,
    errorCount,
    toolUseCount,
    toolResultCount,
    unmatchedToolUses,
    unmatchedToolResults,
    activityStatus: activityStatus.status,
    activityReason: activityStatus.reason,
    activityBins: activityBinsMeta.bins,
    activityBinsMode: activityBinsMeta.mode,
    activityBinCount: activityBinsMeta.binCount,
    ...(activityBinsMeta.windowMinutes !== undefined ? { activityWindowMinutes: activityBinsMeta.windowMinutes } : {}),
    ...(activityBinsMeta.binMinutes !== undefined ? { activityBinMinutes: activityBinsMeta.binMinutes } : {}),
    tokenTotals: sessionMetrics.tokenTotals,
    modelTokenSharesTop: sessionMetrics.modelTokenSharesTop,
    modelTokenSharesEstimated: sessionMetrics.modelTokenSharesEstimated,
    contextWindowPct: sessionMetrics.contextWindowPct,
    costEstimateUsd: sessionMetrics.costEstimateUsd,
    eventKindCounts,
    residentTier: "hot",
    isMaterialized: true,
    topTools,
  };
}

function sortSummaries(items: TraceSummary[]): TraceSummary[] {
  return [...items].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function buildToc(events: NormalizedEvent[]): TraceTocItem[] {
  return events.map((event) => ({
    eventId: event.eventId,
    index: event.index,
    timestampMs: event.timestampMs,
    eventKind: event.eventKind,
    label: event.tocLabel || event.preview,
    colorKey: event.eventKind,
    toolType: event.toolType,
  }));
}

function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function looksLikeCompleteJsonObject(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function splitCompleteJsonlText(chunk: string): { completeText: string; pendingText: string } {
  if (!chunk) return { completeText: "", pendingText: "" };

  const lastNewline = Math.max(chunk.lastIndexOf("\n"), chunk.lastIndexOf("\r"));
  if (lastNewline < 0) {
    return looksLikeCompleteJsonObject(chunk) ? { completeText: chunk, pendingText: "" } : { completeText: "", pendingText: chunk };
  }

  const completeText = chunk.slice(0, lastNewline + 1);
  const pendingText = chunk.slice(lastNewline + 1);
  return { completeText, pendingText };
}

export class TraceIndex extends EventEmitter {
  private readonly parserRegistry = new ParserRegistry();
  private config: AppConfig;
  private entries = new Map<string, TraceEntry>();
  private pathToId = new Map<string, string>();
  private cursorById = new Map<string, ParserCursorState>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private streamVersion = 0;
  private started = false;
  private refreshInFlight = false;
  private refreshPending = false;
  private queuedForceFullRefresh = false;
  private dirtyPaths = new Set<string>();
  private adaptiveIntervalMs: number;
  private perf: IndexPerformanceStats = {
    refreshCount: 0,
    fullRefreshCount: 0,
    dirtyRefreshCount: 0,
    idleRefreshCount: 0,
    parsedFileCount: 0,
    incrementalAppendCount: 0,
    fullReparseCount: 0,
    lastRefreshDurationMs: 0,
    lastRefreshAtMs: 0,
    averageRefreshDurationMs: 0,
    watcherRoots: 0,
    trackedFiles: 0,
    dirtyPathQueue: 0,
    hotTraces: 0,
    warmTraces: 0,
    coldTraces: 0,
    materializedTraces: 0,
  };
  private lastFullRefreshAtMs = 0;

  constructor(config: AppConfig) {
    super();
    this.config = config;
    this.adaptiveIntervalMs = this.computeBaseIntervalMs();
  }

  static async fromConfigPath(configPath?: string): Promise<TraceIndex> {
    const config = await loadConfig(configPath);
    return new TraceIndex(config);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  setConfig(config: AppConfig): void {
    this.config = config;
    this.adaptiveIntervalMs = this.computeBaseIntervalMs();
    if (this.started) {
      void this.restartWatcher();
      this.scheduleNextRefresh(this.config.scan.batchDebounceMs);
    }
  }

  async start(): Promise<void> {
    this.started = true;
    await this.refresh();
    await this.restartWatcher();
    this.scheduleNextRefresh(this.computeBaseIntervalMs());
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
  }

  async refresh(): Promise<void> {
    this.queuedForceFullRefresh = true;
    await this.runRefreshLoop();
  }

  getPerformanceStats(): IndexPerformanceStats {
    const stats = this.buildRetentionStats();
    return {
      ...this.perf,
      trackedFiles: this.entries.size,
      dirtyPathQueue: this.dirtyPaths.size,
      ...stats,
    };
  }

  getTopTools(limit = 12): NamedCount[] {
    const counts = new Map<string, number>();
    for (const entry of this.entries.values()) {
      for (const row of entry.summary.topTools ?? []) {
        counts.set(row.name, (counts.get(row.name) ?? 0) + row.count);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, Math.max(1, limit))
      .map(([name, count]) => ({ name, count }));
  }

  private buildRetentionStats(): Pick<
    IndexPerformanceStats,
    "hotTraces" | "warmTraces" | "coldTraces" | "materializedTraces"
  > {
    let hotTraces = 0;
    let warmTraces = 0;
    let coldTraces = 0;
    let materializedTraces = 0;
    for (const entry of this.entries.values()) {
      if (entry.summary.residentTier === "hot") hotTraces += 1;
      else if (entry.summary.residentTier === "warm") warmTraces += 1;
      else coldTraces += 1;
      if (entry.summary.isMaterialized) materializedTraces += 1;
    }
    return { hotTraces, warmTraces, coldTraces, materializedTraces };
  }

  private computeBaseIntervalMs(): number {
    if (this.config.scan.mode === "fixed") {
      return Math.max(100, Math.round(this.config.scan.intervalSeconds * 1000));
    }
    return Math.max(50, this.config.scan.intervalMinMs);
  }

  private nextIntervalMs(): number {
    if (this.config.scan.mode === "fixed") {
      return this.computeBaseIntervalMs();
    }
    const minMs = Math.max(50, this.config.scan.intervalMinMs);
    const maxMs = Math.max(minMs, this.config.scan.intervalMaxMs);
    return Math.max(minMs, Math.min(maxMs, this.adaptiveIntervalMs));
  }

  private scheduleNextRefresh(delayMs = this.nextIntervalMs()): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.triggerRefresh(false);
    }, Math.max(25, delayMs));
  }

  private async restartWatcher(): Promise<void> {
    const roots = this.collectWatchRoots();
    this.perf.watcherRoots = roots.length;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (roots.length === 0) return;

    const debounceMs = Math.max(50, this.config.scan.batchDebounceMs);
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
        pollInterval: 40,
      },
    });

    const onDirty = (rawPath: string): void => {
      if (!rawPath.toLowerCase().endsWith(".jsonl")) return;
      this.dirtyPaths.add(path.resolve(rawPath));
      this.perf.dirtyPathQueue = this.dirtyPaths.size;
      this.scheduleNextRefresh(debounceMs);
    };
    this.watcher.on("add", onDirty);
    this.watcher.on("change", onDirty);
    this.watcher.on("unlink", onDirty);
    this.watcher.on("error", () => {
      // Fallback periodic full-rescan handles watcher misses.
    });
  }

  private collectWatchRoots(): string[] {
    const dedup = new Set<string>();
    const hasPathSegment = (input: string, segment: string): boolean =>
      path
        .normalize(input)
        .split(path.sep)
        .some((part) => part.toLowerCase() === segment.toLowerCase());

    for (const entry of this.config.sessionLogDirectories) {
      const baseRoot = path.resolve(expandHome(entry.directory));
      const watchRoot =
        entry.logType === "codex"
          ? hasPathSegment(baseRoot, "sessions")
            ? baseRoot
            : path.join(baseRoot, "sessions")
          : entry.logType === "claude"
            ? hasPathSegment(baseRoot, "projects")
              ? baseRoot
              : path.join(baseRoot, "projects")
            : baseRoot;
      dedup.add(watchRoot);
    }
    for (const profile of Object.values(this.config.sources)) {
      if (!profile.enabled) continue;
      for (const root of profile.roots) {
        dedup.add(path.resolve(expandHome(root)));
      }
    }
    return Array.from(dedup.values());
  }

  private shouldRunFullRefresh(nowMsValue: number): boolean {
    if (this.lastFullRefreshAtMs <= 0) return true;
    const fullIntervalMs = Math.max(1_000, this.config.scan.fullRescanIntervalMs);
    return nowMsValue - this.lastFullRefreshAtMs >= fullIntervalMs;
  }

  private async triggerRefresh(forceFull: boolean): Promise<void> {
    if (forceFull) this.queuedForceFullRefresh = true;
    await this.runRefreshLoop();
  }

  private async runRefreshLoop(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshPending = true;
      return;
    }
    this.refreshInFlight = true;
    try {
      this.refreshPending = false;
      const startedAtMs = nowMs();
      const useFullRefresh = this.queuedForceFullRefresh || this.shouldRunFullRefresh(startedAtMs);
      this.queuedForceFullRefresh = false;
      const stats = await this.performRefresh(useFullRefresh, startedAtMs);
      this.recordRefreshPerf(stats, startedAtMs);
    } finally {
      this.refreshInFlight = false;
      if (this.refreshPending || this.queuedForceFullRefresh) {
        this.scheduleNextRefresh(25);
      } else if (this.started) {
        this.scheduleNextRefresh();
      }
    }
  }

  private recordRefreshPerf(stats: RefreshStats, startedAtMs: number): void {
    const finishedAtMs = nowMs();
    const durationMs = Math.max(0, finishedAtMs - startedAtMs);
    this.perf.refreshCount += 1;
    this.perf.parsedFileCount += stats.parsedFileCount;
    this.perf.lastRefreshDurationMs = durationMs;
    this.perf.lastRefreshAtMs = finishedAtMs;
    this.perf.averageRefreshDurationMs =
      this.perf.refreshCount === 1
        ? durationMs
        : this.perf.averageRefreshDurationMs + (durationMs - this.perf.averageRefreshDurationMs) / this.perf.refreshCount;
    if (stats.usedFullRefresh) this.perf.fullRefreshCount += 1;
    else if (stats.dirtyPathCount > 0) this.perf.dirtyRefreshCount += 1;
    else this.perf.idleRefreshCount += 1;

    if (this.config.scan.mode === "adaptive") {
      const minMs = Math.max(50, this.config.scan.intervalMinMs);
      const maxMs = Math.max(minMs, this.config.scan.intervalMaxMs);
      if (stats.hadFileMutations) this.adaptiveIntervalMs = minMs;
      else this.adaptiveIntervalMs = Math.min(maxMs, Math.round(Math.max(minMs, this.adaptiveIntervalMs) * 1.4));
    }
  }

  private async performRefresh(useFullRefresh: boolean, refreshNowMs: number): Promise<RefreshStats> {
    const stats: RefreshStats = {
      parsedFileCount: 0,
      dirtyPathCount: this.dirtyPaths.size,
      usedFullRefresh: useFullRefresh,
      hadFileMutations: false,
    };
    if (useFullRefresh) {
      await this.refreshFull(refreshNowMs, stats);
    } else {
      await this.refreshDirty(refreshNowMs, stats);
    }
    this.applyRetention(refreshNowMs);
    this.refreshActivityStatus(refreshNowMs, stats);
    this.perf.trackedFiles = this.entries.size;
    this.perf.dirtyPathQueue = this.dirtyPaths.size;
    const retentionStats = this.buildRetentionStats();
    this.perf.hotTraces = retentionStats.hotTraces;
    this.perf.warmTraces = retentionStats.warmTraces;
    this.perf.coldTraces = retentionStats.coldTraces;
    this.perf.materializedTraces = retentionStats.materializedTraces;
    this.emitStream("overview_updated", { overview: this.getOverview() });
    return stats;
  }

  private async refreshFull(refreshNowMs: number, stats: RefreshStats): Promise<void> {
    const files = await discoverTraceFiles(this.config);
    this.lastFullRefreshAtMs = refreshNowMs;

    const nextIds = new Set(files.map((file) => file.id));
    const nextPathToId = new Map<string, string>();
    for (const file of files) {
      nextPathToId.set(file.path, file.id);
    }
    this.pathToId = nextPathToId;

    for (const existingId of this.entries.keys()) {
      if (!nextIds.has(existingId)) {
        this.entries.delete(existingId);
        this.cursorById.delete(existingId);
        this.emitStream("trace_removed", { id: existingId });
        stats.hadFileMutations = true;
      }
    }

    for (const file of files) {
      const changed = await this.upsertFile(file, refreshNowMs);
      if (changed) {
        stats.parsedFileCount += 1;
        stats.hadFileMutations = true;
      }
    }
  }

  private async refreshDirty(refreshNowMs: number, stats: RefreshStats): Promise<void> {
    if (this.dirtyPaths.size === 0) return;
    const dirtyPaths: string[] = [];
    for (const dirtyPath of this.dirtyPaths) {
      dirtyPaths.push(dirtyPath);
      this.dirtyPaths.delete(dirtyPath);
      if (dirtyPaths.length >= DIRTY_BATCH_LIMIT) break;
    }
    if (this.dirtyPaths.size > 0) {
      this.refreshPending = true;
    }
    this.perf.dirtyPathQueue = this.dirtyPaths.size;
    stats.dirtyPathCount = dirtyPaths.length;

    const processedIds = new Set<string>();
    for (const dirtyPath of dirtyPaths) {
      const normalizedPath = path.resolve(dirtyPath);
      const existingId = this.pathToId.get(normalizedPath);
      const file = await this.discoverSingleTraceFile(normalizedPath, existingId);
      if (!file) {
        if (existingId && this.entries.delete(existingId)) {
          this.cursorById.delete(existingId);
          this.emitStream("trace_removed", { id: existingId });
          stats.hadFileMutations = true;
        }
        this.pathToId.delete(normalizedPath);
        continue;
      }

      this.pathToId.set(file.path, file.id);
      if (existingId && existingId !== file.id && this.entries.delete(existingId)) {
        this.cursorById.delete(existingId);
        this.emitStream("trace_removed", { id: existingId });
        stats.hadFileMutations = true;
      }
      if (processedIds.has(file.id)) continue;
      processedIds.add(file.id);

      const changed = await this.upsertFile(file, refreshNowMs);
      if (changed) {
        stats.parsedFileCount += 1;
        stats.hadFileMutations = true;
      }
    }
  }

  private inferSourceMetadata(filePath: string): Pick<DiscoveredTraceFile, "sourceProfile" | "agentHint" | "parserHint"> | null {
    const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase();
    for (const entry of this.config.sessionLogDirectories) {
      const root = path.resolve(expandHome(entry.directory));
      const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
      if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) continue;
      if (entry.logType === "codex" && !normalizedPath.includes("/sessions/")) continue;
      if (entry.logType === "claude" && !normalizedPath.includes("/projects/")) continue;
      return {
        sourceProfile: "session_log",
        agentHint: entry.logType,
        parserHint: entry.logType,
      };
    }

    const sourceNames = Object.keys(this.config.sources).sort();
    for (const sourceName of sourceNames) {
      const profile = this.config.sources[sourceName];
      if (!profile?.enabled) continue;
      for (const rootRaw of profile.roots) {
        const root = path.resolve(expandHome(rootRaw));
        const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
        if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}/`)) continue;
        const hint = profile.agentHint ?? "unknown";
        return {
          sourceProfile: sourceName,
          agentHint: hint,
          ...(hint !== "unknown" ? { parserHint: hint } : {}),
        };
      }
    }
    return null;
  }

  private async discoverSingleTraceFile(filePath: string, existingId?: string): Promise<DiscoveredTraceFile | null> {
    if (!filePath.toLowerCase().endsWith(".jsonl")) return null;
    try {
      const fileStat = await stat(filePath);
      const existingEntry = existingId ? this.entries.get(existingId) : undefined;
      if (existingEntry && existingEntry.file.path === filePath) {
        return {
          ...existingEntry.file,
          sizeBytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
          ino: Number(fileStat.ino),
          dev: Number(fileStat.dev),
        };
      }

      const inferred = this.inferSourceMetadata(filePath);
      if (!inferred) return null;
      const id = stableId([filePath, String(fileStat.dev), String(fileStat.ino)]);
      return {
        id,
        path: filePath,
        sourceProfile: inferred.sourceProfile,
        agentHint: inferred.agentHint,
        ...(inferred.parserHint ? { parserHint: inferred.parserHint } : {}),
        sizeBytes: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        ino: Number(fileStat.ino),
        dev: Number(fileStat.dev),
      };
    } catch {
      return null;
    }
  }

  private async upsertFile(file: DiscoveredTraceFile, refreshNowMs: number): Promise<boolean> {
    const current = this.entries.get(file.id);
    const changed = !current || current.file.mtimeMs !== file.mtimeMs || current.file.sizeBytes !== file.sizeBytes;
    if (!changed) {
      if (current) current.file = file;
      return false;
    }

    if (current) {
      const appendApplied = await this.tryIncrementalAppend(current, file, refreshNowMs);
      if (appendApplied) {
        return true;
      }
    }

    this.perf.fullReparseCount += 1;
    try {
      const parsed = await this.parserRegistry.parseFile(file);
      const summary = summarize(
        file,
        parsed.agent,
        parsed.parser,
        parsed.sessionId,
        parsed.events,
        parsed.parseError,
        this.config,
        refreshNowMs,
      );
      const redactedEvents = redactEvents(parsed.events, this.config.redaction);
      const previousCount = current?.summary.eventCount ?? 0;

      this.entries.set(file.id, {
        file,
        summary,
        residentEvents: redactedEvents,
        cachedFullEvents: redactedEvents,
        pinnedMaterializedAtMs: current?.pinnedMaterializedAtMs ?? 0,
      });
      this.cursorById.set(file.id, {
        parsedSizeBytes: file.sizeBytes,
        pendingText: "",
        parserName: parsed.parser,
      });
      const eventType = current ? "trace_updated" : "trace_added";
      this.emitStream(eventType, { summary });

      const appended = Math.max(0, redactedEvents.length - previousCount);
      if (appended > 0) {
        this.emitStream("events_appended", {
          id: file.id,
          appended,
          latestEvents: redactedEvents.slice(-Math.min(40, appended)),
        });
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const summary = summarize(file, file.agentHint, "unknown", "", [], message, this.config, refreshNowMs);
      this.entries.set(file.id, {
        file,
        summary,
        residentEvents: [],
        cachedFullEvents: [],
        pinnedMaterializedAtMs: 0,
      });
      this.cursorById.set(file.id, {
        parsedSizeBytes: file.sizeBytes,
        pendingText: "",
        parserName: current?.summary.parser ?? "unknown",
      });
      this.emitStream(current ? "trace_updated" : "trace_added", { summary });
      return true;
    }
  }

  private async tryIncrementalAppend(current: TraceEntry, file: DiscoveredTraceFile, refreshNowMs: number): Promise<boolean> {
    if (!current.cachedFullEvents || current.summary.parseError) return false;
    if (file.sizeBytes < current.file.sizeBytes) return false;
    const cursor = this.cursorById.get(file.id);
    if (!cursor) return false;
    if (file.sizeBytes <= cursor.parsedSizeBytes) return false;
    if (cursor.parsedSizeBytes < 0 || cursor.parsedSizeBytes > file.sizeBytes) return false;

    const newChunk = await this.readFileChunk(file.path, cursor.parsedSizeBytes, file.sizeBytes - cursor.parsedSizeBytes);
    if (!newChunk) {
      current.file = file;
      this.entries.set(file.id, current);
      return false;
    }

    const combined = cursor.pendingText + newChunk;
    const { completeText, pendingText } = splitCompleteJsonlText(combined);
    if (!completeText.trim()) {
      this.cursorById.set(file.id, {
        parsedSizeBytes: file.sizeBytes,
        pendingText,
        parserName: cursor.parserName,
      });
      current.file = file;
      this.entries.set(file.id, current);
      return false;
    }

    const parsed = this.parserRegistry.parseText(file, completeText, cursor.parserName);
    const redactedNewEvents = redactEvents(parsed.events, this.config.redaction);
    if (redactedNewEvents.length === 0) {
      this.cursorById.set(file.id, {
        parsedSizeBytes: file.sizeBytes,
        pendingText,
        parserName: parsed.parser,
      });
      current.file = file;
      this.entries.set(file.id, current);
      return false;
    }

    const baseIndex = current.summary.eventCount;
    const baseOffset = Math.max(0, cursor.parsedSizeBytes - byteLengthUtf8(cursor.pendingText));
    const rebasedEvents = redactedNewEvents.map((event, idx) => {
      const nextIndex = baseIndex + idx + 1;
      const nextOffset = baseOffset + event.offset;
      return {
        ...event,
        index: nextIndex,
        offset: nextOffset,
        sessionId: event.sessionId || current.summary.sessionId,
        eventId: `${event.traceId}:${nextIndex}:${nextOffset}`,
      };
    });

    const mergedEvents = current.cachedFullEvents.concat(rebasedEvents);
    const mergedSummary = summarize(
      file,
      current.summary.agent,
      current.summary.parser,
      current.summary.sessionId || parsed.sessionId,
      mergedEvents,
      "",
      this.config,
      refreshNowMs,
    );
    const summary: TraceSummary = {
      ...mergedSummary,
      residentTier: current.summary.residentTier,
      isMaterialized: true,
    };

    this.entries.set(file.id, {
      ...current,
      file,
      summary,
      residentEvents: mergedEvents,
      cachedFullEvents: mergedEvents,
      pinnedMaterializedAtMs: current.pinnedMaterializedAtMs,
    });
    this.cursorById.set(file.id, {
      parsedSizeBytes: file.sizeBytes,
      pendingText,
      parserName: parsed.parser,
    });
    this.perf.incrementalAppendCount += 1;

    this.emitStream("trace_updated", { summary });
    this.emitStream("events_appended", {
      id: file.id,
      appended: rebasedEvents.length,
      latestEvents: rebasedEvents.slice(-Math.min(40, rebasedEvents.length)),
    });
    return true;
  }

  private async readFileChunk(filePath: string, offset: number, length: number): Promise<string> {
    if (length <= 0) return "";
    const fileHandle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.max(0, length));
      const { bytesRead } = await fileHandle.read(buffer, 0, buffer.length, offset);
      if (bytesRead <= 0) return "";
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fileHandle.close();
    }
  }

  private applyRetention(nowMsValue: number): void {
    const sortedSummaries = sortSummaries(Array.from(this.entries.values(), (entry) => entry.summary));
    const hotLimit = this.config.retention.hotTraceCount;
    const warmLimit = this.config.retention.warmTraceCount;
    const hotMaxEvents = this.config.retention.maxResidentEventsPerHotTrace;
    const warmMaxEvents = this.config.retention.maxResidentEventsPerWarmTrace;

    for (const [idx, summary] of sortedSummaries.entries()) {
      const entry = this.entries.get(summary.id);
      if (!entry) continue;

      const tier: ResidentTier =
        this.config.retention.strategy === "full_memory"
          ? "hot"
          : idx < hotLimit
            ? "hot"
            : idx < hotLimit + warmLimit
              ? "warm"
              : "cold";
      const maxResidentEvents =
        this.config.retention.strategy === "full_memory" ? Number.MAX_SAFE_INTEGER : tier === "hot" ? hotMaxEvents : tier === "warm" ? warmMaxEvents : 0;
      const sourceEvents = entry.cachedFullEvents ?? entry.residentEvents;
      entry.residentEvents =
        maxResidentEvents === 0
          ? []
          : sourceEvents.slice(-Math.min(sourceEvents.length, Math.max(1, maxResidentEvents)));

      const keepPinned = entry.pinnedMaterializedAtMs > 0 && nowMsValue - entry.pinnedMaterializedAtMs <= MATERIALIZED_TTL_MS;
      if (this.config.retention.strategy !== "full_memory" && tier !== "hot" && !keepPinned) {
        entry.cachedFullEvents = null;
      }
      if (this.config.retention.strategy === "full_memory" && !entry.cachedFullEvents) {
        entry.cachedFullEvents = sourceEvents;
      }

      const isMaterialized =
        (entry.cachedFullEvents?.length ?? 0) >= summary.eventCount || entry.residentEvents.length >= summary.eventCount;
      if (summary.residentTier !== tier || summary.isMaterialized !== isMaterialized) {
        const nextSummary: TraceSummary = {
          ...summary,
          residentTier: tier,
          isMaterialized,
        };
        entry.summary = nextSummary;
        this.emitStream("trace_updated", { summary: nextSummary });
      }
    }
  }

  private refreshActivityStatus(refreshNowMs: number, stats: RefreshStats): void {
    for (const [id, entry] of this.entries) {
      const nextSummary = withAgedActivityStatus(entry.summary, entry.file.mtimeMs, this.config.scan, refreshNowMs);
      if (nextSummary === entry.summary) continue;
      entry.summary = nextSummary;
      this.entries.set(id, entry);
      this.emitStream("trace_updated", { summary: nextSummary });
      stats.hadFileMutations = true;
    }
  }

  private emitStream(type: StreamEnvelope["type"], payload: Record<string, unknown>): void {
    this.streamVersion += 1;
    const envelope: StreamEnvelope = {
      id: String(this.streamVersion),
      type,
      version: this.streamVersion,
      payload,
    };
    this.emit("stream", { envelope } as TraceIndexEvent);
  }

  getSummaries(): TraceSummary[] {
    return sortSummaries(Array.from(this.entries.values(), (entry) => entry.summary));
  }

  getOverview(): OverviewStats {
    const byAgent: Record<string, number> = {};
    const byEventKind = emptyEventKindCounts();

    let traceCount = 0;
    let sessionCount = 0;
    let eventCount = 0;
    let errorCount = 0;
    let toolUseCount = 0;
    let toolResultCount = 0;

    for (const summary of this.getSummaries()) {
      traceCount += 1;
      if (summary.sessionId) sessionCount += 1;
      eventCount += summary.eventCount;
      errorCount += summary.errorCount;
      toolUseCount += summary.toolUseCount;
      toolResultCount += summary.toolResultCount;
      byAgent[summary.agent] = (byAgent[summary.agent] ?? 0) + 1;
      for (const key of EVENT_KIND_KEYS) {
        byEventKind[key] += summary.eventKindCounts[key] ?? 0;
      }
    }

    return {
      traceCount,
      sessionCount,
      eventCount,
      errorCount,
      toolUseCount,
      toolResultCount,
      byAgent,
      byEventKind,
      updatedAtMs: nowMs(),
    };
  }

  private hydrateEventsForEntry(entry: TraceEntry): NormalizedEvent[] {
    if (entry.cachedFullEvents && entry.cachedFullEvents.length >= entry.summary.eventCount) {
      return entry.cachedFullEvents;
    }
    if (entry.residentEvents.length >= entry.summary.eventCount) {
      return entry.residentEvents;
    }

    const parsed = this.parserRegistry.parseFileSync(entry.file, entry.summary.parser);
    const redactedEvents = redactEvents(parsed.events, this.config.redaction);
    const refreshedSummary = summarize(
      entry.file,
      parsed.agent,
      parsed.parser,
      parsed.sessionId,
      parsed.events,
      parsed.parseError,
      this.config,
      nowMs(),
    );
    entry.cachedFullEvents = redactedEvents;
    entry.pinnedMaterializedAtMs = nowMs();
    entry.summary = {
      ...refreshedSummary,
      residentTier: entry.summary.residentTier,
      isMaterialized: true,
    };
    return redactedEvents;
  }

  getSessionDetail(id: string): SessionDetail {
    const found = this.entries.get(id);
    if (!found) {
      throw new Error(`unknown trace id: ${id}`);
    }
    const events = this.hydrateEventsForEntry(found);
    return {
      summary: found.summary,
      events,
    };
  }

  getTracePage(id: string, options: TracePageOptions = {}): TracePage {
    const detail = this.getSessionDetail(id);
    const includeMeta = options.includeMeta ?? this.config.scan.includeMetaDefault;
    const filtered = includeMeta ? detail.events : detail.events.filter((event) => event.eventKind !== "meta");

    const limit = Math.max(1, Math.min(5000, options.limit ?? this.config.scan.recentEventWindow));
    const end = options.before ? Math.max(0, Math.min(filtered.length, Number(options.before))) : filtered.length;
    const start = Math.max(0, end - limit);
    const pageEvents = filtered.slice(start, end);

    return {
      summary: detail.summary,
      events: pageEvents,
      toc: buildToc(pageEvents),
      nextBefore: start > 0 ? String(start) : "",
      liveCursor: String(filtered.length),
    };
  }

  resolveId(candidate: string): string {
    if (this.entries.has(candidate)) {
      return candidate;
    }
    const bySession = this.getSummaries().find((summary) => summary.sessionId === candidate);
    if (bySession) {
      return bySession.id;
    }
    throw new Error(`unknown trace/session: ${candidate}`);
  }
}
