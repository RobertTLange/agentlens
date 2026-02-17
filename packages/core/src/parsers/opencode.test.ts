import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { OpencodeParser } from "./opencode.js";

async function createFixture(): Promise<{ discovered: DiscoveredTraceFile; sessionText: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-opencode-parser-"));
  const sessionId = "ses_test_opencode_1";
  const projectId = "global";

  const sessionDir = path.join(root, "storage", "session", projectId);
  const messageDir = path.join(root, "storage", "message", sessionId);
  const userPartDir = path.join(root, "storage", "part", "msg_user_1");
  const assistantPartDir = path.join(root, "storage", "part", "msg_assistant_1");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(messageDir, { recursive: true });
  await mkdir(userPartDir, { recursive: true });
  await mkdir(assistantPartDir, { recursive: true });

  const sessionPath = path.join(sessionDir, `${sessionId}.json`);
  const session = {
    id: sessionId,
    slug: "gentle-pine",
    version: "1.2.0",
    projectID: projectId,
    directory: "/tmp/opencode-project",
    title: "OpenCode parser fixture",
    time: {
      created: 1_771_000_000_000,
      updated: 1_771_000_005_000,
    },
  };
  await writeFile(sessionPath, JSON.stringify(session, null, 2), "utf8");

  await writeFile(
    path.join(messageDir, "msg_user_1.json"),
    JSON.stringify({
      id: "msg_user_1",
      sessionID: sessionId,
      role: "user",
      time: { created: 1_771_000_000_100 },
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-5.3-codex" },
    }),
    "utf8",
  );
  await writeFile(
    path.join(messageDir, "msg_assistant_1.json"),
    JSON.stringify({
      id: "msg_assistant_1",
      sessionID: sessionId,
      role: "assistant",
      time: { created: 1_771_000_000_200, completed: 1_771_000_000_800 },
      parentID: "msg_user_1",
      modelID: "gpt-5.3-codex",
      providerID: "openai",
      cost: 0.00012,
      tokens: {
        total: 550,
        input: 250,
        output: 200,
        reasoning: 40,
        cache: { read: 60, write: 0 },
      },
    }),
    "utf8",
  );

  await writeFile(
    path.join(userPartDir, "prt_user_text_1.json"),
    JSON.stringify({
      id: "prt_user_text_1",
      sessionID: sessionId,
      messageID: "msg_user_1",
      type: "text",
      text: "run tests and summarize output",
    }),
    "utf8",
  );
  await writeFile(
    path.join(assistantPartDir, "prt_assistant_reasoning_1.json"),
    JSON.stringify({
      id: "prt_assistant_reasoning_1",
      sessionID: sessionId,
      messageID: "msg_assistant_1",
      type: "reasoning",
      text: "Need to run the test suite first.",
      time: { start: 1_771_000_000_210, end: 1_771_000_000_260 },
    }),
    "utf8",
  );
  await writeFile(
    path.join(assistantPartDir, "prt_assistant_tool_1.json"),
    JSON.stringify({
      id: "prt_assistant_tool_1",
      sessionID: sessionId,
      messageID: "msg_assistant_1",
      type: "tool",
      callID: "call_tool_1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "npm test --silent" },
        output: "All tests passed",
        title: "npm test --silent",
        metadata: {},
        time: { start: 1_771_000_000_300, end: 1_771_000_000_600 },
      },
    }),
    "utf8",
  );

  const discovered: DiscoveredTraceFile = {
    id: "trace-opencode-test",
    path: sessionPath,
    sourceProfile: "opencode_storage_session",
    agentHint: "opencode",
    parserHint: "opencode",
    sizeBytes: 0,
    mtimeMs: 0,
    ino: 1,
    dev: 1,
  };

  const sessionText = await readFile(sessionPath, "utf8");
  return { discovered, sessionText };
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

