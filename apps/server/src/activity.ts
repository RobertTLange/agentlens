import type {
  ActivityUsageSummary,
  ActivityUsageSummaryRow,
  AgentActivityBin,
  AgentActivityDay,
  AgentActivityWeek,
  AgentActivityWeekDay,
  AgentActivityYear,
  AgentActivityYearDay,
  AgentKind,
  EventKind,
  TraceSummary,
} from "@agentlens/contracts";
import type { TraceIndex } from "@agentlens/core";
import type { ActivityResponseCache } from "./activity-cache.js";

const AGENT_KIND_KEYS: AgentKind[] = ["claude", "codex", "cursor", "opencode", "gemini", "pi", "unknown"];
const EVENT_KIND_KEYS: EventKind[] = ["system", "assistant", "user", "tool_use", "tool_result", "reasoning", "compaction", "meta"];
const DEFAULT_BIN_MINUTES = 5;
const DEFAULT_BREAK_MINUTES = 10;
const DEFAULT_DAY_HOUR_START_LOCAL = 7;
const MIN_BIN_MINUTES = 1;
const MAX_BIN_MINUTES = 60;
const MIN_BREAK_MINUTES = 1;
const MAX_BREAK_MINUTES = 180;
const DEFAULT_WEEK_DAY_COUNT = 7;
const MIN_WEEK_DAY_COUNT = 1;
const MAX_WEEK_DAY_COUNT = 366;
const DEFAULT_WEEK_SLOT_MINUTES = 30;
const DEFAULT_WEEK_HOUR_START_LOCAL = 0;
const DEFAULT_WEEK_HOUR_END_LOCAL = 24;
const DEFAULT_YEAR_SLOT_MINUTES = 30;
const DEFAULT_YEAR_HOUR_START_LOCAL = 7;
const MIN_TZ_OFFSET_MINUTES = -14 * 60;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_IDLE_GAP_MS = 20 * 60_000;

export interface BuildAgentActivityDayOptions {
  dateLocal?: string;
  tzOffsetMinutes?: number;
  binMinutes?: number;
  breakMinutes?: number;
  nowMs?: number;
  cache?: ActivityResponseCache;
  cacheVersion?: number;
}

export interface BuildAgentActivityWeekOptions {
  endDateLocal?: string;
  tzOffsetMinutes?: number;
  dayCount?: number;
  slotMinutes?: number;
  hourStartLocal?: number;
  hourEndLocal?: number;
  nowMs?: number;
  cache?: ActivityResponseCache;
  cacheVersion?: number;
}

export interface BuildAgentActivityYearOptions {
  endDateLocal?: string;
  tzOffsetMinutes?: number;
  dayCount?: number;
  nowMs?: number;
  cache?: ActivityResponseCache;
  cacheVersion?: number;
}

interface SessionSpan {
  startMs: number;
  endMs: number;
}

export interface WindowActivityResult {
  bins: AgentActivityBin[];
  totalSessionsInWindow: number;
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
}

interface ActivityUsageAccumulator {
  usageByAgent: Map<AgentKind, ActivityUsageSummaryRow>;
  uniqueSessionIdsByAgent: Map<AgentKind, Set<string>>;
  totalUniqueSessionIds: Set<string>;
  peakAllAgentConcurrency: number;
}

