import type { AgentActivityWeek } from "@agentlens/contracts";

const MINUTES_PER_DAY = 24 * 60;
const HEATMAP_LEVEL_COUNT = 4;
const SCALE_STEP_MINUTES = 4 * 60;

export interface ActivityWeekHeatmapCellModel {
  key: string;
  slotIndex: number;
  startMs: number;
  endMs: number;
  timeLabel: string;
  activeSessionCount: number;
  eventCount: number;
  primaryTraceId: string;
  level: number;
}

export interface ActivityWeekHeatmapDayModel {
  dateLocal: string;
  dayLabel: string;
  totalSessionsInWindow: number;
  cells: ActivityWeekHeatmapCellModel[];
}

export interface ActivityWeekHeatmapScaleLabel {
  key: string;
  label: string;
  leftPct: number;
}

export interface ActivityWeekHeatmapModel {
  slotCount: number;
  slotMinutes: number;
  windowLabel: string;
  startDateLabel: string;
  endDateLabel: string;
  maxSessionsPerSlot: number;
  days: ActivityWeekHeatmapDayModel[];
  scaleLabels: ActivityWeekHeatmapScaleLabel[];
}

function minuteOfDayForSlot(hourStartLocal: number, slotMinutes: number, slotIndex: number): number {
  const minuteOfDay = hourStartLocal * 60 + slotMinutes * slotIndex;
  const normalized = minuteOfDay % MINUTES_PER_DAY;
  return normalized < 0 ? normalized + MINUTES_PER_DAY : normalized;
}

function formatClock(minuteOfDay: number): string {
  const hours24 = Math.floor(minuteOfDay / 60) % 24;
  const minutes = minuteOfDay % 60;
  const suffix = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function formatScaleClock(minuteOfDay: number): string {
  const hours24 = Math.floor(minuteOfDay / 60) % 24;
  const suffix = hours24 >= 12 ? "p" : "a";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}${suffix}`;
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

function formatDayLabel(dateLocal: string): string {
  const date = parseDateLocal(dateLocal);
  if (!date) return dateLocal;
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  });
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

function computeSlotCount(week: AgentActivityWeek): number {
  const windowMinutes = ((week.hourEndLocal - week.hourStartLocal + 24) % 24) * 60;
  if (windowMinutes <= 0 || week.slotMinutes <= 0) return 0;
  return Math.ceil(windowMinutes / week.slotMinutes);
}

function buildScaleLabels(week: AgentActivityWeek, slotCount: number): ActivityWeekHeatmapScaleLabel[] {
  const windowMinutes = slotCount * week.slotMinutes;
  if (windowMinutes <= 0) return [];

  const labels: ActivityWeekHeatmapScaleLabel[] = [];
  for (let offsetMinutes = 0; offsetMinutes <= windowMinutes; offsetMinutes += SCALE_STEP_MINUTES) {
    const minuteOfDay = minuteOfDayForSlot(week.hourStartLocal, 1, offsetMinutes);
    labels.push({
      key: `${offsetMinutes}`,
      label: formatScaleClock(minuteOfDay),
      leftPct: (offsetMinutes / windowMinutes) * 100,
    });
  }

  if (labels.length === 0 || labels[labels.length - 1]?.leftPct !== 100) {
    const minuteOfDay = minuteOfDayForSlot(week.hourStartLocal, 1, windowMinutes);
    labels.push({
      key: "end",
      label: formatScaleClock(minuteOfDay),
      leftPct: 100,
    });
  }

  return labels;
}

function levelForCount(count: number, maxCount: number): number {
  if (count <= 0 || maxCount <= 0) return 0;
  return Math.max(1, Math.min(HEATMAP_LEVEL_COUNT, Math.ceil((count / maxCount) * HEATMAP_LEVEL_COUNT)));
}

export function buildActivityWeekHeatmapModel(week: AgentActivityWeek): ActivityWeekHeatmapModel {
  const slotCount = computeSlotCount(week);
  const slotMs = week.slotMinutes * 60_000;

  const maxSessionsPerSlot = week.days.reduce((dayMax, day) => {
    const rowMax = day.bins.reduce((max, bin) => Math.max(max, bin.activeSessionCount), 0);
    return Math.max(dayMax, rowMax);
  }, 0);

  const days: ActivityWeekHeatmapDayModel[] = week.days.map((day) => {
    const dayLabel = formatDayLabel(day.dateLocal);
    const cells: ActivityWeekHeatmapCellModel[] = [];
    for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
      const bin = day.bins[slotIndex];
      const fallbackStartMs = day.windowStartMs + slotIndex * slotMs;
      const startMs = bin?.startMs ?? fallbackStartMs;
      const endMs = bin?.endMs ?? Math.min(day.windowEndMs, fallbackStartMs + slotMs);
      const activeSessionCount = bin?.activeSessionCount ?? 0;
      const eventCount = bin?.eventCount ?? 0;
      const timeStartMinute = minuteOfDayForSlot(week.hourStartLocal, week.slotMinutes, slotIndex);
      const timeEndMinute = minuteOfDayForSlot(week.hourStartLocal, week.slotMinutes, slotIndex + 1);
      const timeLabel = `${formatClock(timeStartMinute)}-${formatClock(timeEndMinute)}`;
      cells.push({
        key: `${day.dateLocal}-${slotIndex}`,
        slotIndex,
        startMs,
        endMs,
        timeLabel,
        activeSessionCount,
        eventCount,
        primaryTraceId: bin?.primaryTraceId ?? "",
        level: levelForCount(activeSessionCount, maxSessionsPerSlot),
      });
    }

    return {
      dateLocal: day.dateLocal,
      dayLabel,
      totalSessionsInWindow: day.totalSessionsInWindow,
      cells,
    };
  });

  return {
    slotCount,
    slotMinutes: week.slotMinutes,
    windowLabel: `${formatClock((week.hourStartLocal * 60) % MINUTES_PER_DAY)}-${formatClock(
      (week.hourEndLocal * 60) % MINUTES_PER_DAY,
    )}`,
    startDateLabel: formatRangeDateLabel(week.startDateLocal),
    endDateLabel: formatRangeDateLabel(week.endDateLocal),
    maxSessionsPerSlot,
    days,
    scaleLabels: buildScaleLabels(week, slotCount),
  };
}
