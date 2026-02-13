import { EventEmitter } from "node:events";
import type {
  ActivityBinsMode,
  AppConfig,
  EventKind,
  NormalizedEvent,
  OverviewStats,
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
import { asRecord, asString, nowMs } from "./utils.js";

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

interface TraceEntry {
  file: DiscoveredTraceFile;
  detail: SessionDetail;
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
): ActivityStatus {
  if (activity.status === "idle") return activity;
  if (updatedMs <= 0) return { status: "idle", reason: "stale_timeout" };

  const ageMs = Math.max(0, nowMsValue - updatedMs);
  const ttlMs =
    activity.status === "running"
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

export class TraceIndex extends EventEmitter {
  private readonly parserRegistry = new ParserRegistry();
  private config: AppConfig;
  private entries = new Map<string, TraceEntry>();
  private timer: NodeJS.Timeout | null = null;
  private streamVersion = 0;

  constructor(config: AppConfig) {
    super();
    this.config = config;
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
  }

  async start(): Promise<void> {
    await this.refresh();
    const intervalMs = Math.max(500, Math.round(this.config.scan.intervalSeconds * 1000));
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    const refreshNowMs = nowMs();
    const files = await discoverTraceFiles(this.config);
    const nextIds = new Set(files.map((file) => file.id));

    for (const existingId of this.entries.keys()) {
      if (!nextIds.has(existingId)) {
        this.entries.delete(existingId);
        this.emitStream("trace_removed", { id: existingId });
      }
    }

    for (const file of files) {
      const current = this.entries.get(file.id);
      const changed = !current || current.file.mtimeMs !== file.mtimeMs || current.file.sizeBytes !== file.sizeBytes;
      if (!changed) continue;

      try {
        const parsed = await this.parserRegistry.parseFile(file);
        const parsedEvents = parsed.events;
        const summary = summarize(
          file,
          parsed.agent,
          parsed.parser,
          parsed.sessionId,
          parsedEvents,
          parsed.parseError,
          this.config,
          refreshNowMs,
        );
        const redactedEvents = redactEvents(parsedEvents, this.config.redaction);
        const detail: SessionDetail = { summary, events: redactedEvents };

        const previousCount = current?.detail.events.length ?? 0;
        this.entries.set(file.id, { file, detail });
        const eventType = current ? "trace_updated" : "trace_added";
        this.emitStream(eventType, { summary });

        const appended = Math.max(0, parsed.events.length - previousCount);
        if (appended > 0) {
          this.emitStream("events_appended", {
            id: file.id,
            appended,
            latestEvents: redactedEvents.slice(-Math.min(40, appended)),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const summary = summarize(file, file.agentHint, "unknown", "", [], message, this.config, refreshNowMs);
        this.entries.set(file.id, { file, detail: { summary, events: [] } });
        this.emitStream(current ? "trace_updated" : "trace_added", { summary });
      }
    }

    for (const [id, entry] of this.entries) {
      const nextSummary = withDerivedActivityStatus(
        entry.detail.summary,
        entry.detail.events,
        entry.file.mtimeMs,
        this.config.scan,
        refreshNowMs,
      );
      if (nextSummary === entry.detail.summary) continue;

      const detail: SessionDetail = {
        ...entry.detail,
        summary: nextSummary,
      };
      this.entries.set(id, {
        ...entry,
        detail,
      });
      this.emitStream("trace_updated", { summary: nextSummary });
    }

    this.emitStream("overview_updated", { overview: this.getOverview() });
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
    return sortSummaries(Array.from(this.entries.values(), (entry) => entry.detail.summary));
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

  getSessionDetail(id: string): SessionDetail {
    const found = this.entries.get(id);
    if (!found) {
      throw new Error(`unknown trace id: ${id}`);
    }
    return found.detail;
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
