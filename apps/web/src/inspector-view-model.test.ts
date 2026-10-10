import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@agentlens/contracts";
import { groupInspectorEvents, inspectorEventText } from "./inspector-view-model.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: "call", traceId: "trace", index: 1, offset: 1, timestampMs: 1000,
    sessionId: "session", eventKind: "tool_use", rawType: "function_call", role: "assistant",
    preview: "short preview", textBlocks: [], toolUseId: "id", parentToolUseId: "", toolName: "exec",
    toolType: "exec", toolCallId: "id", functionName: "exec", toolArgsText: "truncated…",
    toolResultText: "", parentEventId: "", tocLabel: "", hasError: false, searchText: "", raw: {},
    ...overrides,
  };
}

describe("inspector event groups", () => {
  it("pairs by call ID and retains the first event in either sort direction", () => {
    const call = event();
    const result = event({ eventId: "result", index: 2, eventKind: "tool_result" });
    const unrelated = event({ eventId: "other", toolCallId: "other", index: 3 });
    expect(groupInspectorEvents([call, result, unrelated])).toEqual([{event:call,call,result},{event:unrelated,call:unrelated}]);
    expect(groupInspectorEvents([unrelated, result, call])).toEqual([{event:unrelated,call:unrelated},{event:result,call,result}]);
  });

  it("preserves unmatched, filtered, ambiguous, cross-trace, and out-of-order events", () => {
    const call = event();
    const result = event({ eventId: "result", index: 2, eventKind: "tool_result" });
    expect(groupInspectorEvents([result])).toHaveLength(1);
    expect(groupInspectorEvents([call, {...result, traceId: "different"}])).toHaveLength(2);
    expect(groupInspectorEvents([call, {...result, index: 0}])).toHaveLength(2);
    expect(groupInspectorEvents([call, result, {...result, eventId: "duplicate", index: 3}])).toHaveLength(3);
    expect(groupInspectorEvents([{...call,toolCallId:"",toolUseId:""},{...result,toolCallId:"",toolUseId:""}])).toHaveLength(2);
  });
});

describe("readable inspector content", () => {
  it("reads full Codex inputs and decodes nested output text instead of showing wrappers", () => {
    const input = "echo " + "a".repeat(500);
    expect(inspectorEventText(event({raw:{payload:{arguments:JSON.stringify({cmd:input})}}}))).toContain(input);
    const output = [{type:"input_text",text:"Script completed"},{type:"input_text",text:JSON.stringify({exit_code:0,output:"First line\nSecond line"})}];
    expect(inspectorEventText(event({eventKind:"tool_result",raw:{payload:{output:JSON.stringify(output)}}}))).toBe("Script completed\n\nFirst line\nSecond line");
  });

  it("selects the matching Claude tool block and preserves malformed output", () => {
    const raw = {message:{content:[{type:"tool_result",tool_use_id:"other",content:"wrong output"},{type:"tool_result",tool_use_id:"id",content:[{type:"text",text:"correct output"}]}]}};
    expect(inspectorEventText(event({eventKind:"tool_result",raw}))).toBe("correct output");
    expect(inspectorEventText(event({eventKind:"tool_result",toolResultText:'[{"text":"unfinished'}))).toBe('[{"text":"unfinished');
  });

  it("preserves message paragraphs and does not expose encrypted reasoning as text", () => {
    expect(inspectorEventText(event({eventKind:"assistant",textBlocks:["First paragraph","- Item one\n- Item two"]}))).toBe("First paragraph\n\n- Item one\n- Item two");
    expect(inspectorEventText(event({eventKind:"reasoning",textBlocks:["[]"],raw:{payload:{encrypted_content:"encrypted",summary:[]}}}))).toBe("Reasoning text unavailable");
    expect(inspectorEventText(event({eventKind:"reasoning",raw:{payload:{summary:[{type:"summary_text",text:"Recorded summary"}]}}}))).toBe("Recorded summary");
  });
});
