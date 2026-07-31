import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, mergeConfig, mergeConfigWithPricingDefaults } from "../config.js";

describe("config", () => {
  it("provides defaults for trace inspector, redaction, cost, and model context windows", () => {
    const config = mergeConfig();
    expect(config.scan.mode).toBe("adaptive");
    expect(config.scan.intervalMinMs).toBeGreaterThan(0);
    expect(config.scan.intervalMaxMs).toBeGreaterThanOrEqual(config.scan.intervalMinMs);
    expect(config.retention.strategy).toBe("aggressive_recency");
    expect(config.retention.hotTraceCount).toBeGreaterThan(0);
    expect(config.traceInspector.includeMetaDefault).toBe(false);
    expect(config.traceInspector.topModelCount).toBe(3);
    expect(config.redaction.alwaysOn).toBe(true);
    expect(config.pricingSync.enabled).toBe(true);
    expect(config.pricingSync.ttlMs).toBe(86_400_000);
    expect(config.pricingSync.timeoutMs).toBe(5_000);
    expect(config.cost.enabled).toBe(true);
    expect(config.cost.unknownModelPolicy).toBe("n_a");
    expect(config.cost.modelRates.length).toBeGreaterThan(20);
    expect(config.cost.modelRates.some((rate) => rate.model === "gpt-5.3-codex")).toBe(true);
    expect(config.cost.modelRates.some((rate) => rate.model === "gpt-5.4")).toBe(true);
    expect(config.cost.modelRates.some((rate) => rate.model === "claude-sonnet-4.6")).toBe(true);
    expect(config.cost.modelRates.some((rate) => rate.model === "claude-opus-4-5-20251101")).toBe(true);
    expect(config.cost.modelRates.some((rate) => rate.model === "openai/gpt-5.4")).toBe(true);
    expect(config.models.defaultContextWindowTokens).toBeGreaterThan(0);
    expect(config.models.contextWindows.some((entry) => entry.model === "gpt-5.2-codex")).toBe(true);
    expect(config.activityHeatmap.metric).toBe("sessions");
    expect(config.activityHeatmap.color).toBe("#dc2626");
    expect(
      config.models.contextWindows.some(
        (entry) => entry.model === "gpt-5.2-codex" && entry.contextWindowTokens === 400_000,
      ),
    ).toBe(true);
    expect(
      config.models.contextWindows.some(
        (entry) => entry.model === "claude-sonnet-4-5-20250929" && entry.contextWindowTokens === 200_000,
      ),
    ).toBe(true);
    expect(
      config.models.contextWindows.some((entry) => entry.model === "gpt-5.4" && entry.contextWindowTokens === 1_050_000),
    ).toBe(true);
    expect(
      config.models.contextWindows.some(
        (entry) => entry.model === "claude-opus-4.6" && entry.contextWindowTokens === 1_000_000,
      ),
    ).toBe(true);
    expect(
      config.models.contextWindows.some(
        (entry) => entry.model === "claude-sonnet-4.6" && entry.contextWindowTokens === 1_000_000,
      ),
    ).toBe(true);
    expect(
      config.models.contextWindows.some(
        (entry) => entry.model === "claude-haiku-4.5" && entry.contextWindowTokens === 200_000,
      ),
    ).toBe(true);
    const gpt54Rate = config.cost.modelRates.find((rate) => rate.model === "gpt-5.4");
    const sonnet46Rate = config.cost.modelRates.find((rate) => rate.model === "claude-sonnet-4.6");
    expect(gpt54Rate?.inputPer1MUsd).toBe(2.5);
    expect(gpt54Rate?.outputPer1MUsd).toBe(15);
    expect(gpt54Rate?.cachedReadPer1MUsd).toBe(0.25);
    expect(gpt54Rate?.longContextThresholdTokens).toBe(200_000);
    expect(gpt54Rate?.longContextInputPer1MUsd).toBe(5);
    expect(gpt54Rate?.longContextOutputPer1MUsd).toBe(22.5);
    expect(sonnet46Rate?.cachedCreatePer1MUsd).toBe(3.75);
    expect(sonnet46Rate?.cachedCreate5mPer1MUsd).toBe(3.75);
    expect(sonnet46Rate?.cachedCreate1hPer1MUsd).toBe(6);
    expect(config.sessionLogDirectories).toContainEqual({ directory: "~/.gemini", logType: "gemini" });
    expect(config.sessionLogDirectories).toContainEqual({
      directory: "~/.gemini/antigravity-cli",
      logType: "antigravity",
    });
    expect(config.sessionLogDirectories).toContainEqual({ directory: "~/.pi", logType: "pi" });
    expect(config.analysis.skillRoots).toEqual(["~/.codex/skills", "~/.claude/skills"]);
    expect(config.analysis.topSessionLimit).toBe(20);
    expect(config.remoteArchive).toMatchObject({ enabled: false, flushIntervalMs: 60_000, idleFlushMs: 120_000 });
    expect(config.remoteArchive.store).toEqual({ kind: "filesystem", directory: "~/.agentlens/remote-archive" });
    const defaultEnabledSources = [
      "codex_home",
      "claude_projects",
      "claude_history",
      "cursor_agent_transcripts",
      "opencode_storage_session",
      "gemini_tmp",
      "antigravity_brain",
      "pi_agent_sessions",
    ] as const;
    for (const sourceName of defaultEnabledSources) {
      expect(config.sources[sourceName]?.enabled).toBe(true);
    }
    expect(config.sources.claude_projects?.excludeGlobs).toContain("**/subagents/agent-acompact-*.jsonl");
  });

  it("merges self-hosted S3 archive settings without credentials", () => {
    const config = mergeConfig({
      remoteArchive: {
        enabled: true,
        namespace: "personal",
        originId: "laptop",
        rawPublicKeyPath: "~/.agentlens/keys/archive.pub",
        store: {
          kind: "s3",
          bucket: "agentlens",
          endpoint: "https://garage.example.test",
          region: "garage",
          prefix: "personal",
          forcePathStyle: true,
          allowInsecureHttpEndpoint: false,
        },
      },
    });

    expect(config.remoteArchive).toMatchObject({ enabled: true, namespace: "personal", originId: "laptop" });
    expect(config.remoteArchive.store).toEqual({
      kind: "s3",
      bucket: "agentlens",
      endpoint: "https://garage.example.test",
      region: "garage",
      prefix: "personal",
      forcePathStyle: true,
      allowInsecureHttpEndpoint: false,
    });
  });

  it("does not activate remote uploads for malformed booleans or store kinds", () => {
    const malformed = mergeConfig({ remoteArchive: { enabled: "false" as unknown as boolean } });
    expect(malformed.remoteArchive.enabled).toBe(false);
    expect(() => mergeConfig({ remoteArchive: { store: { kind: "invalid" } as never } })).toThrow("store kind");
  });

  it("infers gemini log type from legacy sessionJsonlDirectories paths", () => {
    const config = mergeConfig({
      sessionJsonlDirectories: ["~/.gemini", "~/logs/other"],
    });
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.gemini", logType: "gemini" },
      { directory: "~/logs/other", logType: "unknown" },
    ]);
  });

  it("infers antigravity log type from legacy sessionJsonlDirectories paths", () => {
    const config = mergeConfig({
      sessionJsonlDirectories: ["~/.gemini/antigravity-cli", "~/logs/other"],
    });
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.gemini/antigravity-cli", logType: "antigravity" },
      { directory: "~/logs/other", logType: "unknown" },
    ]);
  });

  it("infers pi log type from legacy sessionJsonlDirectories paths", () => {
    const config = mergeConfig({
      sessionJsonlDirectories: ["~/.pi/agent/sessions", "~/logs/other"],
    });
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.pi/agent/sessions", logType: "pi" },
      { directory: "~/logs/other", logType: "unknown" },
    ]);
  });

  it("auto-injects gemini, antigravity, and pi directories for legacy typed sessionLogDirectories", () => {
    const config = mergeConfig({
      sessionLogDirectories: [
        { directory: "~/.codex", logType: "codex" },
        { directory: "~/.claude", logType: "claude" },
        { directory: "~/.cursor", logType: "cursor" },
      ],
    });
    expect(config.sessionLogDirectories).toEqual([
      { directory: "~/.codex", logType: "codex" },
      { directory: "~/.claude", logType: "claude" },
      { directory: "~/.cursor", logType: "cursor" },
      { directory: "~/.gemini", logType: "gemini" },
      { directory: "~/.gemini/antigravity-cli", logType: "antigravity" },
      { directory: "~/.pi", logType: "pi" },
    ]);
  });

  it("keeps unspecified default sources disabled when explicit sources config is provided", () => {
    const config = mergeConfig({
      sources: {
        codex_home: {
          name: "codex_home",
          enabled: true,
          roots: ["~/tmp/codex"],
          includeGlobs: ["**/*.jsonl"],
          excludeGlobs: [],
          maxDepth: 8,
          agentHint: "codex",
        },
      },
    });
    expect(config.sources.codex_home?.enabled).toBe(true);
    expect(config.sources.claude_projects?.enabled).toBe(false);
    expect(config.sources.claude_history?.enabled).toBe(false);
    expect(config.sources.cursor_agent_transcripts?.enabled).toBe(false);
    expect(config.sources.opencode_storage_session?.enabled).toBe(false);
    expect(config.sources.gemini_tmp?.enabled).toBe(false);
    expect(config.sources.antigravity_brain?.enabled).toBe(false);
    expect(config.sources.pi_agent_sessions?.enabled).toBe(false);
  });

  it("loads new nested sections from TOML", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-config-"));
    const configPath = path.join(root, "config.toml");
    await writeFile(
      configPath,
      `
[traceInspector]
includeMetaDefault = true
topModelCount = 2
showAgentBadges = true
showHealthDiagnostics = false

[redaction]
mode = "strict"
alwaysOn = true
replacement = "[MASK]"
keyPattern = "(?i)token"
valuePattern = "(?i)sk-[a-z0-9_-]+"

[pricingSync]
enabled = false
ttlMs = 1234
timeoutMs = 6789

[cost]
enabled = true
currency = "USD"
unknownModelPolicy = "n_a"

[[cost.modelRates]]
model = "gpt-5.3-codex"
inputPer1MUsd = 1.25
outputPer1MUsd = 2.5
cachedReadPer1MUsd = 0.5
cachedCreatePer1MUsd = 0.75
cachedCreate5mPer1MUsd = 0.75
cachedCreate1hPer1MUsd = 1.25
reasoningOutputPer1MUsd = 3.0
longContextThresholdTokens = 272000
longContextInputPer1MUsd = 2.5
contextWindowTokens = 400000

[models]
defaultContextWindowTokens = 123456

[activityHeatmap]
metric = "output_tokens"
color = "#16a34a"

[[models.contextWindows]]
model = "gpt-5.3-codex"
contextWindowTokens = 272000

[scan]
mode = "fixed"
intervalSeconds = 7
intervalMinMs = 250
intervalMaxMs = 900
fullRescanIntervalMs = 10000
batchDebounceMs = 88
recentEventWindow = 321
includeMetaDefault = false
statusRunningTtlMs = 555
statusWaitingTtlMs = 777

[retention]
strategy = "full_memory"
hotTraceCount = 9
warmTraceCount = 8
maxResidentEventsPerHotTrace = 200
maxResidentEventsPerWarmTrace = 20
`,
      "utf8",
    );

    const config = await loadConfig(configPath);
    expect(config.traceInspector.topModelCount).toBe(2);
    expect(config.redaction.replacement).toBe("[MASK]");
    expect(config.pricingSync.enabled).toBe(false);
    expect(config.pricingSync.ttlMs).toBe(1234);
    expect(config.pricingSync.timeoutMs).toBe(6789);
    const gpt53CodexRate = config.cost.modelRates.find((rate) => rate.model === "gpt-5.3-codex");
    expect(gpt53CodexRate?.cachedCreate1hPer1MUsd).toBe(1.25);
    expect(gpt53CodexRate?.longContextThresholdTokens).toBe(272000);
    expect(gpt53CodexRate?.contextWindowTokens).toBe(400000);
    expect(config.models.defaultContextWindowTokens).toBe(123456);
    expect(config.models.contextWindows.find((entry) => entry.model === "gpt-5.3-codex")?.contextWindowTokens).toBe(272000);
    expect(config.activityHeatmap.metric).toBe("output_tokens");
    expect(config.activityHeatmap.color).toBe("#16a34a");
    expect(config.scan.mode).toBe("fixed");
    expect(config.scan.intervalSeconds).toBe(7);
    expect(config.scan.batchDebounceMs).toBe(88);
    expect(config.retention.strategy).toBe("full_memory");
    expect(config.retention.hotTraceCount).toBe(9);
  });

  it("merges legacy explicit pricing and context entries onto new defaults", () => {
    const config = mergeConfig({
      cost: {
        enabled: true,
        currency: "USD",
        unknownModelPolicy: "n_a",
        modelRates: [
          {
            model: "gpt-5.3-codex",
            inputPer1MUsd: 9,
            outputPer1MUsd: 10,
            cachedReadPer1MUsd: 1,
            cachedCreatePer1MUsd: 2,
            reasoningOutputPer1MUsd: 3,
          },
        ],
      },
      models: {
        defaultContextWindowTokens: 200_000,
        contextWindows: [{ model: "gpt-5.3-codex", contextWindowTokens: 123_000 }],
      },
    });

    const codexRate = config.cost.modelRates.find((rate) => rate.model === "gpt-5.3-codex");
    const gpt54Rate = config.cost.modelRates.find((rate) => rate.model === "gpt-5.4");
    const codexWindow = config.models.contextWindows.find((entry) => entry.model === "gpt-5.3-codex");
    const gpt54Window = config.models.contextWindows.find((entry) => entry.model === "gpt-5.4");

    expect(codexRate?.inputPer1MUsd).toBe(9);
    expect(codexRate?.outputPer1MUsd).toBe(10);
    expect(gpt54Rate?.inputPer1MUsd).toBe(2.5);
    expect(gpt54Rate?.longContextThresholdTokens).toBe(200_000);
    expect(codexWindow?.contextWindowTokens).toBe(123_000);
    expect(gpt54Window?.contextWindowTokens).toBe(1_050_000);
  });

  it("applies runtime pricing defaults before explicit user overrides", () => {
    const config = mergeConfigWithPricingDefaults(
      {
        cost: {
          enabled: true,
          currency: "USD",
          unknownModelPolicy: "n_a",
          modelRates: [
            {
              model: "gpt-5.4",
              inputPer1MUsd: 9,
              outputPer1MUsd: 10,
              cachedReadPer1MUsd: 1,
              cachedCreatePer1MUsd: 2,
              reasoningOutputPer1MUsd: 3,
            },
          ],
        },
        models: {
          defaultContextWindowTokens: 200_000,
          contextWindows: [{ model: "gpt-5.4", contextWindowTokens: 123_000 }],
        },
      },
      {
        modelRates: [
          {
            model: "gpt-5.4",
            inputPer1MUsd: 2.5,
            outputPer1MUsd: 15,
            cachedReadPer1MUsd: 0.25,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
            contextWindowTokens: 1_050_000,
          },
          {
            model: "gemini-3.1-pro-preview",
            inputPer1MUsd: 2,
            outputPer1MUsd: 12,
            cachedReadPer1MUsd: 0.2,
            cachedCreatePer1MUsd: 0,
            reasoningOutputPer1MUsd: 0,
            contextWindowTokens: 1_048_576,
          },
        ],
        contextWindows: [
          { model: "gpt-5.4", contextWindowTokens: 1_050_000 },
          { model: "gemini-3.1-pro-preview", contextWindowTokens: 1_048_576 },
        ],
      },
    );

    expect(config.cost.modelRates.find((rate) => rate.model === "gpt-5.4")?.inputPer1MUsd).toBe(9);
    expect(config.cost.modelRates.find((rate) => rate.model === "gemini-3.1-pro-preview")?.inputPer1MUsd).toBe(2);
    expect(config.models.contextWindows.find((entry) => entry.model === "gpt-5.4")?.contextWindowTokens).toBe(123_000);
    expect(config.models.contextWindows.find((entry) => entry.model === "gemini-3.1-pro-preview")?.contextWindowTokens).toBe(
      1_048_576,
    );
  });

  it("falls back to default activity heatmap values for invalid input", () => {
    const config = mergeConfig({
      activityHeatmap: {
        metric: "bogus" as never,
        color: "red",
      },
    });

    expect(config.activityHeatmap.metric).toBe("sessions");
    expect(config.activityHeatmap.color).toBe("#dc2626");
  });

  it("merges analysis config with sanitized values", () => {
    const config = mergeConfig({
      analysis: {
        skillRoots: ["~/custom-skills", "  ", "~/.codex/skills"],
        topSessionLimit: 7,
      },
    });

    expect(config.analysis.skillRoots).toEqual(["~/custom-skills", "~/.codex/skills"]);
    expect(config.analysis.topSessionLimit).toBe(7);
  });
});
