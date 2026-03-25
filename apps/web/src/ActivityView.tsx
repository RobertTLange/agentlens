import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import type {
  ActivityHeatmapMetric,
  ActivityHeatmapMetricValues,
  ActivityHeatmapPresentation,
  AgentActivityDay,
  AgentActivityWeek,
  AgentActivityYear,
  AgentKind,
  IndexStartupStatus,
} from "@agentlens/contracts";
import { buildActivityViewModel, type ActivityTimelineRowModel } from "./activity-view-model.js";
import {
  buildActivityWeekHeatmapModel,
  buildWeeklyUsageSummary,
  type WeeklyUsageSummaryModel,
  type TraceTokenTotalsSnapshot,
} from "./activity-week-heatmap-model.js";
import { buildActivityYearHeatmapModel } from "./activity-year-heatmap-model.js";
import { formatCompactNumber, formatPercent, formatUsd, iconForAgent } from "./view-model.js";

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
const HEATMAP_METRIC_OPTIONS: Array<{ value: ActivityHeatmapMetric; label: string }> = [
  { value: "sessions", label: "Sessions" },
  { value: "output_tokens", label: "Output Tokens" },
  { value: "total_cost_usd", label: "Total Cost" },
];
const HEATMAP_COLOR_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Red", value: "#dc2626" },
  { label: "Green", value: "#16a34a" },
  { label: "Blue", value: "#2563eb" },
  { label: "Amber", value: "#d97706" },
  { label: "Teal", value: "#0f766e" },
];
const DEFAULT_HEATMAP_COLOR = "#dc2626";
const ACTIVITY_REQUEST_TIMEOUT_MS = 10_000;

interface ActivityDayResponse {
  activity: AgentActivityDay;
}

interface ActivityWeekResponse {
  activity: AgentActivityWeek;
}

interface ActivityYearResponse {
  activity: AgentActivityYear;
}

interface ActivityWarmingResponse {
  warming: true;
  startup: IndexStartupStatus;
}

interface ActivityViewProps {
  startup?: IndexStartupStatus | null;
  onInspectTrace?: (traceId: string) => void;
  traceAgentById?: Readonly<Record<string, AgentKind>>;
  traceTokenTotalsById?: Readonly<Record<string, TraceTokenTotalsSnapshot | undefined>>;
  selectedHeatmapMetric?: ActivityHeatmapMetric | null;
  selectedHeatmapColor?: string | null;
  onSelectHeatmapMetric?: (metric: ActivityHeatmapMetric | null) => void;
  onSelectHeatmapColor?: (color: string | null) => void;
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
  cell: {
    timeLabel: string;
    activeSessionCount: number;
    heatmapValue: number;
    activeByAgent: Record<AgentKind, number>;
    eventCount: number;
    level: number;
  },
  metric: ActivityHeatmapMetric,
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
    `${heatmapMetricLabel(metric)} ${formatHeatmapMetricValue(metric, cell.heatmapValue)}`,
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
  heatmapValue: number;
  totalEventCount: number;
  peakConcurrentSessions: number;
  level: number;
}, metric: ActivityHeatmapMetric): string {
  return [
    `${cell.dayLabel} (${cell.dateLocal})`,
    `sessions ${cell.totalSessionsInWindow}`,
    `${heatmapMetricLabel(metric)} ${formatHeatmapMetricValue(metric, cell.heatmapValue)}`,
    `events ${cell.totalEventCount}`,
    `peak conc. ${cell.peakConcurrentSessions}`,
    `intensity ${cell.level}/4`,
  ].join(" · ");
}

function heatmapMetricLabel(metric: ActivityHeatmapMetric): string {
  if (metric === "output_tokens") return "out tokens";
  if (metric === "total_cost_usd") return "cost";
  return "sessions";
}

function formatHeatmapMetricValue(metric: ActivityHeatmapMetric, value: number): string {
  if (metric === "total_cost_usd") return formatUsd(value);
  return formatCompactNumber(value);
}

