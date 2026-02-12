import { describe, expect, it } from "vitest";
import { buildTimelineTocRows, classForKind, eventCardClass, sortTimelineItems, truncateText } from "./view-model.js";

describe("web view model", () => {
  it("builds timeline TOC rows from events with labels and color keys", () => {
    const rows = buildTimelineTocRows([
      {
        eventId: "e1",
        index: 1,
        timestampMs: 1,
        eventKind: "tool_use",
        tocLabel: "Tool: Bash",
        preview: "Bash run",
      },
      {
        eventId: "e2",
        index: 2,
        timestampMs: 2,
        eventKind: "assistant",
        tocLabel: "",
        preview: "Done",
      },
    ] as unknown as import("@agentlens/contracts").NormalizedEvent[]);

    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ label: "Tool: Bash", eventKind: "tool_use", colorKey: "tool_use", index: 1 });
    expect(rows[1]?.label).toBe("Done");
  });

  it("creates stable css classes for badges and event cards", () => {
    expect(classForKind("tool_use")).toBe("kind kind-tool_use");
    expect(eventCardClass("tool_result")).toBe("event-card event-kind-tool_result");
  });

  it("sorts timeline entries in both directions", () => {
    const items = [
      { index: 2, timestampMs: 2, value: "late" },
      { index: 1, timestampMs: 1, value: "early" },
    ];

    expect(sortTimelineItems(items, "first-latest").map((item) => item.value)).toEqual(["early", "late"]);
    expect(sortTimelineItems(items, "latest-first").map((item) => item.value)).toEqual(["late", "early"]);
  });

  it("truncates long text to a fixed character limit", () => {
    expect(truncateText("short", 10)).toEqual({ value: "short", isTruncated: false });
    expect(truncateText("123456789", 5)).toEqual({ value: "12345", isTruncated: true });
  });
});
