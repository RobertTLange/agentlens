import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@agentlens/contracts";
import {
  archiveObjectKey,
  createArchiveEvent,
  createSessionUid,
  decodeArchiveEvents,
  encodeArchiveEvents,
} from "./remoteArchive.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: "local-trace:1:12",
    traceId: "local-trace",
    index: 1,
    offset: 12,
    timestampMs: 1_700_000_000_000,
    sessionId: "provider-session-1",
    eventKind: "tool_use",
    rawType: "command_execution",
    role: "assistant",
    preview: "pwd",
    textBlocks: [],
    toolUseId: "call-1",
    parentToolUseId: "",
    toolName: "exec_command",
    toolType: "command",
    toolCallId: "call-1",
    functionName: "",
    toolArgsText: '{"cmd":"pwd"}',
    toolResultText: "",
    parentEventId: "",
    tocLabel: "pwd",
    hasError: false,
    searchText: "pwd",
    raw: { cwd: "/private/workspace" },
    ...overrides,
  };
}

describe("remote archive", () => {
  it("uses provider sessions rather than machine paths for stable session identity", () => {
    const first = createSessionUid({
      namespace: "user-namespace",
      provider: "openai",
      providerSessionId: "provider-session-1",
      fallbackFingerprint: "first-machine-path",
    });
    const copied = createSessionUid({
      namespace: "user-namespace",
      provider: "openai",
      providerSessionId: "provider-session-1",
      fallbackFingerprint: "second-machine-path",
    });

    expect(copied).toBe(first);
  });

  it("uses a fallback fingerprint only when a provider session is unavailable", () => {
    const first = createSessionUid({
      namespace: "user-namespace",
      provider: "codex",
      providerSessionId: "",
      fallbackFingerprint: "same-file-header",
    });
    const second = createSessionUid({
      namespace: "user-namespace",
      provider: "codex",
      providerSessionId: "",
      fallbackFingerprint: "different-file-header",
    });

    expect(second).not.toBe(first);
  });

  it("round-trips canonical events without their local trace identity", () => {
    const archiveEvent = createArchiveEvent({
      sessionUid: "session-uid",
      originId: "machine-a",
      sequence: 4,
      observedAtMs: 1_700_000_000_000,
      event: event(),
    });

    const decoded = decodeArchiveEvents(encodeArchiveEvents([archiveEvent]));

    expect(decoded).toEqual([archiveEvent]);
    expect(decoded[0]?.event.traceId).toBe("session-uid");
    expect(decoded[0]?.event.eventId).not.toContain("local-trace");
    expect(decoded[0]?.event.raw).toEqual({});
    expect(decoded[0]?.observedAtMs).toBe(1_700_000_000_000);
  });

  it("creates immutable content-addressed object keys", () => {
    const key = archiveObjectKey("events", "a".repeat(64), "zstd");

    expect(key).toBe(`objects/events/aa/${"a".repeat(64)}.jsonl.zst`);
  });
});