function weekDayHeatmapSummary(day: { totalSessionsInWindow: number; heatmapValue?: number }, metric: ActivityHeatmapMetric): string {
  if (metric === "sessions") {
    return formatCompactNumber(day.totalSessionsInWindow);
  }
  return formatHeatmapMetricValue(metric, day.heatmapValue ?? 0);
}

function weekDayHeatmapLabel(metric: ActivityHeatmapMetric): string {
  if (metric === "output_tokens") return "out tokens";
  if (metric === "total_cost_usd") return "cost";
  return "sessions";
}

function heatmapPaletteStyle(palette: readonly string[]): CSSProperties {
  return {
    "--activity-week-level-0": palette[0] ?? "#ffffff",
    "--activity-week-level-1": palette[1] ?? "#fee2e2",
    "--activity-week-level-2": palette[2] ?? "#fca5a5",
    "--activity-week-level-3": palette[3] ?? "#ef4444",
    "--activity-week-level-4": palette[4] ?? "#b91c1c",
  } as CSSProperties;
}

function normalizeHeatmapColor(color: string): string {
  return color.trim().toLowerCase();
}

function heatmapMetricValue(metric: ActivityHeatmapMetric, values: ActivityHeatmapMetricValues | undefined, fallback: number): number {
  if (!values) return fallback;
  if (metric === "sessions") return values.sessions;
  if (metric === "output_tokens") return values.output_tokens;
  return values.total_cost_usd;
}

function hexChannel(color: string, start: number): number {
  return Number.parseInt(color.slice(start, start + 2), 16);
}

function toHexChannel(value: number): string {
  return Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, "0");
}

function mixHexColor(color: string, colorWeight: number): string {
  const normalized = normalizeHeatmapColor(color);
  const baseWeight = Math.max(0, Math.min(1, colorWeight));
  const whiteWeight = 1 - baseWeight;
  const red = hexChannel(normalized, 1) * baseWeight + 255 * whiteWeight;
  const green = hexChannel(normalized, 3) * baseWeight + 255 * whiteWeight;
  const blue = hexChannel(normalized, 5) * baseWeight + 255 * whiteWeight;
  return `#${toHexChannel(red)}${toHexChannel(green)}${toHexChannel(blue)}`;
}

function buildLocalHeatmapPresentation(metric: ActivityHeatmapMetric, color: string): ActivityHeatmapPresentation {
  const normalizedColor = normalizeHeatmapColor(color);
  return {
    metric,
    color: normalizedColor,
    palette: [
      "#ffffff",
      mixHexColor(normalizedColor, 0.18),
      mixHexColor(normalizedColor, 0.38),
      mixHexColor(normalizedColor, 0.62),
      mixHexColor(normalizedColor, 0.82),
    ],
  };
}

function applyWeekHeatmapOverrides(week: AgentActivityWeek, metric: ActivityHeatmapMetric, color: string): AgentActivityWeek {
  const presentation = buildLocalHeatmapPresentation(metric, color);
  return {
    ...week,
    presentation,
    days: week.days.map((day) => ({
      ...day,
      heatmapValue: heatmapMetricValue(metric, day.heatmapValues, day.heatmapValue),
      bins: day.bins.map((bin) => ({
        ...bin,
        heatmapValue: heatmapMetricValue(metric, bin.heatmapValues, bin.heatmapValue),
      })),
    })),
  };
}

function applyYearHeatmapOverrides(year: AgentActivityYear, metric: ActivityHeatmapMetric, color: string): AgentActivityYear {
  const presentation = buildLocalHeatmapPresentation(metric, color);
  return {
    ...year,
    presentation,
    days: year.days.map((day) => ({
      ...day,
      heatmapValue: heatmapMetricValue(metric, day.heatmapValues, day.heatmapValue),
    })),
  };
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
    presentation: {
      metric: "sessions",
      color: "#dc2626",
      palette: ["#ffffff", "#fee2e2", "#fca5a5", "#ef4444", "#b91c1c"],
    },
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
        heatmapValue: day.totalSessionsInWindow,
        peakConcurrentSessions: day.peakConcurrentSessions,
        peakConcurrentAtMs: day.peakConcurrentAtMs,
        totalEventCount: day.totalEventCount,
        bins: day.bins,
      },
    ],
  };
}

