import { describe, expect, it } from "vitest";
import {
  buildTimelineStripSegments,
  buildTimelineTocRows,
  classForKind,
  eventCardClass,
  iconForAgent,
  kindClassSuffix,
  pathTail,
  sortTimelineItems,
  truncateText,
} from "./view-model.js";

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
        toolType: "bash",
      },
      {
        eventId: "e2",
        index: 2,
        timestampMs: 2,
        eventKind: "assistant",
        tocLabel: "",
        preview: "Done",
        toolType: "",
      },
    ] as unknown as import("@agentlens/contracts").NormalizedEvent[]);

    expect(rows.length).toBe(2);
    expect(rows[0]).toMatchObject({ label: "Tool: Bash", eventKind: "tool_use", colorKey: "tool_use", index: 1 });
    expect(rows[1]?.label).toBe("Done");
  });

  it("creates stable css classes for badges and event cards", () => {
    expect(classForKind("tool_use")).toBe("kind kind-tool_use");
    expect(eventCardClass("tool_result")).toBe("event-card event-kind-tool_result");
    expect(kindClassSuffix("tool_use!!")).toBe("tool_use");
  });

  it("builds chronological strip segments with toc label fallback to preview", () => {
    const segments = buildTimelineStripSegments([
      {
        eventId: "e3",
        index: 3,
        timestampMs: 200,
        eventKind: "assistant",
        tocLabel: "Answer",
        preview: "Assistant response",
        toolType: "",
      },
      {
        eventId: "e1",
        index: 1,
        timestampMs: 100,
        eventKind: "user",
        tocLabel: "",
        preview: "User prompt",
        toolType: "",
      },
      {
        eventId: "e2",
        index: 2,
        timestampMs: 100,
        eventKind: "tool_use",
        tocLabel: "Tool: Bash",
        preview: "Run Bash",
        toolType: "bash",
      },
    ] as unknown as import("@agentlens/contracts").NormalizedEvent[]);

    expect(segments.map((segment) => segment.eventId)).toEqual(["e1", "e2", "e3"]);
    expect(segments[0]).toMatchObject({ label: "User prompt", colorKey: "user" });
    expect(segments[1]).toMatchObject({ label: "Tool: Bash", colorKey: "tool_use" });
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

  it("maps known agents to icon assets and unknown to fallback", () => {
    expect(iconForAgent("codex")).toBe("/icons/openai.svg");
    expect(iconForAgent("cursor")).toBe("/icons/cursor.png");
    expect(iconForAgent("claude")).toBe("/icons/claude.svg");
    expect(iconForAgent("opencode")).toBe("/icons/opencode.png");
    expect(iconForAgent("unknown")).toBeNull();
  });

  it("extracts a stable file/folder tail for collapsed path display", () => {
    expect(pathTail("~/.codex/sessions/2026/02/12/session.jsonl")).toBe("session.jsonl");
    expect(pathTail("C:\\Users\\rob\\.cursor\\logs\\latest\\")).toBe("latest");
    expect(pathTail("trace.log")).toBe("trace.log");
    expect(pathTail("/")).toBe("/");
  });
});
