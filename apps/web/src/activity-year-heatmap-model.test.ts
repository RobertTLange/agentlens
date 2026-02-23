import type { AgentActivityWeek, AgentKind, EventKind } from "@agentlens/contracts";
import { describe, expect, it } from "vitest";
import { buildActivityYearHeatmapModel } from "./activity-year-heatmap-model.js";

const SLOT_MINUTES = 30;

function makeAgentCounts(overrides: Partial<Record<AgentKind, number>> = {}): Record<AgentKind, number> {
  return {
    claude: overrides.claude ?? 0,
    codex: overrides.codex ?? 0,
    cursor: overrides.cursor ?? 0,
    opencode: overrides.opencode ?? 0,
    gemini: overrides.gemini ?? 0,
    pi: overrides.pi ?? 0,
    unknown: overrides.unknown ?? 0,
  };
}

function makeEventCounts(overrides: Partial<Record<EventKind, number>> = {}): Record<EventKind, number> {
  return {
    system: overrides.system ?? 0,
    assistant: overrides.assistant ?? 0,
    user: overrides.user ?? 0,
    tool_use: overrides.tool_use ?? 0,
    tool_result: overrides.tool_result ?? 0,
    reasoning: overrides.reasoning ?? 0,
    meta: overrides.meta ?? 0,
  };
}

function makeYearFixture(): AgentActivityWeek {
  const dayDates = [
    "2026-02-24",
    "2026-02-25",
    "2026-02-26",
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
    "2026-03-02",
  ];

  const days = dayDates.map((dateLocal, index) => {
    const dateMs = Date.parse(`${dateLocal}T00:00:00.000Z`);
    const sessions = index === 5 ? 4 : index % 3;
    const bins = Array.from({ length: 2 }, (_, slotIndex) => {
      const startMs = dateMs + slotIndex * SLOT_MINUTES * 60_000;
      const activeSessionCount = slotIndex === 0 ? sessions : Math.max(0, sessions - 1);
      return {
        startMs,
        endMs: startMs + SLOT_MINUTES * 60_000,
        activeSessionCount,
        activeTraceIds: activeSessionCount > 0 ? [`trace-${index}`] : [],
        primaryTraceId: activeSessionCount > 0 ? `trace-${index}` : "",
        activeByAgent: activeSessionCount > 0 ? makeAgentCounts({ codex: activeSessionCount }) : makeAgentCounts(),
        eventCount: activeSessionCount > 0 ? activeSessionCount * 2 : 0,
        eventKindCounts: activeSessionCount > 0 ? makeEventCounts({ assistant: activeSessionCount * 2 }) : makeEventCounts(),
        dominantAgent: activeSessionCount > 0 ? ("codex" as const) : ("none" as const),
        dominantEventKind: activeSessionCount > 0 ? ("assistant" as const) : ("none" as const),
        isBreak: false,
      };
    });

    return {
      dateLocal,
      windowStartMs: dateMs,
      windowEndMs: dateMs + 24 * 60 * 60 * 1000,
      totalSessionsInWindow: sessions,
      peakConcurrentSessions: sessions,
      peakConcurrentAtMs: sessions > 0 ? bins[0]?.startMs ?? dateMs : null,
      bins,
    };
  });

  return {
    tzOffsetMinutes: 0,
    dayCount: dayDates.length,
    slotMinutes: SLOT_MINUTES,
    hourStartLocal: 0,
    hourEndLocal: 24,
    startDateLocal: dayDates[0] ?? "2026-02-24",
    endDateLocal: dayDates[dayDates.length - 1] ?? "2026-03-02",
    days,
  };
}

describe("activity year heatmap model", () => {
  it("builds a github-style year grid with daily aggregation", () => {
    const year = makeYearFixture();
    const model = buildActivityYearHeatmapModel(year);
    const cells = model.cells;

    expect(model.dayCount).toBe(7);
    expect(model.weekCount).toBeGreaterThanOrEqual(2);
    expect(model.yearLabel).toContain("2026");
    expect(cells).toHaveLength(7);
    expect(model.weekLabels.length).toBeGreaterThan(0);

    const marchFirst = cells.find((cell) => cell?.dateLocal === "2026-03-01");
    expect(marchFirst).toBeTruthy();
    expect(marchFirst?.totalSessionsInWindow).toBe(4);
    expect(marchFirst?.totalEventCount).toBeGreaterThan(0);
    expect(marchFirst?.level).toBe(4);
  });
});