export function ActivityView({
  startup,
  onInspectTrace,
  traceAgentById,
  traceTokenTotalsById,
  selectedHeatmapMetric: controlledSelectedHeatmapMetric,
  selectedHeatmapColor: controlledSelectedHeatmapColor,
  onSelectHeatmapMetric,
  onSelectHeatmapColor,
}: ActivityViewProps): JSX.Element {
  const dayRequestSeqRef = useRef(0);
  const weekRequestSeqRef = useRef(0);
  const yearRequestSeqRef = useRef(0);
  const dayAbortRef = useRef<AbortController | null>(null);
  const weekAbortRef = useRef<AbortController | null>(null);
  const yearAbortRef = useRef<AbortController | null>(null);
  const [selectedDateLocal, setSelectedDateLocal] = useState(() => defaultSelectedActivityDateLocal());
  const [selectedWeekEndDateLocal, setSelectedWeekEndDateLocal] = useState(() => todayLocalDateString());
  const [todayDateLocal, setTodayDateLocal] = useState(() => todayLocalDateString());
  const [activity, setActivity] = useState<AgentActivityDay | null>(null);
  const [activityWeek, setActivityWeek] = useState<AgentActivityWeek | null>(null);
  const [activityYear, setActivityYear] = useState<AgentActivityYear | null>(null);
  const [isDayLoading, setIsDayLoading] = useState(true);
  const [isWeekLoading, setIsWeekLoading] = useState(true);
  const [isYearLoading, setIsYearLoading] = useState(true);
  const [isDaySummaryExpanded, setIsDaySummaryExpanded] = useState(false);
  const [isWeekSummaryExpanded, setIsWeekSummaryExpanded] = useState(false);
  const [isYearSummaryExpanded, setIsYearSummaryExpanded] = useState(false);
  const [defaultHeatmapMetric, setDefaultHeatmapMetric] = useState<ActivityHeatmapMetric>("sessions");
  const [defaultHeatmapColor, setDefaultHeatmapColor] = useState(DEFAULT_HEATMAP_COLOR);
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [dayError, setDayError] = useState("");
  const [weekError, setWeekError] = useState("");
  const [yearError, setYearError] = useState("");
  const [status, setStatus] = useState("Loading daily activity...");
  const isHistoryReady = startup?.fullReady ?? true;

  const selectActivityDate = useCallback(
    (dateLocal: string, source: "week" | "year"): void => {
      setSelectedDateLocal(dateLocal);
      if (source === "year") {
        setSelectedWeekEndDateLocal(isOlderThanCurrentWeekWindow(dateLocal) ? dateLocal : todayDateLocal);
      }
    },
    [todayDateLocal],
  );

  const displayedHeatmapMetric = controlledSelectedHeatmapMetric ?? defaultHeatmapMetric;
  const displayedHeatmapColor = controlledSelectedHeatmapColor ?? defaultHeatmapColor;

  const handleHeatmapMetricChange = useCallback(
    (metric: ActivityHeatmapMetric): void => {
      onSelectHeatmapMetric?.(metric === defaultHeatmapMetric ? null : metric);
    },
    [defaultHeatmapMetric, onSelectHeatmapMetric],
  );

  const handleHeatmapColorChange = useCallback(
    (color: string): void => {
      const normalizedColor = normalizeHeatmapColor(color);
      onSelectHeatmapColor?.(normalizedColor === defaultHeatmapColor ? null : normalizedColor);
      setIsColorPickerOpen(false);
    },
    [defaultHeatmapColor, onSelectHeatmapColor],
  );

  const abortInFlightRequest = useCallback((ref: MutableRefObject<AbortController | null>): void => {
    ref.current?.abort();
    ref.current = null;
  }, []);

  const fetchDayActivity = useCallback(async (dateLocal: string): Promise<void> => {
    const requestSeq = dayRequestSeqRef.current + 1;
    dayRequestSeqRef.current = requestSeq;
    abortInFlightRequest(dayAbortRef);
    const abortController = new AbortController();
    dayAbortRef.current = abortController;
    let didTimeout = false;
    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, ACTIVITY_REQUEST_TIMEOUT_MS);
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const binMinutes = deriveBinMinutesForViewport(window.innerWidth || 1280);
    const refreshedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dayUrl = `${API}/api/activity/day?date=${encodeURIComponent(dateLocal)}&tz_offset_min=${tzOffsetMinutes}&bin_min=${binMinutes}&break_min=${BREAK_MINUTES}`;

    setIsDayLoading(true);
    try {
      const dayResponse = await fetch(dayUrl, { cache: "no-store", signal: abortController.signal });
      if (!dayResponse.ok) {
        const payload = (await dayResponse.json().catch(() => ({}))) as ActivityWarmingResponse & { error?: string };
        if (dayResponse.status === 503 && payload.warming && payload.startup) {
          const message = `Indexing history ${payload.startup.hydratedTraceCount}/${payload.startup.discoveredTraceCount}`;
          setDayError(message);
          setStatus(message);
          return;
        }
        throw new Error(payload.error || `HTTP ${dayResponse.status}`);
      }
      const dayPayload = (await dayResponse.json()) as ActivityDayResponse;
      if (requestSeq !== dayRequestSeqRef.current) return;
      setActivity(dayPayload.activity);
      setDayError("");
      setStatus(`Daily updated ${refreshedAt}`);
    } catch (error) {
      if (requestSeq !== dayRequestSeqRef.current) return;
      if (abortController.signal.aborted && !didTimeout) return;
      const message = didTimeout
        ? "Daily activity timed out"
        : `Daily activity failed: ${error instanceof Error ? error.message : String(error)}`;
      setDayError(message);
      setStatus(message);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestSeq === dayRequestSeqRef.current) {
        dayAbortRef.current = null;
        setIsDayLoading(false);
      }
    }
  }, [abortInFlightRequest]);

  const fetchWeekActivity = useCallback(async (endDateLocal: string): Promise<void> => {
    const requestSeq = weekRequestSeqRef.current + 1;
    weekRequestSeqRef.current = requestSeq;
    abortInFlightRequest(weekAbortRef);
    const abortController = new AbortController();
    weekAbortRef.current = abortController;
    let didTimeout = false;
    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, ACTIVITY_REQUEST_TIMEOUT_MS);
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
      const weekResponse = await fetch(weekUrl, { cache: "no-store", signal: abortController.signal });
      if (!weekResponse.ok) {
        const payload = (await weekResponse.json().catch(() => ({}))) as ActivityWarmingResponse & { error?: string };
        if (weekResponse.status === 503 && payload.warming && payload.startup) {
          const message = `Indexing history ${payload.startup.hydratedTraceCount}/${payload.startup.discoveredTraceCount}`;
          setWeekError(message);
          setStatus(message);
          return;
        }
        throw new Error(payload.error || `HTTP ${weekResponse.status}`);
      }
      const weekPayload = (await weekResponse.json()) as ActivityWeekResponse;
      if (requestSeq !== weekRequestSeqRef.current) return;
      setDefaultHeatmapMetric((current) =>
        current === weekPayload.activity.presentation.metric ? current : weekPayload.activity.presentation.metric,
      );
      setDefaultHeatmapColor((current) => {
        const next = weekPayload.activity.presentation.color;
        return current === next ? current : next;
      });
      setActivityWeek(weekPayload.activity);
      setWeekError("");
      setStatus(`Week updated ${refreshedAt}`);
    } catch (error) {
      if (requestSeq !== weekRequestSeqRef.current) return;
      if (abortController.signal.aborted && !didTimeout) return;
      const message = didTimeout
        ? "Week Heatmap timed out"
        : `Week Heatmap failed: ${error instanceof Error ? error.message : String(error)}`;
      setWeekError(message);
      setStatus(message);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestSeq === weekRequestSeqRef.current) {
        weekAbortRef.current = null;
        setIsWeekLoading(false);
      }
    }
  }, [abortInFlightRequest]);

  const fetchYearActivity = useCallback(async (endDateLocal: string): Promise<void> => {
    const requestSeq = yearRequestSeqRef.current + 1;
    yearRequestSeqRef.current = requestSeq;
    abortInFlightRequest(yearAbortRef);
    const abortController = new AbortController();
    yearAbortRef.current = abortController;
    let didTimeout = false;
    const timeoutId = window.setTimeout(() => {
      didTimeout = true;
      abortController.abort();
    }, ACTIVITY_REQUEST_TIMEOUT_MS);
    const tzOffsetMinutes = new Date().getTimezoneOffset();
    const refreshedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const yearUrl =
      `${API}/api/activity/year?end_date=${encodeURIComponent(endDateLocal)}` +
      `&tz_offset_min=${tzOffsetMinutes}` +
      `&day_count=${yearDayCountForDateLocal(endDateLocal)}`;

    setIsYearLoading(true);
    try {
      const yearResponse = await fetch(yearUrl, { cache: "no-store", signal: abortController.signal });
      if (!yearResponse.ok) {
        const payload = (await yearResponse.json().catch(() => ({}))) as ActivityWarmingResponse & { error?: string };
        if (yearResponse.status === 503 && payload.warming && payload.startup) {
          const message = `Indexing history ${payload.startup.hydratedTraceCount}/${payload.startup.discoveredTraceCount}`;
          setYearError(message);
          setStatus(message);
          return;
        }
        throw new Error(payload.error || `HTTP ${yearResponse.status}`);
      }
      const yearPayload = (await yearResponse.json()) as ActivityYearResponse;
      if (requestSeq !== yearRequestSeqRef.current) return;
      setDefaultHeatmapMetric((current) =>
        current === yearPayload.activity.presentation.metric ? current : yearPayload.activity.presentation.metric,
      );
      setDefaultHeatmapColor((current) => {
        const next = yearPayload.activity.presentation.color;
        return current === next ? current : next;
      });
      setActivityYear(yearPayload.activity);
      setYearError("");
      setStatus(`Year updated ${refreshedAt}`);
    } catch (error) {
      if (requestSeq !== yearRequestSeqRef.current) return;
      if (abortController.signal.aborted && !didTimeout) return;
      const message = didTimeout
        ? "Year Heatmap timed out"
        : `Year Heatmap failed: ${error instanceof Error ? error.message : String(error)}`;
      setYearError(message);
      setStatus(message);
    } finally {
      window.clearTimeout(timeoutId);
      if (requestSeq === yearRequestSeqRef.current) {
        yearAbortRef.current = null;
        setIsYearLoading(false);
      }
    }
  }, [abortInFlightRequest]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const nextTodayDateLocal = todayLocalDateString();
      setTodayDateLocal((current) => (current === nextTodayDateLocal ? current : nextTodayDateLocal));
    }, REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    return () => {
      abortInFlightRequest(dayAbortRef);
      abortInFlightRequest(weekAbortRef);
      abortInFlightRequest(yearAbortRef);
    };
  }, [abortInFlightRequest]);

  useEffect(() => {
    let isDisposed = false;
    let inFlight = false;
    const refreshDay = async (): Promise<void> => {
      if (inFlight || isDisposed) return;
      inFlight = true;
      try {
        await fetchDayActivity(selectedDateLocal);
      } finally {
        inFlight = false;
      }
    };

    void refreshDay();
    const intervalId = window.setInterval(() => {
      void refreshDay();
    }, REFRESH_INTERVAL_MS);
    return () => {
      isDisposed = true;
      window.clearInterval(intervalId);
    };
  }, [fetchDayActivity, isHistoryReady, selectedDateLocal]);

  useEffect(() => {
    let isDisposed = false;
    let inFlight = false;
    const refreshWeek = async (): Promise<void> => {
      if (inFlight || isDisposed) return;
      inFlight = true;
      try {
        await fetchWeekActivity(selectedWeekEndDateLocal);
      } finally {
        inFlight = false;
      }
    };

    void refreshWeek();
    if (selectedWeekEndDateLocal !== todayDateLocal) {
      return () => {
        isDisposed = true;
      };
    }
    const intervalId = window.setInterval(() => {
      void refreshWeek();
    }, REFRESH_INTERVAL_MS);
    return () => {
      isDisposed = true;
      window.clearInterval(intervalId);
    };
  }, [fetchWeekActivity, isHistoryReady, selectedWeekEndDateLocal, todayDateLocal]);

  useEffect(() => {
    void fetchYearActivity(todayDateLocal);
  }, [fetchYearActivity, isHistoryReady, todayDateLocal]);

  const effectiveActivityWeek = useMemo(
    () => (activityWeek ? applyWeekHeatmapOverrides(activityWeek, displayedHeatmapMetric, displayedHeatmapColor) : null),
    [activityWeek, displayedHeatmapColor, displayedHeatmapMetric],
  );
  const effectiveActivityYear = useMemo(
    () => (activityYear ? applyYearHeatmapOverrides(activityYear, displayedHeatmapMetric, displayedHeatmapColor) : null),
    [activityYear, displayedHeatmapColor, displayedHeatmapMetric],
  );
  const model = useMemo(() => (activity ? buildActivityViewModel(activity) : null), [activity]);
  const weekModel = useMemo(
    () => (effectiveActivityWeek ? buildActivityWeekHeatmapModel(effectiveActivityWeek) : null),
    [effectiveActivityWeek],
  );
  const yearModel = useMemo(
    () => (effectiveActivityYear ? buildActivityYearHeatmapModel(effectiveActivityYear) : null),
    [effectiveActivityYear],
  );
  const weekHeatmapStyle = useMemo(
    () => (weekModel ? heatmapPaletteStyle(weekModel.presentation.palette) : undefined),
    [weekModel],
  );
  const yearHeatmapStyle = useMemo(
    () => (yearModel ? heatmapPaletteStyle(yearModel.presentation.palette) : undefined),
    [yearModel],
  );
  const dailyUsageSummary = useMemo(
    () =>
      activity ? buildWeeklyUsageSummary(weekSnapshotFromDayActivity(activity), traceAgentById, traceTokenTotalsById) : null,
    [activity, traceAgentById, traceTokenTotalsById],
  );
  const weeklyUsageSummary = useMemo(
    () => (effectiveActivityWeek ? buildWeeklyUsageSummary(effectiveActivityWeek, traceAgentById, traceTokenTotalsById) : null),
    [effectiveActivityWeek, traceAgentById, traceTokenTotalsById],
  );
  const yearlyUsageSummary = effectiveActivityYear?.usageSummary ?? null;
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
  const warmingProgressPct = startup && startup.discoveredTraceCount > 0
    ? Math.max(0, Math.min(100, Math.round((startup.hydratedTraceCount / startup.discoveredTraceCount) * 100)))
    : 0;
  const headerStatus =
    isDayLoading && isWeekLoading && isYearLoading
      ? "Loading daily, week, year..."
      : status;
  const renderHydrationProgress = (title: string, ariaLabel: string): JSX.Element => (
    <div className="activity-loading-state">
      <div className="mono activity-loading-title">{title}</div>
      <div className="mono activity-loading-copy">
        {startup ? `Indexing history ${startup.hydratedTraceCount}/${startup.discoveredTraceCount}` : "Loading history"}
      </div>
      <div className="activity-progress activity-progress-inline" aria-label={`${title} loading progress`}>
        <div
          className="activity-progress-bar"
          role="progressbar"
          aria-label={ariaLabel}
          aria-valuemin={0}
          aria-valuemax={startup?.discoveredTraceCount ?? 0}
          aria-valuenow={startup?.hydratedTraceCount ?? 0}
          aria-valuetext={`${warmingProgressPct}% complete`}
        >
          <span className="activity-progress-fill" style={{ width: `${warmingProgressPct}%` }} />
        </div>
        <span className="mono activity-progress-label">{`${warmingProgressPct}%`}</span>
      </div>
    </div>
  );
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
          <div className="activity-head-controls" aria-label="heatmap display controls">
            <label className="activity-head-control">
              <span className="mono activity-head-control-label">metric</span>
              <select
                className="mono activity-head-select"
                aria-label="Heatmap metric"
                value={displayedHeatmapMetric}
                onChange={(event) => {
                  handleHeatmapMetricChange(event.target.value as ActivityHeatmapMetric);
                }}
              >
                {HEATMAP_METRIC_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="activity-color-menu">
              <button
                type="button"
                className="mono activity-color-trigger"
                aria-label="Heatmap color"
                aria-expanded={isColorPickerOpen}
                data-current-color={displayedHeatmapColor}
                onClick={() => {
                  setIsColorPickerOpen((current) => !current);
                }}
              >
                <span className="activity-color-trigger-label">color</span>
                <span className="activity-color-current-swatch" style={{ background: displayedHeatmapColor }} aria-hidden="true" />
              </button>
              {isColorPickerOpen ? (
                <div className="activity-color-popover" role="dialog" aria-label="Heatmap color picker">
                  <div className="activity-color-swatches">
                    {HEATMAP_COLOR_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        className={`activity-color-option ${displayedHeatmapColor === preset.value ? "active" : ""}`}
                        aria-label={`Use ${preset.label} heatmap color`}
                        data-color={preset.value}
                        onClick={() => {
                          handleHeatmapColorChange(preset.value);
                        }}
                        style={{ background: preset.value }}
                      />
                    ))}
                  </div>
                  <label className="activity-color-custom">
                    <span className="mono activity-head-control-label">custom</span>
                    <input
                      type="color"
                      aria-label="Custom heatmap color"
                      value={displayedHeatmapColor}
                      onChange={(event) => {
                        handleHeatmapColorChange(event.target.value);
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </div>
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

      <>
        {activity && model ? (
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
        ) : !isHistoryReady ? (
          <section className="activity-day-timeline activity-day-loading" aria-label="daily activity timeline loading">
            {renderHydrationProgress("Daily Activity", "Daily activity hydration progress")}
          </section>
        ) : isDayLoading ? (
          <section className="activity-day-timeline activity-day-loading" aria-label="daily activity timeline loading">
            <div className="activity-day-head">
              <div className="mono activity-day-title">Daily Activity</div>
              <div className="mono activity-day-meta">Loading...</div>
            </div>
          </section>
        ) : (
          <section className="activity-day-timeline activity-day-empty" aria-label="daily activity timeline unavailable">
            <div className="empty">{status}</div>
          </section>
        )}

        {weekModel ? (
          <section className="activity-week-heatmap" aria-label="weekly activity heatmap" style={weekHeatmapStyle}>
            <div className="activity-week-plot">
              <div className="activity-week-head">
                <div className="mono activity-week-title">Weekly Activity</div>
                <div className="mono activity-week-meta">
                  {`${weekModel.startDateLabel}-${weekModel.endDateLabel} · ${weekModel.windowLabel} · ${weekModel.slotMinutes}m bins · ${heatmapMetricLabel(weekModel.presentation.metric)}`}
                </div>
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
                  <div
                    key={day.dateLocal}
                    className="activity-week-row"
                    data-date-local={day.dateLocal}
                    onClick={() => {
                      selectActivityDate(day.dateLocal, "week");
                    }}
                  >
                    <button
                      type="button"
                      className={`mono activity-week-day-button ${selectedDateLocal === day.dateLocal ? "active" : ""}`}
                      data-date-local={day.dateLocal}
                      aria-pressed={selectedDateLocal === day.dateLocal}
                      onClick={() => {
                        selectActivityDate(day.dateLocal, "week");
                      }}
                      title={`Show Daily Activity for ${day.dateLocal}`}
                    >
                      <span className="activity-week-day-date">{day.dayLabel}</span>
                      <span className="activity-week-day-metric">
                        {`${weekDayHeatmapLabel(weekModel.presentation.metric)} ${weekDayHeatmapSummary(day, weekModel.presentation.metric)}`}
                      </span>
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
                        const tooltip = buildWeekCellTooltip(day, cell, weekModel.presentation.metric);
                        return (
                          <button
                            key={cell.key}
                            type="button"
                            className={`activity-week-cell level-${cell.level} ${selectedDateLocal === day.dateLocal ? "active" : ""}`}
                            data-date-local={day.dateLocal}
                            data-time-label={cell.timeLabel}
                            data-tooltip={tooltip}
                            onClick={() => {
                              selectActivityDate(day.dateLocal, "week");
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
                <span className="mono">{`less ${heatmapMetricLabel(weekModel.presentation.metric)}`}</span>
                <span className="activity-week-legend-swatch level-0" />
                <span className="activity-week-legend-swatch level-1" />
                <span className="activity-week-legend-swatch level-2" />
                <span className="activity-week-legend-swatch level-3" />
                <span className="activity-week-legend-swatch level-4" />
                <span className="mono">{`more ${heatmapMetricLabel(weekModel.presentation.metric)}`}</span>
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
        ) : !isHistoryReady ? (
          <section className="activity-week-heatmap activity-week-loading" aria-label="weekly activity heatmap loading">
            {renderHydrationProgress("Weekly Activity", "Weekly activity hydration progress")}
          </section>
        ) : isWeekLoading ? (
          <section className="activity-week-heatmap activity-week-loading" aria-label="weekly activity heatmap loading">
            <div className="activity-week-head">
              <div className="mono activity-week-title">Weekly Activity</div>
              <div className="mono activity-week-meta">Loading...</div>
            </div>
          </section>
        ) : (
          <section className="activity-week-heatmap activity-week-empty" aria-label="weekly activity heatmap unavailable">
            <div className="empty">{weekError || "Weekly activity unavailable."}</div>
          </section>
        )}

        {yearModel ? (
          <section className="activity-year-heatmap" aria-label="yearly activity heatmap" style={yearHeatmapStyle}>
            <div className="activity-year-plot">
              <div className="activity-year-head">
                <div className="mono activity-year-title">Yearly Activity</div>
                <div className="mono activity-year-meta">
                  {`${yearModel.yearLabel} · ${yearModel.startDateLabel}-${yearModel.endDateLabel} · daily aggregation · ${heatmapMetricLabel(yearModel.presentation.metric)}`}
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
                          selectActivityDate(cell.dateLocal, "year");
                        }}
                        title={buildYearCellTooltip(cell, yearModel.presentation.metric)}
                        aria-label={`Show Daily Activity for ${cell.dateLocal}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="activity-week-legend" aria-hidden="true">
                <span className="mono">{`less ${heatmapMetricLabel(yearModel.presentation.metric)}`}</span>
                <span className="activity-week-legend-swatch level-0" />
                <span className="activity-week-legend-swatch level-1" />
                <span className="activity-week-legend-swatch level-2" />
                <span className="activity-week-legend-swatch level-3" />
                <span className="activity-week-legend-swatch level-4" />
                <span className="mono">{`more ${heatmapMetricLabel(yearModel.presentation.metric)}`}</span>
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
        ) : !isHistoryReady ? (
          <section className="activity-year-heatmap activity-year-loading" aria-label="yearly activity heatmap loading">
            {renderHydrationProgress("Yearly Activity", "Yearly activity hydration progress")}
          </section>
        ) : isYearLoading ? (
          <section className="activity-year-heatmap activity-year-loading" aria-label="yearly activity heatmap loading">
            <div className="activity-year-head">
              <div className="mono activity-year-title">Yearly Activity</div>
              <div className="mono activity-year-meta">Loading...</div>
            </div>
          </section>
        ) : (
          <section className="activity-year-heatmap activity-year-empty" aria-label="yearly activity heatmap unavailable">
            <div className="empty">{yearError || "Yearly activity unavailable."}</div>
          </section>
        )}
      </>
    </section>
  );
}
