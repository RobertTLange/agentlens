import { describe, expect, it, vi } from "vitest";
import { ActivityResponseCache } from "./activity-cache.js";

describe("ActivityResponseCache", () => {
  it("reuses cached day responses until ttl expiry", () => {
    const cache = new ActivityResponseCache(30_000);
    const build = vi.fn(() => ({
      dateLocal: "2026-02-11",
      tzOffsetMinutes: 0,
      binMinutes: 5,
      breakMinutes: 10,
      windowStartMs: 1,
      windowEndMs: 2,
      totalSessionsInWindow: 1,
      peakConcurrentSessions: 1,
      peakConcurrentAtMs: 1,
      totalEventCount: 0,
      bins: [],
    }));

    const first = cache.getOrBuildDay(7, 1_000, {
      dateLocal: "2026-02-11",
      tzOffsetMinutes: 0,
      binMinutes: 5,
      breakMinutes: 10,
    }, build);
    const second = cache.getOrBuildDay(7, 20_000, {
      dateLocal: "2026-02-11",
      tzOffsetMinutes: 0,
      binMinutes: 5,
      breakMinutes: 10,
    }, build);
    const third = cache.getOrBuildDay(7, 31_001, {
      dateLocal: "2026-02-11",
      tzOffsetMinutes: 0,
      binMinutes: 5,
      breakMinutes: 10,
    }, build);

    expect(first).toBe(second);
    expect(third).not.toBe(second);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached week responses when the trace version changes", () => {
    const cache = new ActivityResponseCache(30_000);
    const build = vi
      .fn()
      .mockReturnValueOnce({
        presentation: {
          metric: "sessions",
          color: "#dc2626",
          palette: ["#ffffff", "#fee2e2", "#fca5a5", "#ef4444", "#b91c1c"],
        },
        tzOffsetMinutes: 0,
        dayCount: 7,
        slotMinutes: 30,
        hourStartLocal: 7,
        hourEndLocal: 7,
        startDateLocal: "2026-02-05",
        endDateLocal: "2026-02-11",
        days: [],
      })
      .mockReturnValueOnce({
        presentation: {
          metric: "sessions",
          color: "#dc2626",
          palette: ["#ffffff", "#fee2e2", "#fca5a5", "#ef4444", "#b91c1c"],
        },
        tzOffsetMinutes: 0,
        dayCount: 7,
        slotMinutes: 30,
        hourStartLocal: 7,
        hourEndLocal: 7,
        startDateLocal: "2026-02-05",
        endDateLocal: "2026-02-11",
        days: [],
      });

    const first = cache.getOrBuildWeek(3, 1_000, {
      endDateLocal: "2026-02-11",
      tzOffsetMinutes: 0,
      dayCount: 7,
      slotMinutes: 30,
      hourStartLocal: 7,
      hourEndLocal: 7,
      heatmapMetric: "sessions",
      heatmapColor: "#dc2626",
    }, build);
    const second = cache.getOrBuildWeek(4, 2_000, {
      endDateLocal: "2026-02-11",
      tzOffsetMinutes: 0,
      dayCount: 7,
      slotMinutes: 30,
      hourStartLocal: 7,
      hourEndLocal: 7,
      heatmapMetric: "sessions",
      heatmapColor: "#dc2626",
    }, build);

    expect(first).not.toBe(second);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it("reuses cached year responses until the trace version changes", () => {
    const cache = new ActivityResponseCache(30_000);
    const build = vi
      .fn()
      .mockReturnValueOnce({
        presentation: {
          metric: "sessions",
          color: "#dc2626",
          palette: ["#ffffff", "#fee2e2", "#fca5a5", "#ef4444", "#b91c1c"],
        },
        tzOffsetMinutes: 0,
        dayCount: 80,
        startDateLocal: "2026-01-05",
        endDateLocal: "2026-03-24",
        days: [],
        usageSummary: {
          rows: [],
          totals: {
            totalUniqueSessions: 0,
            totalSessionHours: 0,
            peakAllAgentConcurrency: 0,
            mostUsedAgent: null,
          },
        },
      })
      .mockReturnValueOnce({
        presentation: {
          metric: "sessions",
          color: "#dc2626",
          palette: ["#ffffff", "#fee2e2", "#fca5a5", "#ef4444", "#b91c1c"],
        },
        tzOffsetMinutes: 0,
        dayCount: 80,
        startDateLocal: "2026-01-05",
        endDateLocal: "2026-03-24",
        days: [],
        usageSummary: {
          rows: [],
          totals: {
            totalUniqueSessions: 0,
            totalSessionHours: 0,
            peakAllAgentConcurrency: 0,
            mostUsedAgent: null,
          },
        },
      });

    const first = cache.getOrBuildYear(5, 1_000, {
      endDateLocal: "2026-03-24",
      tzOffsetMinutes: 0,
      dayCount: 80,
      heatmapMetric: "sessions",
      heatmapColor: "#dc2626",
    }, build);
    const second = cache.getOrBuildYear(5, 2_000, {
      endDateLocal: "2026-03-24",
      tzOffsetMinutes: 0,
      dayCount: 80,
      heatmapMetric: "sessions",
      heatmapColor: "#dc2626",
    }, build);
    const third = cache.getOrBuildYear(6, 3_000, {
      endDateLocal: "2026-03-24",
      tzOffsetMinutes: 0,
      dayCount: 80,
      heatmapMetric: "sessions",
      heatmapColor: "#dc2626",
    }, build);

    expect(first).toBe(second);
    expect(third).not.toBe(second);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
