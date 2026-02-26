import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type { AgentActivityDay, AgentActivityWeek, AgentKind } from "@agentlens/contracts";
import { buildActivityViewModel, type ActivityTimelineRowModel } from "./activity-view-model.js";
import {
  buildActivityWeekHeatmapModel,
  buildWeeklyUsageSummary,
  type WeeklyUsageSummaryModel,
  type TraceTokenTotalsSnapshot,
} from "./activity-week-heatmap-model.js";
import { buildActivityYearHeatmapModel } from "./activity-year-heatmap-model.js";
import { formatCompactNumber, formatPercent, iconForAgent } from "./view-model.js";

const API = "";
const DAY_MINUTES = 24 * 60;
const TARGET_BIN_PX = 6;
const MIN_BIN_MINUTES = 5;
const MAX_BIN_MINUTES = 60;
const BREAK_MINUTES = 10;
const REFRESH_INTERVAL_MS = 30_000;
const WEEK_DAY_COUNT = 7;
const WEEK_SLOT_MINUTES = 30;
const WEEK_HOUR_START_LOCAL = 7;
const WEEK_HOUR_END_LOCAL = 7;
const DAY_MS = 86_400_000;
const YEAR_SLOT_MINUTES = 30;
const YEAR_HOUR_START_LOCAL = 7;
const YEAR_HOUR_END_LOCAL = 7;
const IDLE_COMPRESSION_THRESHOLD_MINUTES = 4 * 60;
const IDLE_COMPRESSED_BIN_FR = 0.08;
const IDLE_COMPRESSED_EDGE_BIN_FR = 0.28;
const EVENT_PASTEL_BY_FILL_CLASS: Readonly<Record<string, string>> = {
  "kind-system": "var(--event-system-bg)",
  "kind-assistant": "var(--event-assistant-bg)",
  "kind-user": "var(--event-user-bg)",
  "kind-tool_use": "var(--event-tool-use-bg)",
  "kind-tool_result": "var(--event-tool-result-bg)",
  "kind-reasoning": "var(--event-reasoning-bg)",
  "kind-meta": "var(--event-meta-bg)",
  "kind-none": "#f8fafc",
};
const DEFAULT_EVENT_PASTEL = "#f8fafc";
const AGENT_LEGEND_ITEMS: Array<{ label: string; className: string }> = [
  { label: "codex", className: "agent-border-codex" },
  { label: "claude", className: "agent-border-claude" },
  { label: "cursor", className: "agent-border-cursor" },
  { label: "opencode", className: "agent-border-opencode" },
  { label: "gemini", className: "agent-border-gemini" },
  { label: "pi", className: "agent-border-pi" },
  { label: "unknown", className: "agent-border-unknown" },
];
const AGENT_TOOLTIP_ORDER: AgentKind[] = ["codex", "claude", "cursor", "opencode", "gemini", "pi", "unknown"];

interface ActivityDayResponse {
  activity: AgentActivityDay;
}

interface ActivityWeekResponse {
  activity: AgentActivityWeek;
}

interface ActivityViewProps {
  onInspectTrace?: (traceId: string) => void;
  traceAgentById?: Readonly<Record<string, AgentKind>>;
  traceTokenTotalsById?: Readonly<Record<string, TraceTokenTotalsSnapshot | undefined>>;
}

function formatLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayLocalDateString(now: Date = new Date()): string {
  return formatLocalDateString(now);
}

function defaultSelectedActivityDateLocal(now: Date = new Date()): string {
  if (now.getHours() >= WEEK_HOUR_START_LOCAL) return formatLocalDateString(now);
  const previousDay = new Date(now);
  previousDay.setDate(previousDay.getDate() - 1);
  return formatLocalDateString(previousDay);
}

function dateLocalToUtcMs(dateLocal: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal);
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return Date.UTC(year, month - 1, day);
}

function isOlderThanCurrentWeekWindow(dateLocal: string): boolean {
  const todayMs = dateLocalToUtcMs(todayLocalDateString());
  const targetMs = dateLocalToUtcMs(dateLocal);
  if (todayMs === null || targetMs === null) return false;
  const currentWeekStartMs = todayMs - (WEEK_DAY_COUNT - 1) * DAY_MS;
  return targetMs < currentWeekStartMs;
}

function formatTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function deriveBinMinutesForViewport(viewportWidth: number): number {
  const width = Math.max(320, Math.floor(viewportWidth));
  const targetBinCount = Math.max(48, Math.floor(width / TARGET_BIN_PX));
  const derived = Math.ceil(DAY_MINUTES / targetBinCount);
  return Math.max(MIN_BIN_MINUTES, Math.min(MAX_BIN_MINUTES, derived));
}

