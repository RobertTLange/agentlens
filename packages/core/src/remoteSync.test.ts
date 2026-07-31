import { describe, expect, it } from "vitest";
import { mergeConfig } from "./config.js";
import { canonicalizeRemoteEvents, validateRemoteArchiveConfig } from "./remoteSync.js";

describe("remote sync configuration", () => {
  it("requires an explicit encryption identity before enabling sync", () => {
    const config = mergeConfig({ remoteArchive: { enabled: true } });
    expect(() => validateRemoteArchiveConfig(config)).toThrow("namespace");
  });

  it("accepts a complete local archive configuration", () => {
    const config = mergeConfig({
      remoteArchive: { enabled: true, namespace: "personal", originId: "laptop", rawPublicKeyPath: "~/archive.pub" },
    });
    expect(() => validateRemoteArchiveConfig(config)).not.toThrow();
  });

  it("enforces redaction before canonical events reach remote storage", () => {
    const config = mergeConfig({ remoteArchive: { originId: "laptop" } });
    const event = { eventId: "e", traceId: "t", index: 0, offset: 0, timestampMs: 1, sessionId: "s", eventKind: "assistant" as const, rawType: "message", role: "assistant", preview: "sk-secret", textBlocks: ["sk-secret"], toolUseId: "", parentToolUseId: "", toolName: "", toolType: "", toolCallId: "", functionName: "", toolArgsText: "sk-secret", toolResultText: "sk-secret", parentEventId: "", tocLabel: "sk-secret", hasError: false, searchText: "sk-secret", raw: { token: "sk-secret" } };
    const encoded = JSON.stringify(canonicalizeRemoteEvents(config, "session", [event], 1));
    expect(encoded).not.toContain("sk-secret");
    expect(encoded).toContain("[REDACTED]");
  });
});
