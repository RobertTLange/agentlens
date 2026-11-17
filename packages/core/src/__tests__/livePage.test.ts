import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeConfig } from "../config.js";
import { TraceIndex } from "../traceIndex.js";

function codexLog(sessionId: string, messages: number): string {
  const lines = [
    { timestamp: new Date(Date.UTC(2026, 1, 11, 10, 0, 0)).toISOString(), type: "session_meta", payload: { id: sessionId, cwd: "/tmp/p" } },
  ];
  for (let i = 0; i < messages; i += 1) {
    lines.push({
      timestamp: new Date(Date.UTC(2026, 1, 11, 10, 0, i + 1)).toISOString(),
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `message ${i}` }] },
    } as never);
  }
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

function claudeRow(sessionId: string, text: string, second: number): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    timestamp: new Date(Date.UTC(2026, 1, 11, 10, 0, second)).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function onlyRoot(root: string, agentHint: "codex" | "claude") {
  const disabled = { enabled: false, roots: [], includeGlobs: ["**/*.jsonl"], excludeGlobs: [], maxDepth: 8 };
  return mergeConfig({
    sessionLogDirectories: [],
    sources: {
      main: { ...disabled, name: "main", enabled: true, roots: [root], agentHint },
      claude_projects: { ...disabled, name: "claude_projects", agentHint: "claude" },
      claude_history: { ...disabled, name: "claude_history", includeGlobs: ["history.jsonl"], agentHint: "claude" },
    },
  });
}

describe("live trace pages", () => {
  it("tails forward from a cursor with after", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-live-"));
    await writeFile(path.join(root, "s.jsonl"), codexLog("session-after-1", 6), "utf8");
    const index = new TraceIndex(onlyRoot(root, "codex"));
    await index.refresh();
    const id = index.getSummaries()[0]!.id;

    const full = index.getTracePage(id, { limit: 100 });
    const total = Number(full.liveCursor);
    expect(full.afterCursor).toBeUndefined();

    const tail = index.getTracePage(id, { after: String(total - 2), limit: 100 });
    expect(tail.events.map((event) => event.eventId)).toEqual(full.events.slice(-2).map((event) => event.eventId));
    expect(tail.afterCursor).toBe(String(total - 2));
    expect(tail.liveCursor).toBe(String(total));

    const capped = index.getTracePage(id, { after: "0", limit: 2 });
    expect(capped.events.map((event) => event.eventId)).toEqual(full.events.slice(0, 2).map((event) => event.eventId));

    expect(index.getTracePage(id, { after: String(total) }).events).toEqual([]);
    expect(index.getTracePage(id, { after: "999999" }).afterCursor).toBe(String(total));
    expect(index.getTracePage(id, { after: "-5", limit: 1 }).afterCursor).toBe("0");
  });

  it("resolves a session id to the main log, not a subagent log sharing it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-live-"));
    const sessionId = "0b0f3c55-1111-2222-3333-444455556666";
    const project = path.join(root, "-Users-me-repo");
    const subagents = path.join(project, sessionId, "subagents");
    await mkdir(subagents, { recursive: true });
    const main = path.join(project, `${sessionId}.jsonl`);
    const sub = path.join(subagents, "agent-abc.jsonl");
    await writeFile(main, claudeRow(sessionId, "main", 1), "utf8");
    await writeFile(sub, claudeRow(sessionId, "sub", 2), "utf8");
    // The subagent log is newer, so recency alone would pick it.
    await utimes(main, new Date(1_000_000), new Date(1_000_000));
    await utimes(sub, new Date(2_000_000), new Date(2_000_000));

    const index = new TraceIndex(onlyRoot(root, "claude"));
    await index.refresh();

    const matches = index.getSummaries().filter((summary) => summary.sessionId === sessionId);
    expect(matches.length).toBe(2);
    const resolved = index.resolveId(sessionId);
    expect(index.getSummaries().find((summary) => summary.id === resolved)?.path).toBe(main);
  });

  it("hydrates a session still pending startup hydration when asked for by id", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-live-"));
    for (let i = 0; i < 130; i += 1) {
      const file = path.join(root, `rollout-${String(i).padStart(3, "0")}-session-${String(i).padStart(4, "0")}x.jsonl`);
      await writeFile(file, codexLog(`session-${String(i).padStart(4, "0")}x`, 1), "utf8");
      const mtime = new Date(Date.UTC(2026, 1, 11, 10, 0, 0) + (130 - i) * 1_000);
      await utimes(file, mtime, mtime);
    }
    // Keep background hydration from racing the request.
    const background = vi
      .spyOn(TraceIndex.prototype as unknown as { hydratePendingBatch: () => Promise<void> }, "hydratePendingBatch")
      .mockResolvedValue(undefined);
    const index = new TraceIndex(onlyRoot(root, "codex"));
    try {
      await index.start();
      const oldest = "session-0129x";
      expect(() => index.resolveId(oldest)).toThrow(/unknown trace\/session/);

      expect(await index.hydrateMatching("short")).toBe(false);
      expect(await index.hydrateMatching(oldest)).toBe(true);
      expect(index.getTracePage(index.resolveId(oldest)).summary.sessionId).toBe(oldest);
      expect(await index.hydrateMatching(oldest)).toBe(false);
    } finally {
      background.mockRestore();
      index.stop();
    }
  });
});
