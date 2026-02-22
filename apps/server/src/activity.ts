import type {
  AgentActivityBin,
  AgentActivityDay,
  AgentActivityWeek,
  AgentActivityWeekDay,
  AgentKind,
  EventKind,
  TraceSummary,
} from "@agentlens/contracts";
import type { TraceIndex } from "@agentlens/core";

const AGENT_KIND_KEYS: AgentKind[] = ["claude", "codex", "cursor", "opencode", "gemini", "pi", "unknown"];
const EVENT_KIND_KEYS: EventKind[] = ["system", "assistant", "user", "tool_use", "tool_result", "reasoning", "meta"];
const DEFAULT_BIN_MINUTES = 5;
const DEFAULT_BREAK_MINUTES = 10;
const DEFAULT_DAY_HOUR_START_LOCAL = 7;
const MIN_BIN_MINUTES = 1;
const MAX_BIN_MINUTES = 60;
const MIN_BREAK_MINUTES = 1;
const MAX_BREAK_MINUTES = 180;
const DEFAULT_WEEK_DAY_COUNT = 7;
const MIN_WEEK_DAY_COUNT = 1;
const MAX_WEEK_DAY_COUNT = 14;
const DEFAULT_WEEK_SLOT_MINUTES = 30;
const DEFAULT_WEEK_HOUR_START_LOCAL = 0;
const DEFAULT_WEEK_HOUR_END_LOCAL = 24;
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
}

export interface BuildAgentActivityWeekOptions {
  endDateLocal?: string;
  tzOffsetMinutes?: number;
  dayCount?: number;
  slotMinutes?: number;
  hourStartLocal?: number;
  hourEndLocal?: number;
  nowMs?: number;
}

interface SessionSpan {
  startMs: number;
  endMs: number;
}

interface WindowActivityResult {
  bins: AgentActivityBin[];
  totalSessionsInWindow: number;
  peakConcurrentSessions: number;
  peakConcurrentAtMs: number | null;
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
    meta: 0,
  };
}

function resolveSessionSpan(summary: TraceSummary): SessionSpan {
  const baseStart = summary.firstEventTs ?? summary.lastEventTs ?? summary.mtimeMs;
  const baseEnd = summary.lastEventTs ?? summary.mtimeMs;
  const startMs = Math.min(baseStart, baseEnd);
  const endMs = Math.max(baseStart, baseEnd);
  return { startMs, endMs };
}

function collectTimestampMs(events: ReadonlyArray<{ timestampMs: number | null }>): number[] {
  const timestamps: number[] = [];
  for (const event of events) {
    const timestampMs = event.timestampMs;
    if (timestampMs === null || !Number.isFinite(timestampMs) || timestampMs <= 0) continue;
    timestamps.push(timestampMs);
  }
  timestamps.sort((left, right) => left - right);
  return timestamps;
}

function buildActiveSegmentsFromEventTimestamps(eventTimestamps: number[]): SessionSpan[] {
  if (eventTimestamps.length === 0) return [];
  const segments: SessionSpan[] = [];
  let segmentStartMs = eventTimestamps[0] ?? 0;
  let previousTsMs = segmentStartMs;

  for (let index = 1; index < eventTimestamps.length; index += 1) {
    const nextTsMs = eventTimestamps[index] ?? previousTsMs;
    const gapMs = Math.max(0, nextTsMs - previousTsMs);
    if (gapMs > ACTIVE_IDLE_GAP_MS) {
      segments.push({ startMs: segmentStartMs, endMs: previousTsMs });
      segmentStartMs = nextTsMs;
    }
    previousTsMs = nextTsMs;
  }

  segments.push({ startMs: segmentStartMs, endMs: previousTsMs });
  return segments;
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

function buildWindowActivity(
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
      const eventTimestamps = collectTimestampMs(detail.events);
      const activeSegments = buildActiveSegmentsFromEventTimestamps(eventTimestamps);

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

  const dayStartMs = windowStartMsForDateLocal(dateLocal, tzOffsetMinutes);
  const windowStartMs = dayStartMs + DEFAULT_DAY_HOUR_START_LOCAL * 60 * 60_000;
  const windowEndOfDayMs = windowStartMs + DAY_MS;
  const todayLocal = toLocalDateString(nowMs, tzOffsetMinutes);
  const windowEndMs = dateLocal === todayLocal ? Math.max(windowStartMs, Math.min(windowEndOfDayMs, nowMs)) : windowEndOfDayMs;
  const windowActivity = buildWindowActivity(traceIndex, windowStartMs, windowEndMs, binMinutes, breakMinutes);

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
    const windowActivity = buildWindowActivity(traceIndex, windowStartMs, windowEndMs, slotMinutes, DEFAULT_BREAK_MINUTES);
    days.push({
      dateLocal,
      windowStartMs,
      windowEndMs,
      totalSessionsInWindow: windowActivity.totalSessionsInWindow,
      peakConcurrentSessions: windowActivity.peakConcurrentSessions,
      peakConcurrentAtMs: windowActivity.peakConcurrentAtMs,
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
