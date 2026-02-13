import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeConfig, saveConfig, TraceIndex } from "@agentlens/core";
import { createServer, resolveDefaultWebDistPath } from "./app.js";

async function buildFixture(): Promise<{ configPath: string; index: TraceIndex; sessionId: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-server-"));
  const codexRoot = path.join(root, ".codex", "sessions", "2026", "02", "11");
  await mkdir(codexRoot, { recursive: true });

  const sessionId = "server-session-1";
  const tracePath = path.join(codexRoot, "rollout.jsonl");
  await writeFile(
    tracePath,
    [
      JSON.stringify({
        timestamp: "2026-02-11T10:00:00.000Z",
        type: "session_meta",
        payload: { id: sessionId, cwd: "/tmp/proj", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          id: "fc_1",
          name: "run_command",
          call_id: "call_1",
          arguments: "{\"command\":\"echo hi\"}",
        },
      }),
      JSON.stringify({
        timestamp: "2026-02-11T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "hi",
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const config = mergeConfig({
    scan: {
      intervalSeconds: 5,
      recentEventWindow: 200,
      includeMetaDefault: false,
      statusRunningTtlMs: 30_000,
      statusWaitingTtlMs: 300_000,
    },
    sessionLogDirectories: [],
    cost: {
      enabled: true,
      currency: "USD",
      unknownModelPolicy: "n_a",
      modelRates: [
        {
          model: "gpt-5.3-codex",
          inputPer1MUsd: 1,
          outputPer1MUsd: 1,
          cachedReadPer1MUsd: 1,
          cachedCreatePer1MUsd: 1,
          reasoningOutputPer1MUsd: 1,
        },
      ],
    },
    sources: {
      codex_home: {
        name: "codex_home",
        enabled: true,
        roots: [path.join(root, ".codex", "sessions")],
        includeGlobs: ["**/*.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "codex",
      },
      claude_projects: {
        name: "claude_projects",
        enabled: false,
        roots: [],
        includeGlobs: ["**/*.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "claude",
      },
      claude_history: {
        name: "claude_history",
        enabled: false,
        roots: [],
        includeGlobs: ["history.jsonl"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "claude",
      },
    },
  });

  const configPath = path.join(root, "config.toml");
  await saveConfig(config, configPath);

  const index = new TraceIndex(config);
  await index.refresh();

  return { configPath, index, sessionId };
}

describe("server api", () => {
  it("prefers monorepo web dist when both monorepo and packaged builds exist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-web-dist-"));
    const packagedWebDistPath = path.join(root, "packaged-web-dist");
    const monorepoWebDistPath = path.join(root, "monorepo-web-dist");
    await mkdir(packagedWebDistPath, { recursive: true });
    await mkdir(monorepoWebDistPath, { recursive: true });

    expect(resolveDefaultWebDistPath(packagedWebDistPath, monorepoWebDistPath)).toBe(monorepoWebDistPath);
  });

  it("serves overview, trace listing, trace details, and config updates", async () => {
    const fixture = await buildFixture();
    const server = await createServer({
      traceIndex: fixture.index,
      configPath: fixture.configPath,
      enableStatic: false,
    });

    const health = await server.inject({ method: "GET", url: "/api/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true });

    const tracesRes = await server.inject({ method: "GET", url: "/api/traces" });
    expect(tracesRes.statusCode).toBe(200);
    const tracesPayload = tracesRes.json() as { traces: Array<{ id: string; sessionId: string }> };
    expect(tracesPayload.traces.length).toBe(1);

    const traceId = tracesPayload.traces[0]?.id;
    expect(traceId).toBeTruthy();

    const traceById = await server.inject({ method: "GET", url: `/api/trace/${traceId}` });
    expect(traceById.statusCode).toBe(200);
    const detail = traceById.json() as {
      summary: { sessionId: string };
      events: Array<{ toolCallId?: string; toolArgsText?: string; toolResultText?: string }>;
      toc?: Array<{ label: string; eventKind: string }>;
    };
    expect(detail.summary.sessionId).toBe(fixture.sessionId);
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.events[0]?.toolCallId).toBe("call_1");
    expect(detail.events[0]?.toolArgsText).toContain("echo hi");
    expect(detail.events[1]?.toolResultText).toContain("hi");
    expect(detail.toc?.length).toBeGreaterThan(0);
    expect(detail.toc?.[0]?.label).toBe("Tool: run_command");
    expect(detail.toc?.[0]?.eventKind).toBe("tool_use");

    const traceBySession = await server.inject({ method: "GET", url: `/api/trace/${fixture.sessionId}` });
    expect(traceBySession.statusCode).toBe(200);

    const configPatch = await server.inject({
      method: "POST",
      url: "/api/config",
      payload: { scan: { intervalSeconds: 3 }, cost: { enabled: false } },
    });
    expect(configPatch.statusCode).toBe(200);
    const configPayload = configPatch.json() as {
      config: {
        scan: { intervalSeconds: number };
        cost: { enabled: boolean; modelRates: Array<{ model: string }> };
      };
    };
    expect(configPayload.config.scan.intervalSeconds).toBe(3);
    expect(configPayload.config.cost.enabled).toBe(false);
    expect(configPayload.config.cost.modelRates[0]?.model).toBe("gpt-5.3-codex");

    await server.close();
  });
});