function buildWeekCellTooltip(
  day: { dayLabel: string; dateLocal: string; totalSessionsInWindow: number },
  cell: { timeLabel: string; activeSessionCount: number; activeByAgent: Record<AgentKind, number>; eventCount: number; level: number },
): string {
  const activeAgentSummary = AGENT_TOOLTIP_ORDER.flatMap((agent) => {
    const count = cell.activeByAgent[agent] ?? 0;
    if (count <= 0) return [];
    return [`${agent} ${count}`];
  }).join(", ");
  return [
    `${day.dayLabel} (${day.dateLocal})`,
    `${cell.timeLabel}`,
    `sessions ${cell.activeSessionCount}`,
    `sessions by agent ${activeAgentSummary || "none"}`,
    `events ${cell.eventCount}`,
    `day sessions ${day.totalSessionsInWindow}`,
    `intensity ${cell.level}/4`,
  ].join(" · ");
}

function formatHours(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}h`;
}

function yearDayCountForDateLocal(dateLocal: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal);
  if (!match) return 365;
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return 365;
  const date = Date.UTC(year, month - 1, day);
  const yearStart = Date.UTC(year, 0, 1);
  const dayOfYear = Math.floor((date - yearStart) / 86_400_000) + 1;
  return Math.max(1, Math.min(366, dayOfYear));
}

function buildYearCellTooltip(cell: {
  dayLabel: string;
  dateLocal: string;
  totalSessionsInWindow: number;
  totalEventCount: number;
  peakConcurrentSessions: number;
  level: number;
}): string {
  return [
    `${cell.dayLabel} (${cell.dateLocal})`,
    `sessions ${cell.totalSessionsInWindow}`,
    `events ${cell.totalEventCount}`,
    `peak conc. ${cell.peakConcurrentSessions}`,
    `intensity ${cell.level}/4`,
  ].join(" · ");
}

interface UsageSummarySectionProps {
  periodKey: "day" | "week" | "year";
  title: string;
  meta: string;
  emptyLabel: string;
  summary: WeeklyUsageSummaryModel;
  className?: string;
}

function UsageSummarySection({
  periodKey,
  title,
  meta,
  emptyLabel,
  summary,
  className,
}: UsageSummarySectionProps): JSX.Element {
  const ariaPeriodLabel = periodKey === "day" ? "daily" : periodKey === "week" ? "weekly" : "yearly";
  return (
    <section
      className={`activity-week-summary activity-${periodKey}-summary ${className ?? ""}`.trim()}
      aria-label={`${ariaPeriodLabel} usage summary`}
    >
      <div className={`activity-week-summary-head activity-${periodKey}-summary-head`}>
        <div className="activity-week-summary-head-main">
          <div className={`mono activity-week-summary-title activity-${periodKey}-summary-title`}>{title}</div>
          <div className={`mono activity-week-summary-meta activity-${periodKey}-summary-meta`}>{meta}</div>
        </div>
      </div>
      <div className={`activity-week-summary-cards activity-${periodKey}-summary-cards`}>
        <article className={`activity-week-summary-card activity-${periodKey}-summary-card`}>
          <div className={`mono activity-week-summary-label activity-${periodKey}-summary-label`}>total unique sessions</div>
          <div className={`mono activity-week-summary-value activity-${periodKey}-summary-value`}>
            {formatCompactNumber(summary.totals.totalUniqueSessions)}
          </div>
        </article>
        <article className={`activity-week-summary-card activity-${periodKey}-summary-card`}>
          <div className={`mono activity-week-summary-label activity-${periodKey}-summary-label`}>total session-hours</div>
          <div className={`mono activity-week-summary-value activity-${periodKey}-summary-value`}>
            {formatHours(summary.totals.totalSessionHours)}
          </div>
        </article>
        <article className={`activity-week-summary-card activity-${periodKey}-summary-card`}>
          <div className={`mono activity-week-summary-label activity-${periodKey}-summary-label`}>peak concurrency</div>
          <div className={`mono activity-week-summary-value activity-${periodKey}-summary-value`}>
            {formatCompactNumber(summary.totals.peakAllAgentConcurrency)}
          </div>
        </article>
        <article className={`activity-week-summary-card activity-${periodKey}-summary-card`}>
          <div className={`mono activity-week-summary-label activity-${periodKey}-summary-label`}>most used agent</div>
          <div className={`mono activity-week-summary-value activity-${periodKey}-summary-value`}>
            {summary.totals.mostUsedAgent ?? "-"}
          </div>
        </article>
      </div>
      {summary.rows.length > 0 ? (
        <div className={`activity-week-summary-table-wrap activity-${periodKey}-summary-table-wrap`}>
          <table className={`activity-week-summary-table activity-${periodKey}-summary-table mono`}>
            <thead>
              <tr>
                <th scope="col">agent</th>
                <th scope="col">session-hours</th>
                <th scope="col">share</th>
                <th scope="col">unique sessions</th>
                <th scope="col">in tokens</th>
                <th scope="col">cache tokens</th>
                <th scope="col">out tokens</th>
                <th scope="col">active slots</th>
                <th scope="col">active days</th>
                <th scope="col">peak conc.</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => {
                const iconPath = iconForAgent(row.agent);
                return (
                  <tr key={row.agent}>
                    <td>
                      <span className="activity-week-summary-agent">
                        {iconPath ? (
                          <span className="activity-week-summary-agent-icon-wrap" aria-hidden="true">
                            <img src={iconPath} alt="" className="activity-week-summary-agent-icon" loading="lazy" />
                          </span>
                        ) : (
                          <span className="activity-week-summary-agent-fallback" aria-hidden="true">
                            {row.agent.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span>{row.agent}</span>
                      </span>
                    </td>
                    <td>{formatHours(row.sessionHours)}</td>
                    <td>{formatPercent(row.sessionSharePct, 1)}</td>
                    <td>{formatCompactNumber(row.uniqueSessions)}</td>
                    <td>{formatCompactNumber(row.inputTokens)}</td>
                    <td>{formatCompactNumber(row.cacheTokens)}</td>
                    <td>{formatCompactNumber(row.outputTokens)}</td>
                    <td>{formatCompactNumber(row.activeSlots)}</td>
                    <td>{formatCompactNumber(row.activeDays)}</td>
                    <td>{formatCompactNumber(row.peakConcurrentSessions)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={`activity-week-summary-empty activity-${periodKey}-summary-empty mono`}>{emptyLabel}</div>
      )}
    </section>
  );
}

interface SessionSegment {
  traceId: string;
  laneIndex: number;
  startIndex: number;
  endIndex: number;
  firstLabel: string;
  lastLabel: string;
  agent: AgentKind;
  eventBackground: string;
}

interface TimelineCompressionResult {
  columnTemplate: string;
  hasCompressedIdleGap: boolean;
}

function eventPastelForRow(row: ActivityTimelineRowModel | undefined): string {
  if (!row) return EVENT_PASTEL_BY_FILL_CLASS["kind-none"] ?? DEFAULT_EVENT_PASTEL;
  return EVENT_PASTEL_BY_FILL_CLASS[row.fillClassName] ?? EVENT_PASTEL_BY_FILL_CLASS["kind-none"] ?? DEFAULT_EVENT_PASTEL;
}

function buildSegmentEventBackground(rows: ActivityTimelineRowModel[], startIndex: number, endIndex: number): string {
  if (startIndex > endIndex) return EVENT_PASTEL_BY_FILL_CLASS["kind-none"] ?? DEFAULT_EVENT_PASTEL;
  const totalBinCount = endIndex - startIndex + 1;
  const runs: Array<{ startIndex: number; endIndex: number; color: string }> = [];

  for (let binIndex = startIndex; binIndex <= endIndex; binIndex += 1) {
    const color = eventPastelForRow(rows[binIndex]);
    const previousRun = runs[runs.length - 1];
    if (previousRun && previousRun.color === color) {
      previousRun.endIndex = binIndex;
      continue;
    }
    runs.push({ startIndex: binIndex, endIndex: binIndex, color });
  }

  if (runs.length <= 1) return runs[0]?.color ?? EVENT_PASTEL_BY_FILL_CLASS["kind-none"] ?? DEFAULT_EVENT_PASTEL;

  const stops = runs.map((run) => {
    const leftPct = ((run.startIndex - startIndex) / totalBinCount) * 100;
    const rightPct = ((run.endIndex - startIndex + 1) / totalBinCount) * 100;
    return `${run.color} ${leftPct.toFixed(2)}% ${rightPct.toFixed(2)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

function buildCompressedColumnTemplate(rows: ActivityTimelineRowModel[], binMinutes: number): TimelineCompressionResult {
  if (rows.length === 0) return { columnTemplate: "", hasCompressedIdleGap: false };
  const safeBinMinutes = Math.max(1, Math.floor(binMinutes));
  const thresholdBins = Math.max(1, Math.ceil(IDLE_COMPRESSION_THRESHOLD_MINUTES / safeBinMinutes));
  const widths = Array.from({ length: rows.length }, () => 1);
  let hasCompressedIdleGap = false;

  for (let index = 0; index < rows.length; ) {
    const row = rows[index];
    if (!row?.hasNoAgents) {
      index += 1;
      continue;
    }
    let endExclusive = index + 1;
    while (endExclusive < rows.length && rows[endExclusive]?.hasNoAgents) {
      endExclusive += 1;
    }
    const runLength = endExclusive - index;
    if (runLength > thresholdBins) {
      hasCompressedIdleGap = true;
      for (let runIndex = index; runIndex < endExclusive; runIndex += 1) {
        widths[runIndex] = IDLE_COMPRESSED_BIN_FR;
      }
      widths[index] = Math.max(widths[index] ?? IDLE_COMPRESSED_BIN_FR, IDLE_COMPRESSED_EDGE_BIN_FR);
      widths[endExclusive - 1] = Math.max(
        widths[endExclusive - 1] ?? IDLE_COMPRESSED_BIN_FR,
        IDLE_COMPRESSED_EDGE_BIN_FR,
      );
    }
    index = endExclusive;
  }

  return {
    columnTemplate: widths.map((width) => `${width.toFixed(3)}fr`).join(" "),
    hasCompressedIdleGap,
  };
}

function buildSessionSegments(
  rows: ActivityTimelineRowModel[],
  traceAgentById: Readonly<Record<string, AgentKind>> | undefined,
): { segments: SessionSegment[]; laneCount: number } {
  const binIndexesByTraceId = new Map<string, number[]>();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (!row) continue;
    for (const traceId of row.activeTraceIds) {
      const bucket = binIndexesByTraceId.get(traceId);
      if (bucket) bucket.push(rowIndex);
      else binIndexesByTraceId.set(traceId, [rowIndex]);
    }
  }

  const rawSegments: Omit<SessionSegment, "laneIndex">[] = [];
  for (const [traceId, indexes] of binIndexesByTraceId.entries()) {
    if (indexes.length === 0) continue;
    indexes.sort((left, right) => left - right);
    let runStart = indexes[0] ?? 0;
    let runEnd = runStart;
    for (let idx = 1; idx < indexes.length; idx += 1) {
      const next = indexes[idx] ?? runEnd;
      if (next === runEnd + 1) {
        runEnd = next;
        continue;
      }
      rawSegments.push({
        traceId,
        startIndex: runStart,
        endIndex: runEnd,
        firstLabel: rows[runStart]?.timeLabel ?? "",
        lastLabel: rows[runEnd]?.timeLabel ?? "",
        agent: traceAgentById?.[traceId] ?? "unknown",
        eventBackground: buildSegmentEventBackground(rows, runStart, runEnd),
      });
      runStart = next;
      runEnd = next;
    }
    rawSegments.push({
      traceId,
      startIndex: runStart,
      endIndex: runEnd,
      firstLabel: rows[runStart]?.timeLabel ?? "",
      lastLabel: rows[runEnd]?.timeLabel ?? "",
      agent: traceAgentById?.[traceId] ?? "unknown",
      eventBackground: buildSegmentEventBackground(rows, runStart, runEnd),
    });
  }

  rawSegments.sort((left, right) => left.startIndex - right.startIndex || left.traceId.localeCompare(right.traceId));

  const laneEndIndex: number[] = [];
  const segments: SessionSegment[] = [];
  for (const segment of rawSegments) {
    let laneIndex = -1;
    for (let lane = 0; lane < laneEndIndex.length; lane += 1) {
      const laneEnd = laneEndIndex[lane] ?? -1;
      if (segment.startIndex > laneEnd) {
        laneIndex = lane;
        break;
      }
    }
    if (laneIndex < 0) {
      laneIndex = laneEndIndex.length;
      laneEndIndex.push(segment.endIndex);
    } else {
      laneEndIndex[laneIndex] = segment.endIndex;
    }
    segments.push({ ...segment, laneIndex });
  }

  return {
    segments,
    laneCount: Math.max(1, laneEndIndex.length),
  };
}

