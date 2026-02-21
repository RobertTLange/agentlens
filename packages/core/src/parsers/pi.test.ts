import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { PiParser } from "./pi.js";

function makeDiscoveredFile(
  pathValue = "/tmp/.pi/agent/sessions/proj/2026-02-21T09-48-03-994Z_21e08b85-59b6-4acb-9811-a9dead258501.jsonl",
): DiscoveredTraceFile {
  return {
    id: "trace-pi",
    path: pathValue,
    sourceProfile: "session_log",
    agentHint: "pi",
    parserHint: "pi",
    sizeBytes: 1,
    mtimeMs: 1,
    ino: 1,
    dev: 1,
  };
}

describe("PiParser", () => {
  it("recognizes pi session jsonl files", () => {
    const parser = new PiParser();
    const confidence = parser.canParse(
      makeDiscoveredFile(),
      JSON.stringify({
        type: "session",
        id: "21e08b85-59b6-4acb-9811-a9dead258501",
      }),
    );
    expect(confidence).toBeGreaterThan(0.7);
  });

  it("parses meta, user/assistant/reasoning, and tool events", () => {
    const parser = new PiParser();
    const text = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "21e08b85-59b6-4acb-9811-a9dead258501",
        timestamp: "2026-02-21T09:48:03.994Z",
        cwd: "/Users/rob/Dropbox/2026_sakana/agentlens",
      }),
      JSON.stringify({
        type: "model_change",
        id: "092b774a",
        timestamp: "2026-02-21T09:48:03.997Z",
        provider: "amazon-bedrock",
        modelId: "global.anthropic.claude-opus-4-6-v1",
      }),
      JSON.stringify({
        type: "thinking_level_change",
        id: "083f3a11",
        parentId: "092b774a",
        timestamp: "2026-02-21T09:48:03.997Z",
        thinkingLevel: "medium",
      }),
      JSON.stringify({
        type: "message",
        id: "cb6ff685",
        parentId: "083f3a11",
        timestamp: "2026-02-21T09:48:07.077Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hi there" }],
          timestamp: 1771667287065,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "a2e5121f",
        parentId: "cb6ff685",
        timestamp: "2026-02-21T09:48:10.749Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check using a tool." },
            {
              type: "thinking",
              thinking: "Need to call bash for this.",
            },
            {
              type: "toolCall",
              id: "toolu_1",
              name: "bash",
              arguments: { command: "echo hi" },
            },
          ],
          provider: "amazon-bedrock",
          model: "global.anthropic.claude-opus-4-6-v1",
          usage: {
            input: 4030,
            output: 43,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 4073,
            cost: { total: 0.021225 },
          },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "2ed29100",
        parentId: "a2e5121f",
        timestamp: "2026-02-21T09:48:11.488Z",
        message: {
          role: "toolResult",
          toolCallId: "toolu_1",
          toolName: "bash",
          content: [{ type: "text", text: "hi\n" }],
          isError: false,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "563a91c5",
        parentId: "2ed29100",
        timestamp: "2026-02-21T09:48:13.795Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          model: "global.anthropic.claude-opus-4-6-v1",
          usage: {
            input: 1,
            output: 33,
            cacheRead: 0,
            cacheWrite: 4180,
            totalTokens: 4214,
            cost: { total: 0.026955 },
          },
        },
      }),
    ].join("\n");

    const output = parser.parse(makeDiscoveredFile(), text);
    expect(output.agent).toBe("pi");
    expect(output.parser).toBe("pi");
    expect(output.sessionId).toBe("21e08b85-59b6-4acb-9811-a9dead258501");
    expect(output.parseError).toBe("");

    expect(output.events.map((event) => event.eventKind)).toEqual([
      "meta",
      "meta",
      "meta",
      "user",
      "assistant",
      "reasoning",
      "tool_use",
      "tool_result",
      "assistant",
    ]);

    const toolUseEvent = output.events.find((event) => event.eventKind === "tool_use");
    const toolResultEvent = output.events.find((event) => event.eventKind === "tool_result");
    const reasoningEvent = output.events.find((event) => event.eventKind === "reasoning");

    expect(reasoningEvent?.preview).toContain("Need to call bash");
    expect(toolUseEvent?.toolName).toBe("bash");
    expect(toolUseEvent?.toolType).toBe("bash");
    expect(toolUseEvent?.toolCallId).toBe("toolu_1");
    expect(toolUseEvent?.toolArgsText).toContain("echo hi");
    expect(toolResultEvent?.toolCallId).toBe("toolu_1");
    expect(toolResultEvent?.toolResultText).toContain("hi");
  });

  it("falls back to session id from filename when session row is missing", () => {
    const parser = new PiParser();
    const output = parser.parse(
      makeDiscoveredFile(
        "/tmp/.pi/agent/sessions/proj/2026-02-21T09-48-03-994Z_21e08b85-59b6-4acb-9811-a9dead258501.jsonl",
      ),
      JSON.stringify({
        type: "message",
        id: "cb6ff685",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
    );
    expect(output.sessionId).toBe("21e08b85-59b6-4acb-9811-a9dead258501");
  });
});
