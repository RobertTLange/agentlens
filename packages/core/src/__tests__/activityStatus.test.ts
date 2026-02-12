import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../config.js";
import { TraceIndex } from "../traceIndex.js";

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentlens-core-activity-"));
}

async function loadSummaryForCodexLines(lines: string[]): Promise<import("@agentlens/contracts").TraceSummary> {
  const root = await createTempRoot();
  const codexDir = path.join(root, ".codex", "sessions", "2026", "02", "12");
  await mkdir(codexDir, { recursive: true });
  await writeFile(path.join(codexDir, "status-test.jsonl"), lines.join("\n"), "utf8");

  const config = mergeConfig({
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
    expect(summary.activityReason).toBe("pending_tool_use");
  });

  it("marks waiting_input when latest event carries an explicit waiting marker", async () => {
    const summary = await loadSummaryForCodexLines([
      JSON.stringify({
        timestamp: "2026-02-12T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "waiting-status" },
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
    ]);

    expect(summary.activityStatus).toBe("waiting_input");
    expect(summary.activityReason).toBe("explicit_wait_marker");
  });

  it("marks idle when there is no pending tool and no waiting marker", async () => {
    const summary = await loadSummaryForCodexLines([
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
    ]);

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("no_active_signal");
  });
});
