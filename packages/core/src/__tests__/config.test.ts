import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, mergeConfig } from "../config.js";

describe("config", () => {
  it("provides defaults for trace inspector, redaction, cost, and model context windows", () => {
    const config = mergeConfig();
    expect(config.traceInspector.includeMetaDefault).toBe(false);
    expect(config.traceInspector.topModelCount).toBe(3);
    expect(config.redaction.alwaysOn).toBe(true);
    expect(config.cost.enabled).toBe(true);
    expect(config.cost.unknownModelPolicy).toBe("n_a");
    expect(config.cost.modelRates.length).toBeGreaterThan(0);
    expect(config.cost.modelRates.some((rate) => rate.model === "gpt-5.3-codex")).toBe(true);
    expect(config.cost.modelRates.some((rate) => rate.model === "claude-opus-4-5-20251101")).toBe(true);
    expect(config.models.defaultContextWindowTokens).toBeGreaterThan(0);
    expect(config.models.contextWindows.some((entry) => entry.model === "gpt-5.2-codex")).toBe(true);
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
reasoningOutputPer1MUsd = 3.0

[models]
defaultContextWindowTokens = 123456

[[models.contextWindows]]
model = "gpt-5.3-codex"
contextWindowTokens = 272000
`,
      "utf8",
    );

    const config = await loadConfig(configPath);
    expect(config.traceInspector.topModelCount).toBe(2);
    expect(config.redaction.replacement).toBe("[MASK]");
    expect(config.cost.modelRates[0]?.model).toBe("gpt-5.3-codex");
    expect(config.models.defaultContextWindowTokens).toBe(123456);
    expect(config.models.contextWindows[0]?.contextWindowTokens).toBe(272000);
  });
});
