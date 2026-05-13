import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentKind, SourceProfileConfig, TraceSummary } from "@agentlens/contracts";
import { describe, expect, it } from "vitest";
import { mergeConfig } from "../config.js";
import { TraceIndex } from "../traceIndex.js";

interface AgentLogFixtureOptions {
  agent: AgentKind;
  relativePath: string;
  sourceName?: string;
  includeGlobs?: string[];
  fileContents: string;
  extraFiles?: Array<{ relativePath: string; contents: string }>;
  mtimeMs?: number;
}

async function createTempRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agentlens-core-terminal-status-"));
}

async function loadSummaryForAgentLog(options: AgentLogFixtureOptions): Promise<TraceSummary> {
  const root = await createTempRoot();
  const tracePath = path.join(root, options.relativePath);
  await mkdir(path.dirname(tracePath), { recursive: true });
  await writeFile(tracePath, options.fileContents, "utf8");
  for (const extraFile of options.extraFiles ?? []) {
    const extraPath = path.join(root, extraFile.relativePath);
    await mkdir(path.dirname(extraPath), { recursive: true });
    await writeFile(extraPath, extraFile.contents, "utf8");
  }
  if (options.mtimeMs !== undefined) {
    const mtime = new Date(options.mtimeMs);
    await utimes(tracePath, mtime, mtime);
  }

  const sourceName = options.sourceName ?? `${options.agent}_fixture`;
  const source: SourceProfileConfig = {
    name: sourceName,
    enabled: true,
    roots: [path.dirname(tracePath)],
    includeGlobs: options.includeGlobs ?? [path.basename(tracePath)],
    excludeGlobs: [],
    maxDepth: 8,
    agentHint: options.agent,
  };
  const config = mergeConfig({
    scan: {
      mode: "adaptive",
      intervalSeconds: 2,
      intervalMinMs: 200,
      intervalMaxMs: 3000,
      fullRescanIntervalMs: 900_000,
      batchDebounceMs: 120,
      recentEventWindow: 400,
      includeMetaDefault: true,
      statusRunningTtlMs: 300_000,
      statusWaitingTtlMs: 900_000,
    },
    sessionLogDirectories: [],
    sources: {
      [sourceName]: source,
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

describe("terminal trace activity status", () => {
  it("marks Codex task_complete sessions idle immediately", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "codex",
      relativePath: ".codex/sessions/2026/02/12/status.jsonl",
      fileContents: [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-complete-status" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "task_started" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "All checks passed." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:04.000Z",
          type: "event_msg",
          payload: { type: "token_count" },
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });

  it("marks Claude end_turn sessions idle despite trailing housekeeping rows", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "claude",
      relativePath: ".claude/projects/status.jsonl",
      fileContents: [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "assistant",
          sessionId: "claude-complete-status",
          message: {
            role: "assistant",
            type: "message",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "Done and verified." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "system",
          sessionId: "claude-complete-status",
        }),
        JSON.stringify({
          type: "last-prompt",
          sessionId: "claude-complete-status",
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });

  it("marks Pi stop final-answer sessions idle", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "pi",
      relativePath: ".pi/agent/sessions/status.jsonl",
      fileContents: [
        JSON.stringify({
          type: "session",
          id: "pi-complete-status",
          timestamp: "2026-02-12T10:00:00.000Z",
          cwd: "/tmp/pi",
        }),
        JSON.stringify({
          type: "message",
          id: "user-1",
          timestamp: "2026-02-12T10:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "Respond exactly" }],
          },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          timestamp: "2026-02-12T10:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "DONE",
                textSignature: "{\"v\":1,\"phase\":\"final_answer\"}",
              },
            ],
            stopReason: "stop",
          },
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });

  it("marks Gemini final text followed by $set idle", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "gemini",
      relativePath: ".gemini/tmp/chats/session-status.jsonl",
      fileContents: [
        JSON.stringify({
          sessionId: "gemini-complete-status",
          startTime: "2026-02-12T10:00:00.000Z",
          lastUpdated: "2026-02-12T10:00:00.000Z",
          kind: "main",
        }),
        JSON.stringify({
          id: "user-1",
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "user",
          content: [{ text: "Respond exactly" }],
        }),
        JSON.stringify({
          id: "assistant-1",
          timestamp: "2026-02-12T10:00:02.000Z",
          type: "gemini",
          content: "DONE",
        }),
        JSON.stringify({
          $set: { lastUpdated: "2026-02-12T10:00:02.000Z" },
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });

  it("marks Cursor final assistant text idle without depending on the text value", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "cursor",
      relativePath: ".cursor/projects/tmp/agent-transcripts/status/status.jsonl",
      fileContents: [
        JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "Summarize the verification result." }],
          },
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [{ type: "text", text: "Verification completed successfully with no follow-up required." }],
          },
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });

  it("marks OpenCode step-finish stop sessions idle", async () => {
    const sessionId = "ses_status_complete";
    const messageId = "msg_status_complete";
    const summary = await loadSummaryForAgentLog({
      agent: "opencode",
      sourceName: "opencode_storage_session",
      relativePath: `storage/session/project/${sessionId}.json`,
      includeGlobs: ["**/*.json"],
      fileContents: JSON.stringify({
        id: sessionId,
        projectID: "project",
        directory: "/tmp/opencode",
        title: "OpenCode status complete",
        time: {
          created: Date.parse("2026-02-12T10:00:00.000Z"),
          updated: Date.parse("2026-02-12T10:00:03.000Z"),
        },
      }),
      extraFiles: [
        {
          relativePath: `storage/message/${sessionId}/${messageId}.json`,
          contents: JSON.stringify({
            id: messageId,
            sessionID: sessionId,
            role: "assistant",
            time: {
              created: Date.parse("2026-02-12T10:00:01.000Z"),
              completed: Date.parse("2026-02-12T10:00:03.000Z"),
            },
          }),
        },
        {
          relativePath: `storage/part/${messageId}/part-text.json`,
          contents: JSON.stringify({
            id: "part-text",
            sessionID: sessionId,
            messageID: messageId,
            type: "text",
            text: "DONE",
            time: {
              start: Date.parse("2026-02-12T10:00:02.000Z"),
              end: Date.parse("2026-02-12T10:00:02.500Z"),
            },
            metadata: { openai: { phase: "final_answer" } },
          }),
        },
        {
          relativePath: `storage/part/${messageId}/part-finish.json`,
          contents: JSON.stringify({
            id: "part-finish",
            sessionID: sessionId,
            messageID: messageId,
            type: "step-finish",
            reason: "stop",
            time: {
              start: Date.parse("2026-02-12T10:00:03.000Z"),
              end: Date.parse("2026-02-12T10:00:03.000Z"),
            },
          }),
        },
      ],
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });

  it("keeps a final assistant question waiting for input", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "codex",
      relativePath: ".codex/sessions/2026/02/12/status.jsonl",
      fileContents: [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-waiting-terminal-prompt" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Should I run the full verification gate now?" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:02.000Z",
          type: "event_msg",
          payload: { type: "task_complete" },
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("waiting_input");
    expect(summary.activityReason).toBe("explicit_wait_marker_fresh");
  });

  it("does not keep an older prompt waiting after a later final answer", async () => {
    const summary = await loadSummaryForAgentLog({
      agent: "codex",
      relativePath: ".codex/sessions/2026/02/12/status.jsonl",
      fileContents: [
        JSON.stringify({
          timestamp: "2026-02-12T10:00:00.000Z",
          type: "session_meta",
          payload: { id: "codex-resolved-terminal-prompt" },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Should I run the full verification gate now?" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done. Verification passed." }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-12T10:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete" },
        }),
      ].join("\n"),
    });

    expect(summary.activityStatus).toBe("idle");
    expect(summary.activityReason).toBe("terminal_done");
  });
});
