import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { GeminiParser } from "./gemini.js";

function makeDiscoveredFile(pathValue = "/tmp/.gemini/tmp/project/chats/session-2026-02-17T01-07-50641617.json"): DiscoveredTraceFile {
  return {
    id: "trace-gemini",
    path: pathValue,
    sourceProfile: "gemini_tmp",
    agentHint: "gemini",
    parserHint: "gemini",
    sizeBytes: 1,
    mtimeMs: 1,
    ino: 1,
    dev: 1,
  };
}

describe("GeminiParser", () => {
  it("recognizes gemini chat session files", () => {
    const parser = new GeminiParser();
    const confidence = parser.canParse(
      makeDiscoveredFile(),
      JSON.stringify({
        projectHash: "abc",
        messages: [{ type: "gemini", toolCalls: [] }],
      }),
    );

    expect(confidence).toBeGreaterThan(0.7);
  });

  it("parses user, reasoning, tool_use, tool_result, and assistant events from chat session JSON", () => {
    const parser = new GeminiParser();
    const text = JSON.stringify(
      {
        sessionId: "50641617-dd96-45e6-9649-0b711b8073ae",
        messages: [
          {
            id: "u1",
            timestamp: "2026-02-17T09:45:49.345Z",
            type: "user",
            content: [{ text: "how is the weather in berlin today?" }],
          },
          {
            id: "a1",
            timestamp: "2026-02-17T09:45:55.244Z",
            type: "gemini",
            content: "",
            toolCalls: [
              {
                id: "google_web_search-1",
                name: "google_web_search",
                args: { query: "weather in Berlin on February 17, 2026" },
                result: [
                  {
                    functionResponse: {
                      id: "google_web_search-1",
                      name: "google_web_search",
                      response: { output: "Cloudy, around -2C with a chance of snow." },
                    },
                  },
                ],
                status: "success",
              },
            ],
            thoughts: [{ text: "I should call web search first." }],
            model: "gemini-3-flash-preview",
            tokens: {
              input: 12204,
              output: 31,
              cached: 0,
              thoughts: 93,
              tool: 0,
              total: 12328,
            },
          },
          {
            id: "a2",
            timestamp: "2026-02-17T09:45:57.249Z",
            type: "gemini",
            content: "Cloudy and cold, around -2C.",
            model: "gemini-3-flash-preview",
            tokens: {
              input: 12727,
              output: 48,
              cached: 0,
              thoughts: 42,
              tool: 0,
              total: 12817,
            },
          },
        ],
      },
      null,
      2,
    );

    const output = parser.parse(makeDiscoveredFile(), text);
    expect(output.agent).toBe("gemini");
    expect(output.parser).toBe("gemini");
    expect(output.sessionId).toBe("50641617-dd96-45e6-9649-0b711b8073ae");
    expect(output.parseError).toBe("");

    expect(output.events.map((event) => event.eventKind)).toEqual([
      "user",
      "reasoning",
      "tool_use",
      "tool_result",
      "assistant",
    ]);

    const toolUse = output.events.find((event) => event.eventKind === "tool_use");
    const toolResult = output.events.find((event) => event.eventKind === "tool_result");
    expect(toolUse?.toolName).toBe("google_web_search");
    expect(toolUse?.toolType).toBe("websearch");
    expect(toolUse?.toolArgsText).toContain("weather in Berlin");
    expect(toolResult?.toolCallId).toBe("google_web_search-1");
    expect(toolResult?.toolResultText).toContain("Cloudy");
  });
});
