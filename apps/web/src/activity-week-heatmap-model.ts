import type { AgentActivityWeek, AgentKind } from "@agentlens/contracts";

const MINUTES_PER_DAY = 24 * 60;
const HEATMAP_LEVEL_COUNT = 4;
const SCALE_STEP_MINUTES = 4 * 60;
const AGENT_KIND_ORDER: AgentKind[] = ["codex", "claude", "cursor", "opencode", "gemini", "pi", "unknown"];

export interface ActivityWeekHeatmapCellModel {
  key: string;
  slotIndex: number;
  startMs: number;
  endMs: number;
  timeLabel: string;
  activeSessionCount: number;
  activeByAgent: Record<AgentKind, number>;
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

export interface WeeklyAgentUsageRow {
  agent: AgentKind;
  sessionHours: number;
  sessionSharePct: number;
  uniqueSessions: number;
  activeSlots: number;
  activeDays: number;
  peakConcurrentSessions: number;
  inputTokens: number;
  cacheTokens: number;
  outputTokens: number;
}

export interface WeeklyUsageSummaryTotals {
  totalUniqueSessions: number;
  totalSessionHours: number;
  peakAllAgentConcurrency: number;
  mostUsedAgent: AgentKind | null;
}

export interface WeeklyUsageSummaryModel {
  rows: WeeklyAgentUsageRow[];
  totals: WeeklyUsageSummaryTotals;
}

export interface TraceTokenTotalsSnapshot {
  inputTokens?: number | null;
  cachedReadTokens?: number | null;
  cachedCreateTokens?: number | null;
  outputTokens?: number | null;
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
  const windowMinutes = computeWindowMinutes(week.hourStartLocal, week.hourEndLocal);
  if (windowMinutes <= 0 || week.slotMinutes <= 0) return 0;
  return Math.ceil(windowMinutes / week.slotMinutes);
}

function computeWindowMinutes(hourStartLocal: number, hourEndLocal: number): number {
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

function createUsageRow(agent: AgentKind): WeeklyAgentUsageRow {
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

function sanitizeTokenValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function snapshotActiveByAgent(activeByAgent: Partial<Record<AgentKind, number>> | undefined): Record<AgentKind, number> {
  return Object.fromEntries(AGENT_KIND_ORDER.map((agent) => [agent, activeByAgent?.[agent] ?? 0])) as Record<AgentKind, number>;
}

export function buildWeeklyUsageSummary(
  week: AgentActivityWeek,
  traceAgentById?: Readonly<Record<string, AgentKind>>,
  traceTokenTotalsById?: Readonly<Record<string, TraceTokenTotalsSnapshot | undefined>>,
): WeeklyUsageSummaryModel {
  const usageByAgent = new Map<AgentKind, WeeklyAgentUsageRow>();
  const uniqueSessionIdsByAgent = new Map<AgentKind, Set<string>>();
  const totalUniqueSessionIds = new Set<string>();
  let peakAllAgentConcurrency = 0;

  for (const agent of AGENT_KIND_ORDER) {
    usageByAgent.set(agent, createUsageRow(agent));
    uniqueSessionIdsByAgent.set(agent, new Set<string>());
  }

  for (const day of week.days) {
    const activeAgentsToday = new Set<AgentKind>();
    for (const bin of day.bins) {
      peakAllAgentConcurrency = Math.max(peakAllAgentConcurrency, bin.activeSessionCount);
      const binHours = Math.max(0, bin.endMs - bin.startMs) / 3_600_000;
      for (const agent of AGENT_KIND_ORDER) {
        const agentSessionsInBin = bin.activeByAgent[agent] ?? 0;
        if (agentSessionsInBin <= 0) continue;
        const row = usageByAgent.get(agent);
        if (!row) continue;
        row.sessionHours += agentSessionsInBin * binHours;
        row.activeSlots += 1;
        row.peakConcurrentSessions = Math.max(row.peakConcurrentSessions, agentSessionsInBin);
        activeAgentsToday.add(agent);
      }

      for (const traceId of bin.activeTraceIds) {
        totalUniqueSessionIds.add(traceId);
        const mappedAgent = traceAgentById?.[traceId] ?? "unknown";
        const normalizedAgent: AgentKind = AGENT_KIND_ORDER.includes(mappedAgent) ? mappedAgent : "unknown";
        const sessionSet = uniqueSessionIdsByAgent.get(normalizedAgent);
        if (!sessionSet) continue;
        sessionSet.add(traceId);
      }
    }

    for (const agent of activeAgentsToday) {
      const row = usageByAgent.get(agent);
      if (!row) continue;
      row.activeDays += 1;
    }
  }

  for (const agent of AGENT_KIND_ORDER) {
    const row = usageByAgent.get(agent);
    const sessions = uniqueSessionIdsByAgent.get(agent);
    if (!row || !sessions) continue;
    row.uniqueSessions = sessions.size;
    for (const traceId of sessions) {
      const tokenTotals = traceTokenTotalsById?.[traceId];
      const inputTokens = sanitizeTokenValue(tokenTotals?.inputTokens);
      const cacheTokens =
        sanitizeTokenValue(tokenTotals?.cachedReadTokens) + sanitizeTokenValue(tokenTotals?.cachedCreateTokens);
      const outputTokens = sanitizeTokenValue(tokenTotals?.outputTokens);
      row.inputTokens += inputTokens;
      row.cacheTokens += cacheTokens;
      row.outputTokens += outputTokens;
    }
  }

  const totalSessionHours = AGENT_KIND_ORDER.reduce((sum, agent) => {
    const row = usageByAgent.get(agent);
    return sum + (row?.sessionHours ?? 0);
  }, 0);

  const rows = AGENT_KIND_ORDER.map((agent) => usageByAgent.get(agent) as WeeklyAgentUsageRow)
    .filter((row) => row.sessionHours > 0 || row.uniqueSessions > 0 || row.activeSlots > 0)
    .map((row) => ({
      ...row,
      sessionSharePct: totalSessionHours > 0 ? (row.sessionHours / totalSessionHours) * 100 : 0,
    }))
    .sort(
      (left, right) =>
        right.sessionHours - left.sessionHours || right.uniqueSessions - left.uniqueSessions || left.agent.localeCompare(right.agent),
    );

  const mostUsedAgent = rows[0]?.agent ?? null;

  return {
    rows,
    totals: {
      totalUniqueSessions: totalUniqueSessionIds.size,
      totalSessionHours,
      peakAllAgentConcurrency,
      mostUsedAgent,
    },
  };
}

export function buildActivityWeekHeatmapModel(week: AgentActivityWeek): ActivityWeekHeatmapModel {
  const slotCount = computeSlotCount(week);
  const slotMs = week.slotMinutes * 60_000;
  const windowMinutes = computeWindowMinutes(week.hourStartLocal, week.hourEndLocal);

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
        activeByAgent: snapshotActiveByAgent(bin?.activeByAgent),
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
    windowLabel:
      windowMinutes >= MINUTES_PER_DAY
        ? "Full day"
        : `${formatClock((week.hourStartLocal * 60) % MINUTES_PER_DAY)}-${formatClock(
            (week.hourEndLocal * 60) % MINUTES_PER_DAY,
          )}`,
    startDateLabel: formatRangeDateLabel(week.startDateLocal),
    endDateLabel: formatRangeDateLabel(week.endDateLocal),
    maxSessionsPerSlot,
    days,
    scaleLabels: buildScaleLabels(week, slotCount),
  };
}
