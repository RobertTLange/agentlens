import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
