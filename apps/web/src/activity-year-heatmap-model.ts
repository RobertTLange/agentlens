import type { ActivityHeatmapPresentation, AgentActivityYear } from "@agentlens/contracts";

const HEATMAP_LEVEL_COUNT = 4;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export interface ActivityYearHeatmapCellModel {
  key: string;
  dateLocal: string;
  dayLabel: string;
  dayOfMonth: number;
  weekIndex: number;
  weekdayIndex: number;
  totalSessionsInWindow: number;
  heatmapValue: number;
  totalEventCount: number;
  peakConcurrentSessions: number;
  level: number;
}

export interface ActivityYearHeatmapWeekLabelModel {
  key: string;
  weekIndex: number;
  label: string;
}

export interface ActivityYearHeatmapModel {
  presentation: ActivityHeatmapPresentation;
  dayCount: number;
  weekCount: number;
  startDateLabel: string;
  endDateLabel: string;
  yearLabel: string;
  maxDailySessions: number;
  maxHeatmapValue: number;
  weekLabels: ActivityYearHeatmapWeekLabelModel[];
  weekdayLabels: string[];
  cells: ActivityYearHeatmapCellModel[];
}

function parseDateLocal(dateLocal: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal);
  if (!match) return null;
  const year = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const day = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function dayDiff(startUtcDate: Date, endUtcDate: Date): number {
  return Math.round((endUtcDate.getTime() - startUtcDate.getTime()) / MS_PER_DAY);
}

function levelForCount(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  return Math.max(1, Math.min(HEATMAP_LEVEL_COUNT, Math.ceil((count / maxCount) * HEATMAP_LEVEL_COUNT)));
}

function formatRangeDateLabel(dateLocal: string): string {
  const date = parseDateLocal(dateLocal);
  if (!date) return dateLocal;
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatMonthLabel(dateLocal: string): string {
  const date = parseDateLocal(dateLocal);
  if (!date) return dateLocal;
  return date.toLocaleDateString([], {
    month: "short",
    timeZone: "UTC",
  });
}

function formatYearRangeLabel(startDateLocal: string, endDateLocal: string): string {
  const startDate = parseDateLocal(startDateLocal);
  const endDate = parseDateLocal(endDateLocal);
  if (!startDate || !endDate) return `${startDateLocal}-${endDateLocal}`;
  if (startDate.getUTCFullYear() === endDate.getUTCFullYear()) {
    return String(startDate.getUTCFullYear());
  }
  return `${startDate.toLocaleDateString([], { month: "short", year: "numeric", timeZone: "UTC" })}-${endDate.toLocaleDateString([], { month: "short", year: "numeric", timeZone: "UTC" })}`;
}

function formatDayLabel(dateLocal: string): string {
  const date = parseDateLocal(dateLocal);
  if (!date) return dateLocal;
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function buildActivityYearHeatmapModel(year: AgentActivityYear): ActivityYearHeatmapModel {
  const startDate = parseDateLocal(year.startDateLocal);
  const endDate = parseDateLocal(year.endDateLocal);
  if (!startDate || !endDate) {
    return {
      presentation: year.presentation,
      dayCount: year.dayCount,
      weekCount: 0,
      startDateLabel: year.startDateLocal,
      endDateLabel: year.endDateLocal,
      yearLabel: `${year.startDateLocal}-${year.endDateLocal}`,
      maxDailySessions: 0,
      maxHeatmapValue: 0,
      weekLabels: [],
      weekdayLabels: [...WEEKDAY_LABELS],
      cells: [],
    };
  }

  const startCalendarDate = new Date(startDate.getTime() - startDate.getUTCDay() * MS_PER_DAY);
  const endCalendarDate = new Date(endDate.getTime() + (6 - endDate.getUTCDay()) * MS_PER_DAY);
  const weekCount = Math.max(1, Math.floor(dayDiff(startCalendarDate, endCalendarDate) / 7) + 1);
  const maxDailySessions = year.days.reduce((max, day) => Math.max(max, day.totalSessionsInWindow), 0);
  const maxHeatmapValue = year.days.reduce((max, day) => Math.max(max, day.heatmapValue), 0);
  const cells: ActivityYearHeatmapCellModel[] = [];

  for (const day of year.days) {
    const dayDate = parseDateLocal(day.dateLocal);
    if (!dayDate) continue;
    const offsetDays = dayDiff(startCalendarDate, dayDate);
    if (offsetDays < 0) continue;
    const weekIndex = Math.floor(offsetDays / 7);
    const weekdayIndex = dayDate.getUTCDay();
    if (weekdayIndex < 0 || weekdayIndex >= WEEKDAY_LABELS.length) continue;

    cells.push({
      key: day.dateLocal,
      dateLocal: day.dateLocal,
      dayLabel: formatDayLabel(day.dateLocal),
      dayOfMonth: dayDate.getUTCDate(),
      weekIndex,
      weekdayIndex,
      totalSessionsInWindow: day.totalSessionsInWindow,
      heatmapValue: day.heatmapValue,
      totalEventCount: day.totalEventCount,
      peakConcurrentSessions: day.peakConcurrentSessions,
      level: levelForCount(day.heatmapValue, maxHeatmapValue),
    });
  }

  cells.sort((left, right) => left.dateLocal.localeCompare(right.dateLocal));

  const weekLabels: ActivityYearHeatmapWeekLabelModel[] = [];
  let previousMonthLabel = "";
  let previousWeekIndex = -1;
  for (const cell of cells) {
    if (cell.weekIndex === previousWeekIndex) {
      continue;
    }
    const monthLabel = formatMonthLabel(cell.dateLocal);
    if (weekLabels.length === 0 || monthLabel !== previousMonthLabel) {
      weekLabels.push({
        key: `week-label-${cell.weekIndex}`,
        weekIndex: cell.weekIndex,
        label: monthLabel,
      });
    }
    previousWeekIndex = cell.weekIndex;
    previousMonthLabel = monthLabel;
  }

  return {
    presentation: year.presentation,
    dayCount: year.dayCount,
    weekCount,
    startDateLabel: formatRangeDateLabel(year.startDateLocal),
    endDateLabel: formatRangeDateLabel(year.endDateLocal),
    yearLabel: formatYearRangeLabel(year.startDateLocal, year.endDateLocal),
    maxDailySessions,
    maxHeatmapValue,
    weekLabels,
    weekdayLabels: [...WEEKDAY_LABELS],
    cells,
  };
}