interface YearDayAccumulator {
  dateLocal: string;
  windowStartMs: number;
  windowEndMs: number;
  totalSessionIds: Set<string>;
  totalEventCount: number;
  boundaryEvents: Array<{ atMs: number; delta: number }>;
  agentSlotCounts: Array<Record<AgentKind, number>>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function validateInt(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalDateString(ms: number, tzOffsetMinutes: number): string {
  const local = new Date(ms - tzOffsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = local.getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function parseDateLocal(dateLocal: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal.trim());
  if (!match) throw new Error("invalid date");
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("invalid date");
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error("invalid date");
  }
  const canonical = new Date(Date.UTC(year, month - 1, day));
  if (
    canonical.getUTCFullYear() !== year ||
    canonical.getUTCMonth() !== month - 1 ||
    canonical.getUTCDate() !== day
  ) {
    throw new Error("invalid date");
  }
  return { year, month, day };
}

function windowStartMsForDateLocal(dateLocal: string, tzOffsetMinutes: number): number {
  const { year, month, day } = parseDateLocal(dateLocal);
  return Date.UTC(year, month - 1, day) + tzOffsetMinutes * 60_000;
}

function computeWeekWindowMinutes(hourStartLocal: number, hourEndLocal: number): number {
  if (hourEndLocal === hourStartLocal) {
    return 24 * 60;
  }
  if (hourEndLocal === 24) {
    return (24 - hourStartLocal) * 60;
  }
  if (hourEndLocal > hourStartLocal) {
    return (hourEndLocal - hourStartLocal) * 60;
  }
  if (hourEndLocal < hourStartLocal) {
    return (24 - hourStartLocal + hourEndLocal) * 60;
  }
  return 0;
}

function shiftDateLocal(dateLocal: string, dayOffset: number): string {
  const { year, month, day } = parseDateLocal(dateLocal);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

function createEmptyAgentCounts(): Record<AgentKind, number> {
  return {
    claude: 0,
    codex: 0,
    cursor: 0,
    opencode: 0,
    gemini: 0,
    pi: 0,
    unknown: 0,
  };
}

function createEmptyEventKindCounts(): Record<EventKind, number> {
  return {
    system: 0,
    assistant: 0,
    user: 0,
    tool_use: 0,
    tool_result: 0,
    reasoning: 0,
    compaction: 0,
    meta: 0,
  };
}

function createUsageSummaryRow(agent: AgentKind): ActivityUsageSummaryRow {
  return {
    agent,
    sessionHours: 0,
    sessionSharePct: 0,
    uniqueSessions: 0,
    activeSlots: 0,
    activeDays: 0,
    peakConcurrentSessions: 0,
    inputTokens: 0,
    cacheTokens: 0,
    outputTokens: 0,
  };
}

function createUsageAccumulator(): ActivityUsageAccumulator {
  const usageByAgent = new Map<AgentKind, ActivityUsageSummaryRow>();
  const uniqueSessionIdsByAgent = new Map<AgentKind, Set<string>>();
  for (const agent of AGENT_KIND_KEYS) {
    usageByAgent.set(agent, createUsageSummaryRow(agent));
    uniqueSessionIdsByAgent.set(agent, new Set<string>());
  }
  return {
    usageByAgent,
    uniqueSessionIdsByAgent,
    totalUniqueSessionIds: new Set<string>(),
    peakAllAgentConcurrency: 0,
  };
}

function sanitizeTokenValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function totalEventCountForBins(bins: AgentActivityBin[]): number {
  return bins.reduce((sum, bin) => sum + bin.eventCount, 0);
}

function finalizeUsageSummary(
  accumulator: ActivityUsageAccumulator,
  summaryById: ReadonlyMap<string, TraceSummary>,
): ActivityUsageSummary {
  for (const agent of AGENT_KIND_KEYS) {
    const row = accumulator.usageByAgent.get(agent);
    const sessions = accumulator.uniqueSessionIdsByAgent.get(agent);
    if (!row || !sessions) continue;
    row.uniqueSessions = sessions.size;
    for (const traceId of sessions) {
      const tokenTotals = summaryById.get(traceId)?.tokenTotals;
      row.inputTokens += sanitizeTokenValue(tokenTotals?.inputTokens);
      row.cacheTokens += sanitizeTokenValue(tokenTotals?.cachedReadTokens) + sanitizeTokenValue(tokenTotals?.cachedCreateTokens);
      row.outputTokens += sanitizeTokenValue(tokenTotals?.outputTokens);
    }
  }

  const totalSessionHours = AGENT_KIND_KEYS.reduce((sum, agent) => sum + (accumulator.usageByAgent.get(agent)?.sessionHours ?? 0), 0);
  const rows = AGENT_KIND_KEYS.map((agent) => accumulator.usageByAgent.get(agent) as ActivityUsageSummaryRow)
    .filter((row) => row.sessionHours > 0 || row.uniqueSessions > 0 || row.activeSlots > 0)
    .map((row) => ({
      ...row,
      sessionSharePct: totalSessionHours > 0 ? (row.sessionHours / totalSessionHours) * 100 : 0,
    }))
    .sort(
      (left, right) =>
        right.sessionHours - left.sessionHours || right.uniqueSessions - left.uniqueSessions || left.agent.localeCompare(right.agent),
    );

  return {
    rows,
    totals: {
      totalUniqueSessions: accumulator.totalUniqueSessionIds.size,
      totalSessionHours,
      peakAllAgentConcurrency: accumulator.peakAllAgentConcurrency,
      mostUsedAgent: rows[0]?.agent ?? null,
    },
  };
}

function resolveSessionSpan(summary: TraceSummary): SessionSpan {
  const baseStart = summary.firstEventTs ?? summary.lastEventTs ?? summary.mtimeMs;
  const baseEnd = summary.lastEventTs ?? summary.mtimeMs;
  const startMs = Math.min(baseStart, baseEnd);
  const endMs = Math.max(baseStart, baseEnd);
  return { startMs, endMs };
}

function pickDominantAgent(counts: Record<AgentKind, number>): AgentKind | "none" {
  let dominant: AgentKind | "none" = "none";
  let dominantCount = 0;
  for (const key of AGENT_KIND_KEYS) {
    const count = counts[key] ?? 0;
    if (count > dominantCount) {
      dominant = key;
      dominantCount = count;
    }
  }
  return dominant;
}

function pickDominantEventKind(counts: Record<EventKind, number>): EventKind | "none" {
  let dominant: EventKind | "none" = "none";
  let dominantCount = 0;
  for (const key of EVENT_KIND_KEYS) {
    const count = counts[key] ?? 0;
    if (count > dominantCount) {
      dominant = key;
      dominantCount = count;
    }
  }
  return dominant;
}

function computeBinIndex(windowStartMs: number, binMs: number, binCount: number, targetMs: number): number {
  if (binCount <= 0) return -1;
  const rawIndex = Math.floor((targetMs - windowStartMs) / binMs);
  return clamp(rawIndex, 0, binCount - 1);
}

function applyBreakMarkers(bins: AgentActivityBin[], breakMinutes: number): void {
  const breakThresholdMs = breakMinutes * 60_000;
  let runStart = -1;

  const markRunIfBreak = (start: number, endExclusive: number): void => {
    if (start < 0 || endExclusive <= start) return;
    let runDurationMs = 0;
    for (let idx = start; idx < endExclusive; idx += 1) {
      const bin = bins[idx];
      if (!bin) continue;
      runDurationMs += Math.max(0, bin.endMs - bin.startMs);
    }
    if (runDurationMs < breakThresholdMs) return;
    for (let idx = start; idx < endExclusive; idx += 1) {
      const bin = bins[idx];
      if (!bin) continue;
      bin.isBreak = true;
    }
  };

  for (let idx = 0; idx < bins.length; idx += 1) {
    const bin = bins[idx];
    if (!bin) continue;
    if (bin.activeSessionCount === 0) {
      if (runStart < 0) runStart = idx;
      continue;
    }
    markRunIfBreak(runStart, idx);
    runStart = -1;
  }

  markRunIfBreak(runStart, bins.length);
}

function computeWindowActivity(
  traceIndex: TraceIndex,
  windowStartMs: number,
  windowEndMs: number,
  binMinutes: number,
  breakMinutes: number,
): WindowActivityResult {
  const binMs = binMinutes * 60_000;
  const totalWindowMs = Math.max(0, windowEndMs - windowStartMs);
  const binCount = totalWindowMs <= 0 ? 0 : Math.ceil(totalWindowMs / binMs);

  const bins: AgentActivityBin[] = [];
  for (let index = 0; index < binCount; index += 1) {
    const startMs = windowStartMs + index * binMs;
    const endMs = Math.min(startMs + binMs, windowEndMs);
    bins.push({
      startMs,
      endMs,
      activeSessionCount: 0,
      activeTraceIds: [],
      primaryTraceId: "",
      activeByAgent: createEmptyAgentCounts(),
      eventCount: 0,
      eventKindCounts: createEmptyEventKindCounts(),
      dominantAgent: "none",
      dominantEventKind: "none",
      isBreak: false,
    });
  }

  const summaries = traceIndex.getSummaries();
  const inWindowSummaries: TraceSummary[] = [];
  const summaryById = new Map<string, TraceSummary>();
  const contributingSessionIds = new Set<string>();

  for (const summary of summaries) {
    const span = resolveSessionSpan(summary);
    if (span.endMs < windowStartMs || span.startMs >= windowEndMs) continue;
    inWindowSummaries.push(summary);
    summaryById.set(summary.id, summary);
  }

  if (binCount > 0) {
    for (const summary of inWindowSummaries) {
      const detail = traceIndex.getSessionDetail(summary.id);
      const activityArtifacts = traceIndex.getSessionActivityArtifacts(summary.id);
      const activeSegments: SessionSpan[] = activityArtifacts.activeSegments;

      for (const segment of activeSegments) {
        if (segment.endMs < windowStartMs || segment.startMs >= windowEndMs) continue;
        const clampedStartMs = Math.max(segment.startMs, windowStartMs);
        const clampedEndMs = Math.min(segment.endMs, windowEndMs - 1);
        if (clampedEndMs < clampedStartMs) continue;

        const startIndex = computeBinIndex(windowStartMs, binMs, binCount, clampedStartMs);
        const endIndex = computeBinIndex(windowStartMs, binMs, binCount, clampedEndMs);
        for (let index = startIndex; index <= endIndex; index += 1) {
          const bin = bins[index];
          if (!bin) continue;
          if (!bin.activeTraceIds.includes(summary.id)) {
            bin.activeTraceIds.push(summary.id);
            bin.activeSessionCount += 1;
            bin.activeByAgent[summary.agent] += 1;
            contributingSessionIds.add(summary.id);
          }
        }
      }

      for (const event of detail.events) {
        const timestampMs = event.timestampMs;
        if (timestampMs === null || timestampMs < windowStartMs || timestampMs >= windowEndMs) continue;
        const binIndex = computeBinIndex(windowStartMs, binMs, binCount, timestampMs);
        const bin = bins[binIndex];
        if (!bin) continue;
        bin.eventCount += 1;
        bin.eventKindCounts[event.eventKind] += 1;
      }
    }
  }

  let peakConcurrentSessions = 0;
  let peakConcurrentAtMs: number | null = null;
  for (const bin of bins) {
    if (bin.activeTraceIds.length > 0) {
      bin.activeTraceIds.sort((leftId, rightId) => {
        const left = summaryById.get(leftId);
        const right = summaryById.get(rightId);
        const leftUpdatedMs = Math.max(left?.lastEventTs ?? 0, left?.mtimeMs ?? 0);
        const rightUpdatedMs = Math.max(right?.lastEventTs ?? 0, right?.mtimeMs ?? 0);
        return rightUpdatedMs - leftUpdatedMs || leftId.localeCompare(rightId);
      });
      bin.primaryTraceId = bin.activeTraceIds[0] ?? "";
    }
    bin.dominantAgent = pickDominantAgent(bin.activeByAgent);
    bin.dominantEventKind = pickDominantEventKind(bin.eventKindCounts);
    if (bin.activeSessionCount > peakConcurrentSessions) {
      peakConcurrentSessions = bin.activeSessionCount;
      peakConcurrentAtMs = bin.startMs;
    }
  }

  applyBreakMarkers(bins, breakMinutes);

  return {
    bins,
    totalSessionsInWindow: contributingSessionIds.size,
    peakConcurrentSessions,
    peakConcurrentAtMs,
  };
}

function buildWindowActivity(
  traceIndex: TraceIndex,
  windowStartMs: number,
  windowEndMs: number,
  binMinutes: number,
  breakMinutes: number,
  options: {
    cache?: ActivityResponseCache;
    cacheVersion?: number;
    nowMs: number;
  },
): WindowActivityResult {
  if (!options.cache || options.cacheVersion === undefined) {
    return computeWindowActivity(traceIndex, windowStartMs, windowEndMs, binMinutes, breakMinutes);
  }
  return options.cache.getOrBuildWindow(
    options.cacheVersion,
    options.nowMs,
    {
      windowStartMs,
      windowEndMs,
      binMinutes,
      breakMinutes,
    },
    () => computeWindowActivity(traceIndex, windowStartMs, windowEndMs, binMinutes, breakMinutes),
  );
}

export function buildAgentActivityDay(
  traceIndex: TraceIndex,
  options: BuildAgentActivityDayOptions = {},
): AgentActivityDay {
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const requestedTzOffset = validateInt(options.tzOffsetMinutes, "tz_offset_min");
  const tzOffsetMinutes = clamp(
    requestedTzOffset ?? new Date(nowMs).getTimezoneOffset(),
    MIN_TZ_OFFSET_MINUTES,
    MAX_TZ_OFFSET_MINUTES,
  );
  const requestedDateLocal = options.dateLocal?.trim() ?? "";
  const dateLocal = requestedDateLocal || toLocalDateString(nowMs, tzOffsetMinutes);
  parseDateLocal(dateLocal);

  const requestedBinMinutes = validateInt(options.binMinutes, "bin_min");
  const requestedBreakMinutes = validateInt(options.breakMinutes, "break_min");
  const binMinutes = clamp(requestedBinMinutes ?? DEFAULT_BIN_MINUTES, MIN_BIN_MINUTES, MAX_BIN_MINUTES);
  const breakMinutes = clamp(requestedBreakMinutes ?? DEFAULT_BREAK_MINUTES, MIN_BREAK_MINUTES, MAX_BREAK_MINUTES);

  if (options.cache && options.cacheVersion !== undefined) {
    const { cache: _cache, cacheVersion: _cacheVersion, ...uncachedOptions } = options;
    return options.cache.getOrBuildDay(
      options.cacheVersion,
      nowMs,
      {
        dateLocal,
        tzOffsetMinutes,
        binMinutes,
        breakMinutes,
      },
      () =>
        buildAgentActivityDay(traceIndex, {
          ...uncachedOptions,
          nowMs,
          dateLocal,
          tzOffsetMinutes,
          binMinutes,
          breakMinutes,
        }),
    );
  }

  const dayStartMs = windowStartMsForDateLocal(dateLocal, tzOffsetMinutes);
  const windowStartMs = dayStartMs + DEFAULT_DAY_HOUR_START_LOCAL * 60 * 60_000;
  const windowEndOfDayMs = windowStartMs + DAY_MS;
  const todayLocal = toLocalDateString(nowMs, tzOffsetMinutes);
  const windowEndMs = dateLocal === todayLocal ? Math.max(windowStartMs, Math.min(windowEndOfDayMs, nowMs)) : windowEndOfDayMs;
  const windowActivity = buildWindowActivity(
    traceIndex,
    windowStartMs,
    windowEndMs,
    binMinutes,
    breakMinutes,
    options.cache && options.cacheVersion !== undefined
      ? { cache: options.cache, cacheVersion: options.cacheVersion, nowMs }
      : { nowMs },
  );

  return {
    dateLocal,
    tzOffsetMinutes,
    binMinutes,
    breakMinutes,
    windowStartMs,
    windowEndMs,
    totalSessionsInWindow: windowActivity.totalSessionsInWindow,
    peakConcurrentSessions: windowActivity.peakConcurrentSessions,
    peakConcurrentAtMs: windowActivity.peakConcurrentAtMs,
    totalEventCount: totalEventCountForBins(windowActivity.bins),
    bins: windowActivity.bins,
  };
}

export function buildAgentActivityWeek(
  traceIndex: TraceIndex,
  options: BuildAgentActivityWeekOptions = {},
): AgentActivityWeek {
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const requestedTzOffset = validateInt(options.tzOffsetMinutes, "tz_offset_min");
  const tzOffsetMinutes = clamp(
    requestedTzOffset ?? new Date(nowMs).getTimezoneOffset(),
    MIN_TZ_OFFSET_MINUTES,
    MAX_TZ_OFFSET_MINUTES,
  );

  const requestedEndDateLocal = options.endDateLocal?.trim() ?? "";
  const endDateLocal = requestedEndDateLocal || toLocalDateString(nowMs, tzOffsetMinutes);
  parseDateLocal(endDateLocal);

  const requestedDayCount = validateInt(options.dayCount, "day_count");
  const dayCount = clamp(requestedDayCount ?? DEFAULT_WEEK_DAY_COUNT, MIN_WEEK_DAY_COUNT, MAX_WEEK_DAY_COUNT);
  const startDateLocal = shiftDateLocal(endDateLocal, -(dayCount - 1));

  const requestedSlotMinutes = validateInt(options.slotMinutes, "slot_min");
  const slotMinutes = clamp(requestedSlotMinutes ?? DEFAULT_WEEK_SLOT_MINUTES, MIN_BIN_MINUTES, MAX_BIN_MINUTES);

  const requestedHourStart = validateInt(options.hourStartLocal, "hour_start");
  const requestedHourEnd = validateInt(options.hourEndLocal, "hour_end");
  const hourStartLocal = clamp(requestedHourStart ?? DEFAULT_WEEK_HOUR_START_LOCAL, 0, 23);
  const hourEndLocal = clamp(requestedHourEnd ?? DEFAULT_WEEK_HOUR_END_LOCAL, 0, 24);
  const windowMinutes = computeWeekWindowMinutes(hourStartLocal, hourEndLocal);
  if (windowMinutes <= 0) {
    throw new Error("invalid hour window");
  }
  if (slotMinutes > windowMinutes) {
    throw new Error("slot_min too large for hour window");
  }

  if (options.cache && options.cacheVersion !== undefined) {
    const { cache: _cache, cacheVersion: _cacheVersion, ...uncachedOptions } = options;
    return options.cache.getOrBuildWeek(
      options.cacheVersion,
      nowMs,
      {
        endDateLocal,
        tzOffsetMinutes,
        dayCount,
        slotMinutes,
        hourStartLocal,
        hourEndLocal,
      },
      () =>
        buildAgentActivityWeek(traceIndex, {
          ...uncachedOptions,
          nowMs,
          endDateLocal,
          tzOffsetMinutes,
          dayCount,
          slotMinutes,
          hourStartLocal,
          hourEndLocal,
        }),
    );
  }

  const windowDurationMs = windowMinutes * 60_000;
  const days: AgentActivityWeekDay[] = [];
  const todayLocal = toLocalDateString(nowMs, tzOffsetMinutes);

  for (let offset = 0; offset < dayCount; offset += 1) {
    const dateLocal = shiftDateLocal(startDateLocal, offset);
    const dayStartMs = windowStartMsForDateLocal(dateLocal, tzOffsetMinutes);
    const windowStartMs = dayStartMs + hourStartLocal * 60 * 60_000;
    const nominalWindowEndMs = windowStartMs + windowDurationMs;
    const windowEndMs =
      dateLocal === todayLocal
        ? Math.max(windowStartMs, Math.min(nominalWindowEndMs, nowMs))
        : nominalWindowEndMs;
    const windowActivity = buildWindowActivity(
      traceIndex,
      windowStartMs,
      windowEndMs,
      slotMinutes,
      DEFAULT_BREAK_MINUTES,
      options.cache && options.cacheVersion !== undefined
        ? { cache: options.cache, cacheVersion: options.cacheVersion, nowMs }
        : { nowMs },
    );
    days.push({
      dateLocal,
      windowStartMs,
      windowEndMs,
      totalSessionsInWindow: windowActivity.totalSessionsInWindow,
      peakConcurrentSessions: windowActivity.peakConcurrentSessions,
      peakConcurrentAtMs: windowActivity.peakConcurrentAtMs,
      totalEventCount: totalEventCountForBins(windowActivity.bins),
      bins: windowActivity.bins,
    });
  }

  return {
    tzOffsetMinutes,
    dayCount,
    slotMinutes,
    hourStartLocal,
    hourEndLocal,
    startDateLocal,
    endDateLocal,
    days,
  };
}

export function buildAgentActivityYear(
  traceIndex: TraceIndex,
  options: BuildAgentActivityYearOptions = {},
): AgentActivityYear {
  const nowMs = typeof options.nowMs === "number" && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const requestedTzOffset = validateInt(options.tzOffsetMinutes, "tz_offset_min");
  const tzOffsetMinutes = clamp(
    requestedTzOffset ?? new Date(nowMs).getTimezoneOffset(),
    MIN_TZ_OFFSET_MINUTES,
    MAX_TZ_OFFSET_MINUTES,
  );

  const requestedEndDateLocal = options.endDateLocal?.trim() ?? "";
  const endDateLocal = requestedEndDateLocal || toLocalDateString(nowMs, tzOffsetMinutes);
  parseDateLocal(endDateLocal);

  const requestedDayCount = validateInt(options.dayCount, "day_count");
  const maxDayCount = clamp(requestedDayCount ?? MAX_WEEK_DAY_COUNT, MIN_WEEK_DAY_COUNT, MAX_WEEK_DAY_COUNT);
  const yearStartDateLocal = `${endDateLocal.slice(0, 4)}-01-01`;
  const todayLocal = toLocalDateString(nowMs, tzOffsetMinutes);
  const nominalRangeDayCount = Math.floor((windowStartMsForDateLocal(endDateLocal, 0) - windowStartMsForDateLocal(yearStartDateLocal, 0)) / DAY_MS) + 1;
  const dayCount = clamp(nominalRangeDayCount, MIN_WEEK_DAY_COUNT, Math.min(MAX_WEEK_DAY_COUNT, maxDayCount));
  const provisionalStartDateLocal = shiftDateLocal(endDateLocal, -(dayCount - 1));
  const summaryById = new Map(traceIndex.getSummaries().map((summary) => [summary.id, summary]));

  let earliestActiveDateLocal: string | null = null;
  for (const summary of summaryById.values()) {
    const activeAtMs = Math.max(summary.firstEventTs ?? 0, 1);
    if (activeAtMs <= 0) continue;
    const activeDateLocal = toLocalDateString(activeAtMs, tzOffsetMinutes);
    if (activeDateLocal < provisionalStartDateLocal || activeDateLocal > endDateLocal) continue;
    if (earliestActiveDateLocal === null || activeDateLocal < earliestActiveDateLocal) {
      earliestActiveDateLocal = activeDateLocal;
    }
  }

  const startDateLocal = earliestActiveDateLocal ?? provisionalStartDateLocal;
  const effectiveDayCount =
    Math.floor((windowStartMsForDateLocal(endDateLocal, 0) - windowStartMsForDateLocal(startDateLocal, 0)) / DAY_MS) + 1;

  if (options.cache && options.cacheVersion !== undefined) {
    const { cache: _cache, cacheVersion: _cacheVersion, ...uncachedOptions } = options;
    return options.cache.getOrBuildYear(
      options.cacheVersion,
      nowMs,
      {
        endDateLocal,
        tzOffsetMinutes,
        dayCount: effectiveDayCount,
      },
      () =>
        buildAgentActivityYear(traceIndex, {
          ...uncachedOptions,
          nowMs,
          endDateLocal,
          tzOffsetMinutes,
          dayCount: effectiveDayCount,
        }),
    );
  }

  const windowDurationMs = computeWeekWindowMinutes(DEFAULT_YEAR_HOUR_START_LOCAL, DEFAULT_YEAR_HOUR_START_LOCAL) * 60_000;
  const slotMs = DEFAULT_YEAR_SLOT_MINUTES * 60_000;
  const slotCount = Math.max(1, Math.ceil(windowDurationMs / slotMs));
  const dayStates: YearDayAccumulator[] = [];

  for (let offset = 0; offset < effectiveDayCount; offset += 1) {
    const dateLocal = shiftDateLocal(startDateLocal, offset);
    const dayStartMs = windowStartMsForDateLocal(dateLocal, tzOffsetMinutes);
    const windowStartMs = dayStartMs + DEFAULT_YEAR_HOUR_START_LOCAL * 60 * 60_000;
    const nominalWindowEndMs = windowStartMs + windowDurationMs;
    const windowEndMs =
      dateLocal === todayLocal ? Math.max(windowStartMs, Math.min(nominalWindowEndMs, nowMs)) : nominalWindowEndMs;
    dayStates.push({
      dateLocal,
      windowStartMs,
      windowEndMs,
      totalSessionIds: new Set<string>(),
      totalEventCount: 0,
      boundaryEvents: [],
      agentSlotCounts: Array.from({ length: slotCount }, () => createEmptyAgentCounts()),
    });
  }

  const overallStartMs = dayStates[0]?.windowStartMs ?? 0;
  const overallEndMs = dayStates[dayStates.length - 1]?.windowEndMs ?? overallStartMs;
  const usageAccumulator = createUsageAccumulator();

  for (const summary of summaryById.values()) {
    const span = resolveSessionSpan(summary);
    if (span.endMs < overallStartMs || span.startMs >= overallEndMs) continue;

    const activityArtifacts = traceIndex.getSessionActivityArtifacts(summary.id);
    let summaryContributed = false;

    for (const timestampMs of activityArtifacts.eventTimestamps) {
      if (timestampMs < overallStartMs || timestampMs >= overallEndMs) continue;
      const dayIndex = Math.floor((timestampMs - overallStartMs) / DAY_MS);
      const dayState = dayStates[dayIndex];
      if (!dayState) continue;
      if (timestampMs >= dayState.windowEndMs) continue;
      dayState.totalEventCount += 1;
    }

    for (const segment of activityArtifacts.activeSegments) {
      if (segment.endMs < overallStartMs || segment.startMs >= overallEndMs) continue;
      const clampedStartMs = Math.max(segment.startMs, overallStartMs);
      const clampedEndExclusiveMs = Math.min(segment.endMs + 1, overallEndMs);
      if (clampedEndExclusiveMs <= clampedStartMs) continue;
      summaryContributed = true;

      const startDayIndex = Math.max(0, Math.floor((clampedStartMs - overallStartMs) / DAY_MS));
      const endDayIndex = Math.max(0, Math.floor((clampedEndExclusiveMs - 1 - overallStartMs) / DAY_MS));
      for (let dayIndex = startDayIndex; dayIndex <= endDayIndex; dayIndex += 1) {
        const dayState = dayStates[dayIndex];
        if (!dayState) continue;
        const overlapStartMs = Math.max(clampedStartMs, dayState.windowStartMs);
        const overlapEndExclusiveMs = Math.min(clampedEndExclusiveMs, dayState.windowEndMs);
        if (overlapEndExclusiveMs <= overlapStartMs) continue;

        dayState.totalSessionIds.add(summary.id);
        dayState.boundaryEvents.push({ atMs: overlapStartMs, delta: 1 });
        dayState.boundaryEvents.push({ atMs: overlapEndExclusiveMs, delta: -1 });

        const startSlotIndex = computeBinIndex(dayState.windowStartMs, slotMs, slotCount, overlapStartMs);
        const endSlotIndex = computeBinIndex(
          dayState.windowStartMs,
          slotMs,
          slotCount,
          Math.max(overlapStartMs, overlapEndExclusiveMs - 1),
        );
        for (let slotIndex = startSlotIndex; slotIndex <= endSlotIndex; slotIndex += 1) {
          dayState.agentSlotCounts[slotIndex]![summary.agent] += 1;
        }
      }
    }

    if (!summaryContributed) continue;
    usageAccumulator.totalUniqueSessionIds.add(summary.id);
    usageAccumulator.uniqueSessionIdsByAgent.get(summary.agent)?.add(summary.id);
  }

  const days: AgentActivityYearDay[] = dayStates.map((dayState) => {
    let peakConcurrentSessions = 0;
    let peakConcurrentAtMs: number | null = null;
    let concurrentSessions = 0;
    const sortedBoundaryEvents = [...dayState.boundaryEvents].sort(
      (left, right) => left.atMs - right.atMs || left.delta - right.delta,
    );
    for (const boundaryEvent of sortedBoundaryEvents) {
      concurrentSessions += boundaryEvent.delta;
      if (concurrentSessions > peakConcurrentSessions) {
        peakConcurrentSessions = concurrentSessions;
        peakConcurrentAtMs = boundaryEvent.atMs;
      }
    }
    usageAccumulator.peakAllAgentConcurrency = Math.max(usageAccumulator.peakAllAgentConcurrency, peakConcurrentSessions);

    for (const agent of AGENT_KIND_KEYS) {
      const row = usageAccumulator.usageByAgent.get(agent);
      if (!row) continue;
      let activeToday = false;
      for (const slotCounts of dayState.agentSlotCounts) {
        const concurrentAgentSessions = slotCounts[agent] ?? 0;
        if (concurrentAgentSessions <= 0) continue;
        activeToday = true;
        row.sessionHours += concurrentAgentSessions * (slotMs / 3_600_000);
        row.activeSlots += 1;
        row.peakConcurrentSessions = Math.max(row.peakConcurrentSessions, concurrentAgentSessions);
      }
      if (activeToday) {
        row.activeDays += 1;
      }
    }

    return {
      dateLocal: dayState.dateLocal,
      windowStartMs: dayState.windowStartMs,
      windowEndMs: dayState.windowEndMs,
      totalSessionsInWindow: dayState.totalSessionIds.size,
      peakConcurrentSessions,
      peakConcurrentAtMs,
      totalEventCount: dayState.totalEventCount,
    };
  });

  return {
    tzOffsetMinutes,
    dayCount: effectiveDayCount,
    startDateLocal,
    endDateLocal,
    days,
    usageSummary: finalizeUsageSummary(usageAccumulator, summaryById),
  };
}
