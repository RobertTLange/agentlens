import type { AgentActivityWeek, AgentKind, EventKind } from "@agentlens/contracts";
import { describe, expect, it } from "vitest";
import { buildActivityWeekHeatmapModel, buildWeeklyUsageSummary } from "./activity-week-heatmap-model.js";

const SLOT_MINUTES = 30;
const SLOT_COUNT = 48;

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
    compaction: 0,
    meta: overrides.meta ?? 0,
  };
}

function makeDayBins(
  windowStartMs: number,
  hotSlots: Record<
    number,
    {
      traceIds: string[];
      activeByAgent: Partial<Record<AgentKind, number>>;
      eventCount: number;
      dominantAgent: AgentKind;
      dominantEventKind: EventKind;
    }
  >,
): AgentActivityWeek["days"][number]["bins"] {
  return Array.from({ length: SLOT_COUNT }, (_, slotIndex) => {
    const startMs = windowStartMs + slotIndex * SLOT_MINUTES * 60_000;
    const hotSlot = hotSlots[slotIndex];
    return {
      startMs,
      endMs: startMs + SLOT_MINUTES * 60_000,
      activeSessionCount: hotSlot?.traceIds.length ?? 0,
      activeTraceIds: hotSlot?.traceIds ?? [],
      primaryTraceId: hotSlot?.traceIds[0] ?? "",
      activeByAgent: makeAgentCounts(hotSlot?.activeByAgent),
      eventCount: hotSlot?.eventCount ?? 0,
      eventKindCounts: makeEventCounts(hotSlot ? { [hotSlot.dominantEventKind]: hotSlot.eventCount } : {}),
      dominantAgent: hotSlot?.dominantAgent ?? "none",
      dominantEventKind: hotSlot?.dominantEventKind ?? "none",
      isBreak: false,
    };
  });
}

function makeWeek(): AgentActivityWeek {
  const dayOneStartMs = Date.UTC(2026, 1, 21, 0, 0, 0);
  const dayTwoStartMs = Date.UTC(2026, 1, 22, 0, 0, 0);
  const dayOneBins = makeDayBins(dayOneStartMs, {
    0: {
      traceIds: ["trace-a", "trace-b"],
      activeByAgent: { codex: 1, claude: 1 },
      eventCount: 2,
      dominantAgent: "codex",
      dominantEventKind: "assistant",
    },
    1: {
      traceIds: ["trace-a"],
      activeByAgent: { codex: 1 },
      eventCount: 1,
      dominantAgent: "codex",
      dominantEventKind: "assistant",
    },
  });
  const dayTwoBins = makeDayBins(dayTwoStartMs, {
    0: {
      traceIds: ["trace-c"],
      activeByAgent: { cursor: 1 },
      eventCount: 1,
      dominantAgent: "cursor",
      dominantEventKind: "tool_use",
    },
    1: {
      traceIds: ["trace-a"],
      activeByAgent: { codex: 1 },
      eventCount: 1,
      dominantAgent: "codex",
      dominantEventKind: "assistant",
    },
  });

  return {
    tzOffsetMinutes: 0,
    dayCount: 2,
    slotMinutes: SLOT_MINUTES,
    hourStartLocal: 0,
    hourEndLocal: 24,
    startDateLocal: "2026-02-21",
    endDateLocal: "2026-02-22",
    days: [
      {
        dateLocal: "2026-02-21",
        windowStartMs: dayOneStartMs,
        windowEndMs: dayOneStartMs + 24 * 60 * 60 * 1000,
        totalSessionsInWindow: 2,
        peakConcurrentSessions: 2,
        peakConcurrentAtMs: dayOneStartMs,
        bins: dayOneBins,
      },
      {
        dateLocal: "2026-02-22",
        windowStartMs: dayTwoStartMs,
        windowEndMs: dayTwoStartMs + 24 * 60 * 60 * 1000,
        totalSessionsInWindow: 2,
        peakConcurrentSessions: 1,
        peakConcurrentAtMs: dayTwoStartMs,
        bins: dayTwoBins,
      },
    ],
  };
}

describe("activity week heatmap model", () => {
  it("builds a full-day heatmap model", () => {
    const week = makeWeek();
    const model = buildActivityWeekHeatmapModel(week);

    expect(model.windowLabel).toBe("Full day");
    expect(model.slotCount).toBe(48);
    expect(model.days).toHaveLength(2);
    expect(model.days[0]?.cells[0]?.timeLabel).toBe("12:00 AM-12:30 AM");
    expect(model.days[0]?.cells[1]?.level).toBe(2);
    expect(model.days[0]?.cells[0]?.activeByAgent.codex).toBe(1);
    expect(model.days[0]?.cells[0]?.activeByAgent.claude).toBe(1);
  });

  it("aggregates weekly per-agent usage metrics", () => {
    const week = makeWeek();
    const summary = buildWeeklyUsageSummary(week, {
      "trace-a": "codex",
      "trace-b": "claude",
      "trace-c": "cursor",
    }, {
      "trace-a": {
        inputTokens: 1000,
        cachedReadTokens: 300,
        cachedCreateTokens: 200,
        outputTokens: 400,
      },
      "trace-b": {
        inputTokens: 500,
        cachedReadTokens: 50,
        cachedCreateTokens: 0,
        outputTokens: 100,
      },
      "trace-c": {
        inputTokens: 300,
        cachedReadTokens: 20,
        cachedCreateTokens: 30,
        outputTokens: 200,
      },
    });

    expect(summary.totals.totalUniqueSessions).toBe(3);
    expect(summary.totals.totalSessionHours).toBeCloseTo(2.5, 6);
    expect(summary.totals.peakAllAgentConcurrency).toBe(2);
    expect(summary.totals.mostUsedAgent).toBe("codex");

    const codex = summary.rows.find((row) => row.agent === "codex");
    const claude = summary.rows.find((row) => row.agent === "claude");
    const cursor = summary.rows.find((row) => row.agent === "cursor");
    expect(codex).toEqual(
      expect.objectContaining({
        sessionHours: 1.5,
        uniqueSessions: 1,
        activeSlots: 3,
        activeDays: 2,
        peakConcurrentSessions: 1,
        inputTokens: 1000,
        cacheTokens: 500,
        outputTokens: 400,
      }),
    );
    expect(claude).toEqual(
      expect.objectContaining({
        sessionHours: 0.5,
        uniqueSessions: 1,
        activeSlots: 1,
        activeDays: 1,
        inputTokens: 500,
        cacheTokens: 50,
        outputTokens: 100,
      }),
    );
    expect(cursor).toEqual(
      expect.objectContaining({
        sessionHours: 0.5,
        uniqueSessions: 1,
        activeSlots: 1,
        activeDays: 1,
        inputTokens: 300,
        cacheTokens: 50,
        outputTokens: 200,
      }),
    );
  });
});
