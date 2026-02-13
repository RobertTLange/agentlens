import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { ClaudeParser } from "./claude.js";

function makeDiscoveredFile(): DiscoveredTraceFile {
  return {
    id: "trace-claude",
    path: "/tmp/.claude/projects/proj/session.jsonl",
    sourceProfile: "claude_projects",
    agentHint: "claude",
    parserHint: "claude",
    sizeBytes: 1,
    mtimeMs: 1,
    ino: 1,
    dev: 1,
  };
}

describe("ClaudeParser", () => {
  it("sets normalized toolType for WebSearch tool_use/tool_result entries", () => {
    const parser = new ClaudeParser();
    const text = [
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-1",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "WebSearch",
              input: { query: "agentlens parser" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "sess-1",
        uuid: "u1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "result text",
            },
          ],
        },
      }),
    ].join("\n");

    const output = parser.parse(makeDiscoveredFile(), text);
    expect(output.events.map((event) => event.eventKind)).toEqual(["tool_use", "tool_result"]);

    const toolUseEvent = output.events[0];
    const toolResultEvent = output.events[1];
    expect(toolUseEvent?.toolType).toBe("websearch");
    expect(toolResultEvent?.toolType).toBe("websearch");
    expect(toolUseEvent?.searchText).toContain("websearch");
    expect(toolResultEvent?.searchText).toContain("websearch");
  });

  it("extracts reasoning preview text from assistant thinking blocks", () => {
    const parser = new ClaudeParser();
    const text = JSON.stringify({
      type: "assistant",
      sessionId: "sess-1",
      uuid: "a1",
      message: {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "The user asked about weather in Moscow. Let me provide a concise answer.",
            signature: "abc",
          },
        ],
      },
    });

    const output = parser.parse(makeDiscoveredFile(), text);
    expect(output.events).toHaveLength(1);

    const reasoningEvent = output.events[0];
    expect(reasoningEvent?.eventKind).toBe("reasoning");
    expect(reasoningEvent?.preview).toContain("The user asked about weather in Moscow");
    expect(reasoningEvent?.tocLabel).toContain("The user asked about weather in Moscow");
    expect(reasoningEvent?.textBlocks[0]).toContain("The user asked about weather in Moscow");
  });
});
