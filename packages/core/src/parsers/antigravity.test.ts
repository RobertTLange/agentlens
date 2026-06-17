import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { AntigravityParser } from "./antigravity.js";

function makeDiscoveredFile(
  pathValue = "/tmp/.gemini/antigravity-cli/brain/agy-session-1/.system_generated/logs/transcript.jsonl",
): DiscoveredTraceFile {
  return {
    id: "trace-antigravity",
    path: pathValue,
    sourceProfile: "antigravity_brain",
    agentHint: "antigravity",
    parserHint: "antigravity",
    sizeBytes: 1,
    mtimeMs: 1,
    ino: 1,
    dev: 1,
  };
}

describe("AntigravityParser", () => {
  it("recognizes antigravity transcript jsonl files", () => {
    const parser = new AntigravityParser();
    const confidence = parser.canParse(
      makeDiscoveredFile(),
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-06-17T18:49:16.000Z",
        content: "Plan ready.",
      }),
    );

    expect(confidence).toBeGreaterThan(0.8);
  });

  it("does not override explicit gemini hints", () => {
    const parser = new AntigravityParser();
    const file = {
      ...makeDiscoveredFile(),
      agentHint: "gemini" as const,
      parserHint: "gemini" as const,
    };
    const confidence = parser.canParse(
      file,
      JSON.stringify({
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "Plan ready.",
      }),
    );

    expect(confidence).toBe(0);
  });

  it("parses user, assistant, system, meta, and tool call events", () => {
    const parser = new AntigravityParser();
    const text = [
      JSON.stringify({
        step_index: 0,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        status: "DONE",
        created_at: "2026-06-17T18:49:10.000Z",
        content: "inspect the repo",
      }),
      JSON.stringify({
        step_index: 1,
        source: "SYSTEM",
        type: "CONVERSATION_HISTORY",
        status: "DONE",
        created_at: "2026-06-17T18:49:11.000Z",
        content: "duplicated prior conversation that should not be indexed",
      }),
      JSON.stringify({
        step_index: 2,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-06-17T18:49:12.000Z",
        content: "workspace ready",
      }),
      JSON.stringify({
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-06-17T18:49:13.000Z",
        content: "I will inspect the files.",
      }),
      JSON.stringify({
        step_index: 4,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-06-17T18:49:14.000Z",
        tool_calls: [
          {
            name: "list_dir",
            arguments: { path: ".", explanation: "x".repeat(260) },
          },
        ],
      }),
      JSON.stringify({
        step_index: 5,
        source: "MODEL",
        type: "LIST_DIRECTORY",
        status: "DONE",
        created_at: "2026-06-17T18:49:15.000Z",
        content: "package.json\npackages",
      }),
    ].join("\n");

    const output = parser.parse(makeDiscoveredFile(), text);

    expect(output.agent).toBe("antigravity");
    expect(output.parser).toBe("antigravity");
    expect(output.sessionId).toBe("agy-session-1");
    expect(output.parseError).toBe("");
    expect(output.events.map((event) => event.eventKind)).toEqual([
      "user",
      "meta",
      "system",
      "assistant",
      "tool_use",
      "tool_result",
    ]);
    expect(output.events[0]?.preview).toBe("inspect the repo");
    expect(output.events[3]?.preview).toBe("I will inspect the files.");
    expect(output.events[1]?.searchText).not.toContain("duplicated prior conversation");
    expect(output.events[1]?.raw).not.toHaveProperty("content");
    expect(output.events[4]?.toolName).toBe("list_dir");
    expect(output.events[4]?.toolType).toBe("list_directory");
    expect(output.events[4]?.toolArgsText).toContain("x".repeat(260));
    expect(output.events[5]?.toolCallId).toBe(output.events[4]?.toolCallId);
    expect(output.events[5]?.toolResultText).toContain("package.json");
  });

  it("preserves full long content for search and detail text", () => {
    const parser = new AntigravityParser();
    const longContent = `first line\n${"long output ".repeat(80)}tail marker`;
    const text = [
      JSON.stringify({
        step_index: 0,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-06-17T18:49:10.000Z",
        content: longContent,
      }),
    ].join("\n");

    const output = parser.parse(makeDiscoveredFile(), text);

    expect(output.events[0]?.preview).toBe("first line");
    expect(output.events[0]?.textBlocks).toEqual([longContent]);
    expect(output.events[0]?.searchText).toContain("tail marker");
  });
});
