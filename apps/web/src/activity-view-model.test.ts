import type { AgentActivityDay, AgentKind, EventKind } from "@agentlens/contracts";
import { describe, expect, it } from "vitest";
import { activityAgentBorderClass, buildActivityViewModel } from "./activity-view-model.js";

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

describe("activity view model", () => {
  it("builds timeline bins with dominance classes and summaries", () => {
    const day: AgentActivityDay = {
      dateLocal: "2026-02-22",
      tzOffsetMinutes: 0,
      binMinutes: 5,
      breakMinutes: 10,
      windowStartMs: Date.UTC(2026, 1, 22, 0, 0, 0),
      windowEndMs: Date.UTC(2026, 1, 22, 0, 20, 0),
      totalSessionsInWindow: 3,
      peakConcurrentSessions: 2,
      peakConcurrentAtMs: Date.UTC(2026, 1, 22, 0, 0, 0),
      totalEventCount: 5,
      bins: [
        {
          startMs: Date.UTC(2026, 1, 22, 0, 0, 0),
          endMs: Date.UTC(2026, 1, 22, 0, 5, 0),
          activeSessionCount: 2,
          activeTraceIds: ["trace-a", "trace-b"],
          primaryTraceId: "trace-a",
          activeByAgent: makeAgentCounts({ codex: 1, claude: 1 }),
          eventCount: 4,
          eventKindCounts: makeEventCounts({ assistant: 2, user: 1, tool_use: 1 }),
          dominantAgent: "claude",
          dominantEventKind: "assistant",
          isBreak: false,
        },
        {
          startMs: Date.UTC(2026, 1, 22, 0, 5, 0),
          endMs: Date.UTC(2026, 1, 22, 0, 10, 0),
          activeSessionCount: 0,
          activeTraceIds: [],
          primaryTraceId: "",
          activeByAgent: makeAgentCounts(),
          eventCount: 0,
          eventKindCounts: makeEventCounts(),
          dominantAgent: "none",
          dominantEventKind: "none",
          isBreak: true,
        },
        {
          startMs: Date.UTC(2026, 1, 22, 0, 10, 0),
          endMs: Date.UTC(2026, 1, 22, 0, 15, 0),
          activeSessionCount: 0,
          activeTraceIds: [],
          primaryTraceId: "",
          activeByAgent: makeAgentCounts(),
          eventCount: 0,
          eventKindCounts: makeEventCounts(),
          dominantAgent: "none",
          dominantEventKind: "none",
          isBreak: true,
        },
        {
          startMs: Date.UTC(2026, 1, 22, 0, 15, 0),
          endMs: Date.UTC(2026, 1, 22, 0, 20, 0),
          activeSessionCount: 1,
          activeTraceIds: ["trace-c"],
          primaryTraceId: "trace-c",
          activeByAgent: makeAgentCounts({ codex: 1 }),
          eventCount: 1,
          eventKindCounts: makeEventCounts({ tool_result: 1 }),
          dominantAgent: "codex",
          dominantEventKind: "tool_result",
          isBreak: false,
        },
      ],
    };

    const view = buildActivityViewModel(day);
    expect(view.rows).toHaveLength(4);
    expect(view.rows[0]?.fillClassName).toBe("kind-assistant");
    expect(view.rows[0]?.borderClassName).toBe("agent-border-claude");
    expect(view.rows[0]?.activeTraceIds).toEqual(["trace-a", "trace-b"]);
    expect(view.rows[0]?.isMultiAgent).toBe(true);
    expect(view.rows[0]?.primaryTraceId).toBe("trace-a");
    expect(view.rows[1]?.fillClassName).toBe("kind-none");
    expect(view.rows[1]?.borderClassName).toBe("agent-border-none");
    expect(view.rows[1]?.activeTraceIds).toEqual([]);
    expect(view.rows[1]?.hasNoAgents).toBe(true);
    expect(view.breakCount).toBe(1);
    expect(view.breakMinutes).toBe(10);
    expect(view.activeBinCount).toBe(2);
    expect(view.inactiveBinCount).toBe(2);
    expect(view.peakActiveAgentsInBin).toBe(2);
  });

  it("maps agent border classes for supported values", () => {
    expect(activityAgentBorderClass("codex")).toBe("agent-border-codex");
    expect(activityAgentBorderClass("unknown")).toBe("agent-border-unknown");
    expect(activityAgentBorderClass("none")).toBe("agent-border-none");
  });
});