describe("OpencodeParser", () => {
  it("parses OpenCode session, message, and part files into normalized events", async () => {
    const fixture = await createFixture();
    const parser = new OpencodeParser();
    const output = parser.parse(fixture.discovered, fixture.sessionText);

    expect(output.agent).toBe("opencode");
    expect(output.parser).toBe("opencode");
    expect(output.sessionId).toBe("ses_test_opencode_1");
    expect(output.parseError).toBe("");

    expect(output.events.map((event) => event.eventKind)).toEqual([
      "meta",
      "user",
      "reasoning",
      "tool_use",
      "tool_result",
    ]);

    const sessionMeta = output.events[0];
    expect(sessionMeta?.rawType).toBe("session_meta");
    expect(sessionMeta?.preview).toContain("session_meta");

    const toolUse = output.events.find((event) => event.eventKind === "tool_use");
    expect(toolUse?.toolName).toBe("bash");
    expect(toolUse?.toolType).toBe("bash");
    expect(toolUse?.toolArgsText).toContain("npm test");
    expect(toolUse?.toolCallId).toBe("call_tool_1");

    const toolResult = output.events.find((event) => event.eventKind === "tool_result");
    expect(toolResult?.toolCallId).toBe("call_tool_1");
    expect(toolResult?.toolResultText).toContain("All tests passed");
    expect(toolResult?.hasError).toBe(false);
  });

  it("falls back to opencode.db for session_diff-only active sessions", async () => {
    if (!hasSqliteCli()) return;

    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-opencode-parser-db-"));
    const sessionId = "ses_test_opencode_db_1";
    const sessionDiffPath = path.join(root, "storage", "session_diff", `${sessionId}.json`);
    await mkdir(path.dirname(sessionDiffPath), { recursive: true });
    await writeFile(sessionDiffPath, "[]", "utf8");

    const dbPath = path.join(root, "opencode.db");
    const userMessageData = JSON.stringify({
      role: "user",
      time: { created: 1_771_300_000_100 },
      summary: { title: "Greeting", diffs: [] },
    });
    const assistantMessageData = JSON.stringify({
      role: "assistant",
      time: { created: 1_771_300_000_200, completed: 1_771_300_000_900 },
      parentID: "msg_user_db_1",
      modelID: "global.anthropic.claude-haiku-4-5-20251001-v1:0",
      providerID: "amazon-bedrock",
      finish: "stop",
    });
    const userPartData = JSON.stringify({
      type: "text",
      text: "hi there",
    });
    const assistantPartData = JSON.stringify({
      type: "text",
      text: "Hi! Let's ship something great today.",
      time: { start: 1_771_300_000_650, end: 1_771_300_000_650 },
    });

    const sql = [
      "create table session (id text primary key, project_id text not null, parent_id text, slug text not null, directory text not null, title text not null, version text not null, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, revert text, permission text, time_created integer not null, time_updated integer not null, time_compacting integer, time_archived integer);",
      "create table message (id text primary key, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
      "create table part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, time_updated integer not null, data text not null);",
      `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (${sqlQuote(sessionId)}, 'global', 'db-fallback', '/tmp/opencode-db', 'DB fallback session', '1.2.0', 1771300000000, 1771300003000);`,
      `insert into message (id, session_id, time_created, time_updated, data) values ('msg_user_db_1', ${sqlQuote(sessionId)}, 1771300000100, 1771300000100, ${sqlQuote(userMessageData)});`,
      `insert into message (id, session_id, time_created, time_updated, data) values ('msg_assistant_db_1', ${sqlQuote(sessionId)}, 1771300000200, 1771300000900, ${sqlQuote(assistantMessageData)});`,
      `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_user_db_1', 'msg_user_db_1', ${sqlQuote(sessionId)}, 1771300000120, 1771300000120, ${sqlQuote(userPartData)});`,
      `insert into part (id, message_id, session_id, time_created, time_updated, data) values ('prt_assistant_db_1', 'msg_assistant_db_1', ${sqlQuote(sessionId)}, 1771300000650, 1771300000650, ${sqlQuote(assistantPartData)});`,
      "select 1;",
    ].join("\n");
    execFileSync("sqlite3", [dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    const discovered: DiscoveredTraceFile = {
      id: "trace-opencode-db-fallback",
      path: sessionDiffPath,
      sourceProfile: "session_log",
      agentHint: "opencode",
      parserHint: "opencode",
      sizeBytes: 2,
      mtimeMs: 0,
      ino: 1,
      dev: 1,
    };
    const parser = new OpencodeParser();
    const output = parser.parse(discovered, "[]");

    expect(output.agent).toBe("opencode");
    expect(output.sessionId).toBe(sessionId);
    expect(output.parseError).toBe("");
    expect(output.events.map((event) => event.eventKind)).toEqual(["meta", "user", "assistant"]);
    expect(output.events[0]?.rawType).toBe("session_diff_meta");
    expect(output.events[1]?.textBlocks.join(" ")).toContain("hi there");
    expect(output.events[2]?.textBlocks.join(" ")).toContain("ship something great");
  });
});
