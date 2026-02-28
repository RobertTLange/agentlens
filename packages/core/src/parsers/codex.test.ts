import { describe, expect, it } from "vitest";
import type { DiscoveredTraceFile } from "../discovery.js";
import { CodexParser } from "./codex.js";

function makeDiscoveredFile(): DiscoveredTraceFile {
  return {
    id: "trace-codex",
    path: "/tmp/.codex/sessions/2026/02/trace.jsonl",
    sourceProfile: "codex_home",
    agentHint: "codex",
    parserHint: "codex",
    sizeBytes: 1,
    mtimeMs: 1,
    ino: 1,
    dev: 1,
  };
}

describe("CodexParser", () => {
  it("normalizes compacted/context_compacted records to compaction events", () => {
    const parser = new CodexParser();
    const text = [
      JSON.stringify({
        timestamp: "2026-02-25T09:06:45.253Z",
        type: "compacted",
        payload: {
          message: "",
          replacement_history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-25T09:06:45.255Z",
        type: "event_msg",
        payload: {
          type: "context_compacted",
        },
      }),
    ].join("\n");

    const output = parser.parse(makeDiscoveredFile(), text);
    expect(output.events).toHaveLength(2);
    expect(output.events.map((event) => event.eventKind)).toEqual(["compaction", "compaction"]);
    expect(output.events.map((event) => event.tocLabel)).toEqual(["Context compacted", "Context compacted"]);
    expect(output.events[0]?.rawType).toBe("compacted");
    expect(output.events[1]?.rawType).toBe("context_compacted");
  });
});
