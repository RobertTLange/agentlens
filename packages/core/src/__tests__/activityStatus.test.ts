import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../config.js";
import { TraceIndex } from "../traceIndex.js";

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentlens-core-activity-"));
}

interface StatusFixtureOptions {
  mtimeMs?: number;
  statusRunningTtlMs?: number;
  statusWaitingTtlMs?: number;
}

async function loadSummaryForCodexLines(
  lines: string[],
  options: StatusFixtureOptions = {},
): Promise<import("@agentlens/contracts").TraceSummary> {
  const root = await createTempRoot();
  const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "12");
  await mkdir(codexDir, { recursive: true });
  const tracePath = path.join(codexDir, "status-test.jsonl");
  await writeFile(tracePath, lines.join("\n"), "utf8");
  if (options.mtimeMs !== undefined) {
    const mtime = new Date(options.mtimeMs);
    await utimes(tracePath, mtime, mtime);
  }

  const config = mergeConfig({
    scan: {
      intervalSeconds: 2,
      recentEventWindow: 400,
      includeMetaDefault: true,
      statusRunningTtlMs: options.statusRunningTtlMs ?? 300_000,
      statusWaitingTtlMs: options.statusWaitingTtlMs ?? 900_000,
    },
    sessionLogDirectories: [],
    sources: {
      codex_home: {
        name: "codex_home",
        enabled: true,
        roots: [path.join(root, ".codex", "sessions")],
        includeGlobs: ["**/*.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "codex",
      },
      claude_projects: {
        name: "claude_projects",
        enabled: false,
        roots: [],
        includeGlobs: ["**/*.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "claude",
      },
      claude_history: {
        name: "claude_history",
        enabled: false,
        roots: [],
        includeGlobs: ["history.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "claude",
      },
      cursor_home: {
        name: "cursor_home",
        enabled: false,
        roots: [],
        includeGlobs: ["**/*.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "cursor",
      },
      opencode_home: {
        name: "opencode_home",
        enabled: false,
        roots: [],
        includeGlobs: ["**/*.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "opencode",
      },
    },
  });

  const index = new TraceIndex(config);
  await index.refresh();
  const summary = index.getSummaries()[0];
  if (!summary) {
    throw new Error("missing trace summary");
  }
  return summary;
}

describe("trace activity status", () => {
  it("marks running when there is an unmatched tool call", async () => {
    const summary = await loadSummaryForCodexLines([
      JSON.stringify({
        timestamp: "2026-02-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "running-status" },
      }),
      JSON.stringify({
        timestamp: "2026-02-12T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_1",
          name: "run_command",
          call_id: "call_1",
          arguments: "{\"command\":\"echo hi\"}",
        },
      }),
    ]);

    expect(summary.activityStatus).toBe("running");
    expect(summary.activityReason).toBe("pending_tool_use_fresh");
  });

  it("downgrades running to idle when running ttl expires", async () => {
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "running-stale-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "fc_1",
            name: "run_command",
            call_id: "call_1",
            arguments: "{\"command\":\"echo hi\"}",
          },
        }),
      ],
      {
        mtimeMs: Date.now() - 120_000,
        statusRunningTtlMs: 10_000,
      },
    );

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("stale_timeout");
  });

  it("marks waiting_input for explicit structured waiting markers", async () => {
    const summary = await loadSummaryForCodexLines([
      JSON.stringify({
        timestamp: "2026-02-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "waiting-status" },
      }),
      JSON.stringify({
        timestamp: "2026-02-12T10:00:01.000Z",
        type: "input_required",
        payload: { status: "awaiting_user_input" },
      }),
    ]);

    expect(summary.activityStatus).toBe("waiting_input");
    expect(summary.activityReason).toBe("explicit_wait_marker_fresh");
  });

  it("keeps waiting_input when meta events follow a wait marker", async () => {
    const summary = await loadSummaryForCodexLines([
      JSON.stringify({
        timestamp: "2026-02-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "waiting-tail-status" },
      }),
      JSON.stringify({
        timestamp: "2026-02-12T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Would you like me to run the full gate now?" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-12T10:00:02.000Z",
        type: "event_msg",
        payload: { type: "meta", status: "posted" },
      }),
    ]);

    expect(summary.activityStatus).toBe("waiting_input");
    expect(summary.activityReason).toBe("explicit_wait_marker_fresh");
  });

  it("clears waiting_input once user responds after wait marker", async () => {
    const summary = await loadSummaryForCodexLines([
      JSON.stringify({
        timestamp: "2026-02-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "waiting-resolved-status" },
      }),
      JSON.stringify({
        timestamp: "2026-02-12T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Would you like me to proceed?" }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-12T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "yes, continue" }],
        },
      }),
    ]);

    expect(summary.activityStatus).toBe("running");
    expect(summary.activityReason).toBe("recent_activity_fresh");
  });

  it("downgrades waiting_input to idle when waiting ttl expires", async () => {
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "waiting-stale-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Waiting for user input to continue." }],
          },
        }),
      ],
      {
        mtimeMs: Date.now() - 120_000,
        statusWaitingTtlMs: 5_000,
      },
    );

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("stale_timeout");
  });

  it("marks running when there is recent session activity", async () => {
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "recent-activity-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Working..." }],
          },
        }),
      ],
      {
        mtimeMs: Date.now(),
      },
    );

    expect(summary.activityStatus).toBe("running");
    expect(summary.activityReason).toBe("recent_activity_fresh");
  });

  it("marks idle when there is no pending tool and no waiting marker", async () => {
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "idle-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "All done." }],
          },
        }),
      ],
      {
        mtimeMs: Date.now() - 1_200_000,
      },
    );

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("no_active_signal");
  });

  it("marks waiting_input in cooldown band between running and idle", async () => {
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "cooldown-waiting-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Task complete." }],
          },
        }),
      ],
      {
        mtimeMs: Date.now() - 90_000,
        statusRunningTtlMs: 10_000,
        statusWaitingTtlMs: 120_000,
      },
    );

    expect(summary.activityStatus).toBe("waiting_input");
    expect(summary.activityReason).toBe("recent_activity_cooling");
  });

  it("recomputes stale status on refresh even without file changes", async () => {
    const root = await createTempRoot();
    const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "12");
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      path.join(codexDir, "status-refresh.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "stale-refresh-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            id: "fc_1",
            name: "run_command",
            call_id: "call_1",
            arguments: "{\"command\":\"echo hi\"}",
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const config = mergeConfig({
      scan: {
        intervalSeconds: 2,
        recentEventWindow: 400,
        includeMetaDefault: true,
        statusRunningTtlMs: 50,
        statusWaitingTtlMs: 300_000,
      },
      sessionLogDirectories: [],
      sources: {
        codex_home: {
          name: "codex_home",
          enabled: true,
          roots: [path.join(root, ".codex", "sessions")],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
        claude_projects: {
          name: "claude_projects",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        claude_history: {
          name: "claude_history",
          enabled: false,
          roots: [],
          includeGlobs: ["history.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "claude",
        },
        cursor_home: {
          name: "cursor_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "cursor",
        },
        opencode_home: {
          name: "opencode_home",
          enabled: false,
          roots: [],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "opencode",
        },
      },
    });

    const index = new TraceIndex(config);
    await index.refresh();
    const initial = index.getSummaries()[0];
    expect(initial?.activityStatus).toBe("running");

    await new Promise((resolve) => {
      setTimeout(resolve, 120);
    });
    await index.refresh();

    const stale = index.getSummaries()[0];
    expect(stale?.activityStatus).toBe("idle");
    expect(stale?.activityReason).toBe("stale_timeout");
  });

  it("returns flat activity bins when latest event is outside current activity window", async () => {
    const nowMs = Date.now();
    const staleMs = nowMs - 3 * 60 * 60_000;
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: new Date(staleMs - 30_000).toISOString(),
          type: "session_meta",
          payload: { id: "activity-bin-stale-window" },
        }),
        JSON.stringify({
          timestamp: new Date(staleMs).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "old output no longer in active window" }],
          },
        }),
      ],
      { mtimeMs: staleMs },
    );

    expect(summary.activityBins).toHaveLength(12);
    expect(summary.activityBins?.every((value) => value === 0)).toBe(true);
  });

  it("computes normalized activity bins for recent event density", async () => {
    const anchorMs = Date.now();
    const summary = await loadSummaryForCodexLines(
      [
        JSON.stringify({
          timestamp: new Date(anchorMs - 61 * 60_000).toISOString(),
          type: "session_meta",
          payload: { id: "activity-bin-test" },
        }),
        JSON.stringify({
          timestamp: new Date(anchorMs - 58 * 60_000).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "old but in range" }],
          },
        }),
        JSON.stringify({
          timestamp: new Date(anchorMs - 7 * 60_000).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "middle bin" }],
          },
        }),
        JSON.stringify({
          timestamp: new Date(anchorMs - 4 * 60_000).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "latest bin 1" }],
          },
        }),
        JSON.stringify({
          timestamp: new Date(anchorMs - 30_000).toISOString(),
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "latest bin 2" }],
          },
        }),
      ],
      { mtimeMs: anchorMs },
    );

    expect(summary.activityBinCount).toBe(12);
    expect(summary.activityWindowMinutes).toBe(60);
    expect(summary.activityBinMinutes).toBe(5);
    expect(summary.activityBins).toHaveLength(12);
    const bins = summary.activityBins ?? [];
    const peak = bins.reduce((max, value) => Math.max(max, value), 0);
    expect(peak).toBeCloseTo(1, 6);
    expect(bins.filter((value) => value > 0).length).toBeGreaterThanOrEqual(2);
    expect(bins.slice(0, 2).some((value) => value > 0)).toBe(true);
    expect(bins.slice(-2).some((value) => value > 0)).toBe(true);
  });

  it("returns flat activity bins when events do not expose timestamps", async () => {
    const summary = await loadSummaryForCodexLines([
      JSON.stringify({
        type: "session_meta",
        payload: { id: "activity-bin-empty" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "no timestamp fields" }],
        },
      }),
    ]);

    expect(summary.activityBins).toHaveLength(12);
    expect(summary.activityBins?.every((value) => value === 0)).toBe(true);
  });
});
