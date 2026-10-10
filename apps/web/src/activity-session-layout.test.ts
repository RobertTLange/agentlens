import { describe, expect, it } from "vitest";
import { buildSessionSegments, sessionColor } from "./ActivityView.js";
import type { ActivityTimelineRowModel } from "./activity-view-model.js";

function rows(bins: string[][]): ActivityTimelineRowModel[] {
  return bins.map((activeTraceIds, index) => ({
    key: String(index), startMs: index * 300_000, endMs: (index + 1) * 300_000,
    timeLabel: String(index), showTimeTick: false, activeTraceIds,
    barHeightPct: 0, fillClassName: "", borderClassName: "", isBreak: false,
    isMultiAgent: activeTraceIds.length > 1, hasNoAgents: activeTraceIds.length === 0,
    primaryTraceId: activeTraceIds[0] ?? "", activeSessionCount: activeTraceIds.length,
    activeAgentCount: 0, eventKindGradient: null, tooltip: "",
  }));
}

describe("activity session layout", () => {
  it("keeps session colors stable and distinct", () => {
    const color = sessionColor("trace-color-a");
    const colors = Array.from({ length: 1000 }, (_, index) => sessionColor(`trace-color-${index}`));
    expect(new Set(colors).size).toBe(colors.length);
    expect(sessionColor("trace-color-a")).toBe(color);
    expect(sessionColor("trace-color-b")).not.toBe(color);
  });
  it("keeps split sessions together, places longest first, and fills gaps", () => {
    const result = buildSessionSegments(rows([
      ["short", "long"], ["short"], ["gap"], ["gap"], ["long", "later"], ["long"],
    ]), undefined);
    expect(result.segments.filter((segment) => segment.traceId === "long").map((segment) => segment.laneIndex)).toEqual([0, 0]);
    expect(result.segments.find((segment) => segment.traceId === "gap")?.laneIndex).toBe(0);
    expect(result.segments.find((segment) => segment.traceId === "short")?.laneIndex).toBe(1);
    expect(result.segments.find((segment) => segment.traceId === "later")?.laneIndex).toBe(1);
    expect(result.laneCount).toBe(2);
  });

  it("checks every box for conflicts and breaks equal-length ties deterministically", () => {
    const result = buildSessionSegments(rows([["b", "a"], [], ["a"], ["b"]]), undefined);
    expect(result.segments.filter((segment) => segment.traceId === "b").map((segment) => segment.laneIndex)).toEqual([0, 0]);
    expect(result.segments.filter((segment) => segment.traceId === "a").map((segment) => segment.laneIndex)).toEqual([1, 1]);
    const tied = buildSessionSegments(rows([["b", "a"]]), undefined);
    expect(tied.segments.find((segment) => segment.traceId === "a")?.laneIndex).toBe(0);
    expect(buildSessionSegments([], undefined).laneCount).toBe(1);
  });
});
