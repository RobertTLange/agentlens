import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedEvent, RagTraceSummaryContent, TraceSummary } from "@agentlens/contracts";
import { mergeConfig } from "./config.js";
import { buildPromptInput, buildRagCorpus, buildTraceDocuments } from "./ragCorpus.js";
import { runHeadlessSummary } from "./ragHeadless.js";
import { RagStore } from "./ragStore.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentlens-rag-test-"));
  tmpDirs.push(dir);
  return dir;
}

function testConfig(dbPath: string, extra: Record<string, unknown> = {}) {
  return mergeConfig({
    rag: {
      dbPath,
      daemonPidPath: path.join(path.dirname(dbPath), "rag.pid"),
      daemonLogPath: path.join(path.dirname(dbPath), "rag.log"),
      embeddingBackend: "disabled",
      ...extra,
    },
  });
}

function summary(overrides: Partial<TraceSummary> = {}): TraceSummary {
  return {
    id: "trace-1",
    sourceProfile: "test",
    path: "/tmp/trace.jsonl",
    agent: "codex",
    parser: "codex",
    sessionId: "session-1",
    sizeBytes: 100,
    mtimeMs: 1_700_000_000_000,
    firstEventTs: 1_700_000_000_000,
    lastEventTs: 1_700_000_001_000,
    eventCount: 2,
    parseable: true,
    parseError: "",
    errorCount: 0,
    toolUseCount: 1,
    toolResultCount: 0,
    compactionCount: 0,
    lastCompactionTs: null,
    unmatchedToolUses: 0,
    unmatchedToolResults: 0,
    activityStatus: "idle",
    activityReason: "test",
    eventKindCounts: {
      system: 0,
      assistant: 1,
      user: 1,
      tool_use: 0,
      tool_result: 0,
      reasoning: 0,
      compaction: 0,
      meta: 0,
    },
    residentTier: "hot",
    isMaterialized: true,
    ...overrides,
  };
}

function event(index: number, text: string, overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    eventId: `event-${index}`,
    traceId: "trace-1",
    index,
    offset: index,
    timestampMs: 1_700_000_000_000 + index,
    sessionId: "session-1",
    eventKind: index === 0 ? "user" : "assistant",
    rawType: "message",
    role: index === 0 ? "user" : "assistant",
    preview: text,
    textBlocks: [text],
    toolUseId: "",
    parentToolUseId: "",
    toolName: "",
    toolType: "",
    toolCallId: "",
    functionName: "",
    toolArgsText: "",
    toolResultText: "",
    parentEventId: "",
    tocLabel: text,
    hasError: false,
    searchText: text,
    raw: { secret: "raw-not-for-rag" },
    ...overrides,
  };
}

function content(): RagTraceSummaryContent {
  return {
    title: "Fixed failing tests",
    userGoal: "Find the regression",
    outcome: "Patched the parser",
    keySteps: ["Read logs", "Ran tests"],
    filesOrProjects: ["packages/core"],
    toolsUsed: ["npm test"],
    errorsOrBlockers: ["Initial failure"],
    decisions: ["Keep lexical fallback"],
    workflowObservations: ["Tests caught it"],
    followups: ["Watch CI"],
    searchKeywords: ["parser", "tests"],
  };
}

describe("rag corpus", () => {
  it("builds prompts from normalized redacted fields without raw payloads", () => {
    const detail = { summary: summary(), events: [event(0, "token [REDACTED]")] };
    const input = buildPromptInput(detail);

    expect(input.prompt).toContain("token [REDACTED]");
    expect(input.prompt).not.toContain("raw-not-for-rag");
    expect(input.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("chunks traces without splitting individual events", () => {
    const docs = buildTraceDocuments(summary(), [event(0, "a".repeat(20)), event(1, "b".repeat(20))], 30);

    expect(docs).toHaveLength(2);
    expect(docs[0]?.content).toContain("#0");
    expect(docs[0]?.content).not.toContain("#1");
    expect(docs[1]?.content).toContain("#1");
  });
});

describe("rag store", () => {
  it("migrates idempotently, indexes lexical documents, and returns status counts", async () => {
    const dir = await tempDir();
    const config = testConfig(path.join(dir, "rag.db"));
    const store = new RagStore(config);
    store.migrate();
    const corpus = buildRagCorpus({ summary: summary(), events: [event(0, "failed parser test")] }, content());

    store.upsertSession({
      summary: summary(),
      fingerprint: corpus.fingerprint,
      status: "complete",
      content: content(),
      summaryText: corpus.summaryText,
      summaryModel: "fake",
      summaryGeneratedAtMs: 1,
      nowMs: 2,
    });
    store.replaceDocuments("trace-1", corpus.documents, 3);

    expect(store.getStatus(config).sessions.complete).toBe(1);
    expect(store.getStatus(config).documents).toBeGreaterThan(0);
    expect(store.search({ query: "parser", mode: "lexical", limit: 5, candidateMultiplier: 4, rrfK: 60 })[0]?.traceId).toBe("trace-1");
    store.close();
  });

  it("preserves the last complete summary after a failed refresh", async () => {
    const dir = await tempDir();
    const config = testConfig(path.join(dir, "rag.db"));
    const store = new RagStore(config);
    store.upsertSession({
      summary: summary(),
      fingerprint: "old",
      status: "complete",
      content: content(),
      summaryText: "old summary",
      summaryModel: "fake",
      summaryGeneratedAtMs: 1,
      nowMs: 2,
    });
    store.upsertSession({
      summary: summary({ mtimeMs: 1_700_000_002_000 }),
      fingerprint: "new",
      status: "failed",
      error: "bad json",
      nowMs: 3,
    });

    const record = store.getSession("trace-1");
    expect(record?.status).toBe("failed");
    expect(record?.summary?.title).toBe("Fixed failing tests");
    expect(record?.summaryText).toBe("old summary");
    store.close();
  });
});

describe("headless summarization", () => {
  it("uses argument arrays with read-only permission and parses strict JSON output", async () => {
    const dir = await tempDir();
    const executable = path.join(dir, "fake-headless.js");
    const argsPath = path.join(dir, "args.json");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));
const out = ${JSON.stringify(JSON.stringify(content()))};
console.log(JSON.stringify({ output: out }));
`,
      "utf8",
    );
    await chmod(executable, 0o755);
    const config = testConfig(path.join(dir, "rag.db"), { headlessExecutable: executable });

    const result = await runHeadlessSummary(config, "redacted prompt");
    const args = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(argsPath, "utf8"))) as string[];

    expect(args).toContain("--prompt-file");
    expect(args).toContain("--allow");
    expect(args).toContain("read-only");
    expect(result.content.title).toBe("Fixed failing tests");
  });
});