function weekSnapshotFromDayActivity(day: AgentActivityDay): AgentActivityWeek {
  return {
    tzOffsetMinutes: day.tzOffsetMinutes,
    dayCount: 1,
    slotMinutes: day.binMinutes,
    hourStartLocal: 0,
    hourEndLocal: 24,
    startDateLocal: day.dateLocal,
    endDateLocal: day.dateLocal,
    days: [
      {
        dateLocal: day.dateLocal,
        windowStartMs: day.windowStartMs,
        windowEndMs: day.windowEndMs,
        totalSessionsInWindow: day.totalSessionsInWindow,
        peakConcurrentSessions: day.peakConcurrentSessions,
        peakConcurrentAtMs: day.peakConcurrentAtMs,
        bins: day.bins,
      },
    ],
  };
}

export function ActivityView({
  onInspectTrace,
  traceAgentById,
  traceTokenTotalsById,
}: ActivityViewProps): JSX.Element {
  const [selectedDateLocal, setSelectedDateLocal] = useState(() => defaultSelectedActivityDateLocal());
  const [selectedWeekEndDateLocal, setSelectedWeekEndDateLocal] = useState(() => todayLocalDateString());
  const [activity, setActivity] = useState<AgentActivityDay | null>(null);
  const [activityWeek, setActivityWeek] = useState<AgentActivityWeek | null>(null);
  const [activityYear, setActivityYear] = useState<AgentActivityWeek | null>(null);
  const [isWeekLoading, setIsWeekLoading] = useState(true);
  const [isYearLoading, setIsYearLoading] = useState(true);
  const [isDaySummaryExpanded, setIsDaySummaryExpanded] = useState(false);
  const [isWeekSummaryExpanded, setIsWeekSummaryExpanded] = useState(false);
  const [isYearSummaryExpanded, setIsYearSummaryExpanded] = useState(false);
  const [status, setStatus] = useState("Loading daily activity...");

  const fetchDayActivity = useCallback(async (dateLocal: string): Promise<void> => {
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const binMinutes = deriveBinMinutesForViewport(window.innerWidth || 1280);
    const refreshedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dayUrl = `${API}/api/activity/day?date=${encodeURIComponent(dateLocal)}&tz_offset_min=${tzOffsetMinutes}&bin_min=${binMinutes}&break_min=${BREAK_MINUTES}`;

    try {
      const dayResponse = await fetch(dayUrl, { cache: "no-store" });
      if (!dayResponse.ok) {
        const payload = (await dayResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${dayResponse.status}`);
      }
      const dayPayload = (await dayResponse.json()) as ActivityDayResponse;
      setActivity(dayPayload.activity);
      setStatus(`Daily updated ${refreshedAt}`);
    } catch (error) {
      setStatus(`Daily activity failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const fetchWeekActivity = useCallback(async (endDateLocal: string): Promise<void> => {
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const refreshedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const weekUrl =
      `${API}/api/activity/week?end_date=${encodeURIComponent(endDateLocal)}` +
      `&tz_offset_min=${tzOffsetMinutes}` +
      `&day_count=${WEEK_DAY_COUNT}` +
      `&slot_min=${WEEK_SLOT_MINUTES}` +
      `&hour_start=${WEEK_HOUR_START_LOCAL}` +
      `&hour_end=${WEEK_HOUR_END_LOCAL}`;

    setIsWeekLoading(true);
    try {
      const weekResponse = await fetch(weekUrl, { cache: "no-store" });
      if (!weekResponse.ok) {
        const payload = (await weekResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${weekResponse.status}`);
      }
      const weekPayload = (await weekResponse.json()) as ActivityWeekResponse;
      setActivityWeek(weekPayload.activity);
      setStatus(`Week updated ${refreshedAt}`);
    } catch (error) {
      setStatus(`Week Heatmap failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsWeekLoading(false);
    }
  }, []);

  const fetchYearActivity = useCallback(async (): Promise<void> => {
    const endDateLocal = todayLocalDateString();
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const dayCount = yearDayCountForDateLocal(endDateLocal);
    const refreshedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const yearUrl =
      `${API}/api/activity/week?end_date=${encodeURIComponent(endDateLocal)}` +
      `&tz_offset_min=${tzOffsetMinutes}` +
      `&day_count=${dayCount}` +
      `&slot_min=${YEAR_SLOT_MINUTES}` +
      `&hour_start=${YEAR_HOUR_START_LOCAL}` +
      `&hour_end=${YEAR_HOUR_END_LOCAL}`;

    setIsYearLoading(true);
    try {
      const yearResponse = await fetch(yearUrl, { cache: "no-store" });
      if (!yearResponse.ok) {
        const payload = (await yearResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${yearResponse.status}`);
      }
      const yearPayload = (await yearResponse.json()) as ActivityWeekResponse;
      setActivityYear(yearPayload.activity);
      setStatus(`Year updated ${refreshedAt}`);
    } catch (error) {
      setStatus(`Year Heatmap failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsYearLoading(false);
    }
  }, []);

  useEffect(() => {
    let inFlight = false;
    let isDisposed = false;
    const refreshSequence = async (): Promise<void> => {
      if (inFlight || isDisposed) return;
      inFlight = true;
      try {
        await fetchDayActivity(selectedDateLocal);
        if (isDisposed) return;
        await fetchWeekActivity(selectedWeekEndDateLocal);
        if (isDisposed) return;
        await fetchYearActivity();
      } finally {
        inFlight = false;
      }
    };

    void refreshSequence();
    const intervalId = window.setInterval(() => {
      void refreshSequence();
    }, REFRESH_INTERVAL_MS);
    return () => {
      isDisposed = true;
      window.clearInterval(intervalId);
    };
  }, [fetchDayActivity, fetchWeekActivity, fetchYearActivity, selectedDateLocal, selectedWeekEndDateLocal]);

  const model = useMemo(() => (activity ? buildActivityViewModel(activity) : null), [activity]);
  const weekModel = useMemo(() => (activityWeek ? buildActivityWeekHeatmapModel(activityWeek) : null), [activityWeek]);
  const yearModel = useMemo(() => (activityYear ? buildActivityYearHeatmapModel(activityYear) : null), [activityYear]);
  const dailyUsageSummary = useMemo(
    () =>
      activity ? buildWeeklyUsageSummary(weekSnapshotFromDayActivity(activity), traceAgentById, traceTokenTotalsById) : null,
    [activity, traceAgentById, traceTokenTotalsById],
  );
  const weeklyUsageSummary = useMemo(
    () => (activityWeek ? buildWeeklyUsageSummary(activityWeek, traceAgentById, traceTokenTotalsById) : null),
    [activityWeek, traceAgentById, traceTokenTotalsById],
  );
  const yearlyUsageSummary = useMemo(
    () => (activityYear ? buildWeeklyUsageSummary(activityYear, traceAgentById, traceTokenTotalsById) : null),
    [activityYear, traceAgentById, traceTokenTotalsById],
  );
  const binCount = model?.rows.length ?? 0;
  const { segments, laneCount } = useMemo(
    () => (model ? buildSessionSegments(model.rows, traceAgentById) : { segments: [], laneCount: 1 }),
    [model, traceAgentById],
  );
  const { columnTemplate, hasCompressedIdleGap } = useMemo(
    () =>
      model
        ? buildCompressedColumnTemplate(model.rows, activity?.binMinutes ?? MIN_BIN_MINUTES)
        : { columnTemplate: "", hasCompressedIdleGap: false },
    [activity?.binMinutes, model],
  );
  const showSegmentLabels = binCount > 0 && binCount <= 120;
  const headerStatus = !weekModel && isWeekLoading ? "Loading daily, week, year..." : status;
  const timelineStyle = useMemo(
    () =>
      ({
        "--activity-bin-count": String(Math.max(1, binCount)),
        "--activity-lane-count": String(Math.max(1, laneCount)),
        ...(columnTemplate ? { gridTemplateColumns: columnTemplate } : {}),
      }) as CSSProperties,
    [binCount, columnTemplate, laneCount],
  );

  return (
    <section className="panel activity-panel">
      <div className="panel-head activity-head">
        <div className="activity-head-main">
          <h2>Activity</h2>
          <div className="activity-head-meta mono">{activity ? `${activity.dateLocal} overview` : "today"}</div>
        </div>
        <div className="activity-head-right">
          <div className="activity-head-status mono">{headerStatus}</div>
          {activity && model ? (
            <div className="activity-head-stats" aria-label="daily activity summary">
              <span className="mono activity-head-stat">{`sessions ${formatCompactNumber(activity.totalSessionsInWindow)} in window`}</span>
              <span className="mono activity-head-stat">{`peak ${formatCompactNumber(model.peakConcurrentSessions)} at ${formatTime(model.peakConcurrentAtMs)}`}</span>
              <span className="mono activity-head-stat">{`breaks ${formatCompactNumber(model.breakCount)} · ${Math.round(model.breakMinutes)} min`}</span>
              <span className="mono activity-head-stat">{`active bins ${formatCompactNumber(model.activeBinCount)} · no agents ${formatCompactNumber(model.inactiveBinCount)}`}</span>
            </div>
          ) : null}
        </div>
      </div>

      {activity && model ? (
        <>
          <section className="activity-day-timeline" aria-label="daily activity timeline">
            <div className="activity-day-plot">
              <div className="activity-day-head">
                <div className="mono activity-day-title">Daily Activity</div>
                <section className="activity-legend" aria-label="agent legend and no-agent state">
                  <span className="mono activity-legend-title">agent border legend</span>
                  {AGENT_LEGEND_ITEMS.map((item) => (
                    <span key={item.label} className="mono activity-legend-item">
                      <span className={`activity-legend-swatch ${item.className}`} aria-hidden="true" />
                      <span>{item.label}</span>
                    </span>
                  ))}
                  <span className="mono activity-legend-item no-agents">
                    <span className="activity-legend-empty-swatch" aria-hidden="true" />
                    <span>no agents ran</span>
                  </span>
                </section>
                <div className="mono activity-day-meta">
                  {`${activity.dateLocal} · ${activity.binMinutes}m bins · break ${activity.breakMinutes}m+${hasCompressedIdleGap ? " · idle >4h compressed" : ""}`}
                </div>
              </div>

              <div className="activity-scroll" aria-label="horizontal timeline of agent activity by time">
                <div className="activity-axis mono">
                  <span>early</span>
                  <span>late</span>
                </div>
                <div className="activity-timeline activity-timeline-horizontal" style={timelineStyle}>
                  {model.rows.map((row, rowIndex) => (
                    <div
                      key={`heat-${row.key}`}
                      className={`activity-bin-heat ${row.hasNoAgents ? "no-agents" : ""} ${row.isBreak ? "is-break" : ""}`}
                      style={{
                        gridColumn: `${rowIndex + 1}`,
                        ...(row.eventKindGradient ? { background: row.eventKindGradient } : {}),
                      }}
                      title={row.tooltip}
                    />
                  ))}
                  {segments.map((segment) => {
                    return (
                      <button
                        key={`${segment.traceId}-${segment.startIndex}-${segment.endIndex}`}
                        type="button"
                        onClick={() => {
                          onInspectTrace?.(segment.traceId);
                        }}
                        className={`activity-session-segment agent-border-${segment.agent}`}
                        style={{
                          gridColumn: `${segment.startIndex + 1} / ${segment.endIndex + 2}`,
                          gridRow: `${segment.laneIndex + 1}`,
                          background: segment.eventBackground,
                        }}
                        title={`${segment.traceId} · ${segment.firstLabel}-${segment.lastLabel}`}
                        aria-label={`Inspect ${segment.traceId} from ${segment.firstLabel} to ${segment.lastLabel}`}
                      >
                        <span className="mono activity-segment-label">{showSegmentLabels ? segment.traceId : ""}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="activity-idle-band" style={timelineStyle} aria-label="no-agent windows">
                  {model.rows.map((row, rowIndex) => (
                    <span
                      key={`idle-${row.key}`}
                      className={`activity-idle-cell ${row.hasNoAgents ? "active" : ""}`}
                      style={{ gridColumn: `${rowIndex + 1}` }}
                      title={row.hasNoAgents ? `${row.timeLabel}: no agents ran` : `${row.timeLabel}: active`}
                    />
                  ))}
                </div>
                <div className="activity-time-grid" style={timelineStyle}>
                  {model.rows.map((row, rowIndex) => (
                    <span
                      key={`tick-${row.key}`}
                      className={`mono activity-time activity-bin-time ${row.showTimeTick ? "show" : ""}`}
                      style={{ gridColumn: `${rowIndex + 1}` }}
                    >
                      {row.showTimeTick ? row.timeLabel : ""}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="mono activity-summary-toggle activity-summary-plot-toggle"
                data-period="day"
                aria-expanded={isDaySummaryExpanded}
                onClick={() => {
                  setIsDaySummaryExpanded((current) => !current);
                }}
              >
                {isDaySummaryExpanded ? "Hide Day Summary" : "Show Day Summary"}
              </button>
            </div>
            {dailyUsageSummary && isDaySummaryExpanded ? (
              <UsageSummarySection
                periodKey="day"
                title="Day Summary"
                meta={`${activity.dateLocal} · ranked by session-hours`}
                emptyLabel="No daily agent activity yet."
                summary={dailyUsageSummary}
                className="activity-summary-inline"
              />
            ) : null}
          </section>

          {weekModel ? (
            <section className="activity-week-heatmap" aria-label="weekly activity heatmap">
              <div className="activity-week-plot">
                <div className="activity-week-head">
                  <div className="mono activity-week-title">Weekly Activity</div>
                  <div className="mono activity-week-meta">{`${weekModel.startDateLabel}-${weekModel.endDateLabel} · ${weekModel.windowLabel} · ${weekModel.slotMinutes}m bins`}</div>
                </div>
                <div className="activity-week-scale" aria-hidden="true">
                  {weekModel.scaleLabels.map((label) => (
                    <span key={label.key} className="mono activity-week-scale-label" style={{ left: `${label.leftPct}%` }}>
                      {label.label}
                    </span>
                  ))}
                </div>
                <div className="activity-week-grid">
                  {weekModel.days.map((day) => (
                    <div key={day.dateLocal} className="activity-week-row">
                      <button
                        type="button"
                        className={`mono activity-week-day-button ${selectedDateLocal === day.dateLocal ? "active" : ""}`}
                        data-date-local={day.dateLocal}
                        aria-pressed={selectedDateLocal === day.dateLocal}
                        onClick={() => {
                          setSelectedDateLocal(day.dateLocal);
                        }}
                        title={`Show Daily Activity for ${day.dateLocal}`}
                      >
                        {`${day.dayLabel} · ${formatCompactNumber(day.totalSessionsInWindow)}`}
                      </button>
                      <div
                        className="activity-week-row-cells"
                        style={
                          {
                            "--activity-week-slot-count": String(Math.max(1, weekModel.slotCount)),
                          } as CSSProperties
                        }
                      >
                        {day.cells.map((cell) => {
                          const tooltip = buildWeekCellTooltip(day, cell);
                          return (
                            <button
                              key={cell.key}
                              type="button"
                              className={`activity-week-cell level-${cell.level} ${selectedDateLocal === day.dateLocal ? "active" : ""}`}
                              data-date-local={day.dateLocal}
                              data-time-label={cell.timeLabel}
                              data-tooltip={tooltip}
                              onClick={() => {
                                setSelectedDateLocal(day.dateLocal);
                              }}
                              aria-label={`Show Daily Activity for ${day.dateLocal} at ${cell.timeLabel}`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="activity-week-legend" aria-hidden="true">
                  <span className="mono">less</span>
                  <span className="activity-week-legend-swatch level-0" />
                  <span className="activity-week-legend-swatch level-1" />
                  <span className="activity-week-legend-swatch level-2" />
                  <span className="activity-week-legend-swatch level-3" />
                  <span className="activity-week-legend-swatch level-4" />
                  <span className="mono">more</span>
                </div>
                {weeklyUsageSummary ? (
                  <button
                    type="button"
                    className="mono activity-summary-toggle activity-summary-plot-toggle"
                    data-period="week"
                    aria-expanded={isWeekSummaryExpanded}
                    onClick={() => {
                      setIsWeekSummaryExpanded((current) => !current);
                    }}
                  >
                    {isWeekSummaryExpanded ? "Hide Week Summary" : "Show Week Summary"}
                  </button>
                ) : null}
              </div>
              {weeklyUsageSummary && isWeekSummaryExpanded ? (
                <UsageSummarySection
                  periodKey="week"
                  title="Week Summary"
                  meta={`${weekModel.startDateLabel}-${weekModel.endDateLabel} · ranked by session-hours`}
                  emptyLabel="No weekly agent activity yet."
                  summary={weeklyUsageSummary}
                  className="activity-summary-inline"
                />
              ) : null}
            </section>
          ) : isWeekLoading ? (
            <section className="activity-week-heatmap activity-week-loading" aria-label="weekly activity heatmap loading">
              <div className="activity-week-head">
                <div className="mono activity-week-title">Weekly Activity</div>
                <div className="mono activity-week-meta">Loading...</div>
              </div>
            </section>
          ) : null}

          {yearModel ? (
            <section className="activity-year-heatmap" aria-label="yearly activity heatmap">
              <div className="activity-year-plot">
                <div className="activity-year-head">
                  <div className="mono activity-year-title">Yearly Activity</div>
                  <div className="mono activity-year-meta">
                    {`${yearModel.yearLabel} · ${yearModel.startDateLabel}-${yearModel.endDateLabel} · daily aggregation`}
                  </div>
                </div>
                <div className="activity-year-chart">
                  <div className="activity-year-weekday-axis" aria-hidden="true">
                    {yearModel.weekdayLabels.map((label, weekdayIndex) => (
                      <span
                        key={`${label}-${weekdayIndex}`}
                        className={`mono activity-year-weekday-label ${weekdayIndex % 2 === 0 ? "show" : ""}`}
                      >
                        {weekdayIndex % 2 === 0 ? label : ""}
                      </span>
                    ))}
                  </div>
                  <div className="activity-year-grid-wrap">
                    <div
                      className="activity-year-week-labels"
                      style={{ "--activity-year-week-count": String(Math.max(1, yearModel.weekCount)) } as CSSProperties}
                      aria-hidden="true"
                    >
                      {yearModel.weekLabels.map((label) => (
                        <span key={label.key} className="mono activity-year-week-label" style={{ gridColumn: `${label.weekIndex + 1}` }}>
                          {label.label}
                        </span>
                      ))}
                    </div>
                    <div
                      className="activity-year-grid"
                      style={{ "--activity-year-week-count": String(Math.max(1, yearModel.weekCount)) } as CSSProperties}
                    >
                      {yearModel.cells.map((cell) => (
                        <button
                          key={cell.key}
                          type="button"
                          className={`activity-year-cell level-${cell.level} ${selectedDateLocal === cell.dateLocal ? "active" : ""}`}
                          data-date-local={cell.dateLocal}
                          style={{ gridColumn: `${cell.weekIndex + 1}`, gridRow: `${cell.weekdayIndex + 1}` }}
                          onClick={() => {
                            setSelectedDateLocal(cell.dateLocal);
                            setSelectedWeekEndDateLocal(
                              isOlderThanCurrentWeekWindow(cell.dateLocal) ? cell.dateLocal : todayLocalDateString(),
                            );
                          }}
                          title={buildYearCellTooltip(cell)}
                          aria-label={`Show Daily Activity for ${cell.dateLocal}`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                <div className="activity-week-legend" aria-hidden="true">
                  <span className="mono">less</span>
                  <span className="activity-week-legend-swatch level-0" />
                  <span className="activity-week-legend-swatch level-1" />
                  <span className="activity-week-legend-swatch level-2" />
                  <span className="activity-week-legend-swatch level-3" />
                  <span className="activity-week-legend-swatch level-4" />
                  <span className="mono">more</span>
                </div>
                {yearlyUsageSummary ? (
                  <button
                    type="button"
                    className="mono activity-summary-toggle activity-summary-plot-toggle"
                    data-period="year"
                    aria-expanded={isYearSummaryExpanded}
                    onClick={() => {
                      setIsYearSummaryExpanded((current) => !current);
                    }}
                  >
                    {isYearSummaryExpanded ? "Hide Year Summary" : "Show Year Summary"}
                  </button>
                ) : null}
              </div>
              {yearlyUsageSummary && isYearSummaryExpanded ? (
                <UsageSummarySection
                  periodKey="year"
                  title="Year Summary"
                  meta={`${yearModel.startDateLabel}-${yearModel.endDateLabel} · ranked by session-hours`}
                  emptyLabel="No yearly agent activity yet."
                  summary={yearlyUsageSummary}
                  className="activity-summary-inline"
                />
              ) : null}
            </section>
          ) : isYearLoading ? (
            <section className="activity-year-heatmap activity-year-loading" aria-label="yearly activity heatmap loading">
              <div className="activity-year-head">
                <div className="mono activity-year-title">Yearly Activity</div>
                <div className="mono activity-year-meta">Loading...</div>
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <div className="empty">{status}</div>
      )}
    </section>
  );
}
