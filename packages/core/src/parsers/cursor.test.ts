import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { CursorParser } from "./cursor.js";

function makeDiscoveredFile(
  filePath = "/tmp/.cursor/projects/proj/agent-transcripts/session-123.txt",
  overrides: Partial<DiscoveredTraceFile> = {},
): DiscoveredTraceFile {
  return {
    id: "trace-cursor",
    path: filePath,
    sourceProfile: "cursor_agent_transcripts",
    agentHint: "cursor",
    parserHint: "cursor",
    sizeBytes: 1,
    mtimeMs: 1,
    ino: 1,
    dev: 1,
    ...overrides,
  };
}

function hasSqliteCli(): boolean {
  try {
    execFileSync("sqlite3", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      maxBuffer: 128 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

describe("CursorParser", () => {
  it("scores cursor transcript paths with high confidence", () => {
    const parser = new CursorParser();
    const score = parser.canParse(
      makeDiscoveredFile(),
      "user:\n<user_query>\nhello\n</user_query>\n\nassistant:\n[Tool call] Read",
    );
    expect(score).toBeGreaterThan(0.7);
  });

  it("parses user/assistant blocks with thinking and tool markers", () => {
    const parser = new CursorParser();
    const text = [
      "user:",
      "<user_query>",
      "add cursor support",
      "</user_query>",
      "",
      "assistant:",
      "[Thinking] Need to inspect parser registry first.",
      "[Tool call] Read",
      "  path: packages/core/src/parsers/index.ts",
      "[Tool result] Read",
      "",
      "Patched parser registry and discovery.",
      "",
      "user:",
      "<user_query>",
      "ship it",
      "</user_query>",
    ].join("\n");

    const output = parser.parse(makeDiscoveredFile(), text);

    expect(output.agent).toBe("cursor");
    expect(output.parser).toBe("cursor");
    expect(output.sessionId).toBe("session-123");
    expect(output.parseError).toBe("");
    expect(output.events.map((event) => event.eventKind)).toEqual([
      "user",
      "reasoning",
      "tool_use",
      "tool_result",
      "assistant",
      "user",
    ]);

    const toolUse = output.events.find((event) => event.eventKind === "tool_use");
    expect(toolUse?.toolName).toBe("Read");
    expect(toolUse?.toolType).toBe("read");
    expect(toolUse?.toolArgsText).toContain("path:");

    const toolResult = output.events.find((event) => event.eventKind === "tool_result");
    expect(toolResult?.toolName).toBe("Read");
    expect(toolResult?.toolCallId).toBe(toolUse?.toolCallId);
  });

  it("returns parseError when transcript has no role blocks", () => {
    const parser = new CursorParser();
    const output = parser.parse(makeDiscoveredFile(), "no role markers here");
    expect(output.events).toEqual([]);
    expect(output.parseError).toContain("missing role blocks");
  });

  it("parses cursor jsonl transcript lines", () => {
    const parser = new CursorParser();
    const file = makeDiscoveredFile("/tmp/.cursor/projects/proj/agent-transcripts/session-jsonl-1.jsonl");
    const text = [
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "<user_query>\nhello\n</user_query>" }],
        },
      }),
      JSON.stringify({
        role: "assistant",
        message: {
          content: [{ type: "text", text: "Hi Robert! Let's ship it." }],
        },
      }),
    ].join("\n");

    const output = parser.parse(file, text);
    expect(output.agent).toBe("cursor");
    expect(output.parser).toBe("cursor");
    expect(output.sessionId).toBe("session-jsonl-1");
    expect(output.parseError).toBe("");
    expect(output.events.map((event) => event.eventKind)).toEqual(["user", "assistant"]);
    expect(output.events[0]?.textBlocks.join("\n")).toContain("hello");
    expect(output.events[1]?.preview).toContain("Let's ship it");
  });

  it("hydrates cursor model and timestamps from chat metadata", async () => {
    if (!hasSqliteCli()) return;

    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-cursor-parser-"));
    const sessionId = "cursor-session-db-1";
    const transcriptPath = path.join(root, ".cursor", "projects", "project-a", "agent-transcripts", `${sessionId}.txt`);
    const storeDbPath = path.join(root, ".cursor", "chats", "chat-hash", sessionId, "store.db");
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    await mkdir(path.dirname(storeDbPath), { recursive: true });

    const createdAt = 1_771_500_000_000;
    const mtimeMs = createdAt + 45_000;
    const model = "claude-4.6-opus-high-thinking";
    const metaHex = Buffer.from(
      JSON.stringify({
        agentId: sessionId,
        createdAt,
        lastUsedModel: model,
      }),
      "utf8",
    ).toString("hex");
    const sql = [
      "create table meta (key text primary key, value text);",
      "create table blobs (id text primary key, data blob);",
      `insert into meta (key, value) values ('0', ${sqlQuote(metaHex)});`,
      "select 1;",
    ].join("\n");
    execFileSync("sqlite3", [storeDbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const text = [
      "user:",
      "<user_query>",
      "status?",
      "</user_query>",
      "",
      "assistant:",
      "[Thinking] checking",
      "[Tool call] Read",
      "  path: src/index.ts",
      "[Tool result] Read",
      "done",
    ].join("\n");

    const parser = new CursorParser();
    const output = parser.parse(makeDiscoveredFile(transcriptPath, { mtimeMs }), text);
    const timestamps = output.events.map((event) => event.timestampMs);
    expect(timestamps.every((value) => typeof value === "number")).toBe(true);
    expect(timestamps[0]).toBe(createdAt);
    expect(timestamps[timestamps.length - 1]).toBe(mtimeMs);
    for (let index = 1; index < timestamps.length; index += 1) {
      expect(timestamps[index] ?? 0).toBeGreaterThanOrEqual(timestamps[index - 1] ?? 0);
    }

    const modeledEvents = output.events.filter(
      (event) =>
        event.eventKind === "assistant" ||
        event.eventKind === "reasoning" ||
        event.eventKind === "tool_use" ||
        event.eventKind === "tool_result",
    );
    expect(modeledEvents.length).toBeGreaterThan(0);
    for (const event of modeledEvents) {
      expect(event.raw.model).toBe(model);
    }
  });
});
