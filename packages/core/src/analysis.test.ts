import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnalysis } from "./analysis.js";
import { mergeConfig } from "./config.js";
import { TraceIndex } from "./traceIndex.js";

async function writeSkill(root: string, name: string): Promise<void> {
  const skillDir = path.join(root, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
}

async function buildAnalysisFixture(): Promise<TraceIndex> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentlens-analysis-"));
  const skillRoot = path.join(root, "skills");
  await writeSkill(skillRoot, "bug-hunt-swarm");
  await writeSkill(skillRoot, "clean-code");
  await writeSkill(path.join(skillRoot, ".system"), "imagegen");
  await writeSkill(skillRoot, "unused-skill");

  const codexRoot = path.join(root, ".codex", "sessions", "2026", "05", "20");
  const claudeRoot = path.join(root, ".claude", "projects", "proj");
  const cursorRoot = path.join(root, ".cursor", "projects", "proj", "agent-transcripts");
  await mkdir(codexRoot, { recursive: true });
  await mkdir(claudeRoot, { recursive: true });
  await mkdir(cursorRoot, { recursive: true });

  const recentTs = new Date(Date.now() - 60_000).toISOString();
  const bugHuntSkillPath = path.join(skillRoot, "bug-hunt-swarm", "SKILL.md");
  const imagegenSkillPath = path.join(skillRoot, ".system", "imagegen", "SKILL.md");
  await writeFile(
    path.join(codexRoot, "codex.jsonl"),
    [
      JSON.stringify({
        timestamp: recentTs,
        type: "session_meta",
        payload: { id: "codex-session", cwd: "/tmp/proj", cli_version: "0.1.0" },
      }),
      JSON.stringify({
        timestamp: recentTs,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Use $clean-code and read ${bugHuntSkillPath} plus ${imagegenSkillPath} plus /tmp/skills/unlisted/SKILL.md`,
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: recentTs,
        type: "response_item",
        payload: {
          type: "function_call",
          id: "spawn-1",
          name: "spawn_agent",
          call_id: "call-spawn-1",
          arguments: JSON.stringify({ agent_type: "worker" }),
        },
      }),
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    path.join(claudeRoot, "claude.jsonl"),
    [
      JSON.stringify({
        timestamp: recentTs,
        type: "assistant",
        sessionId: "claude-session",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "task-1",
              name: "Task",
              input: { subagent_type: "explorer", prompt: "inspect traces" },
            },
          ],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  await writeFile(path.join(cursorRoot, "cursor.txt"), `User: mention ${path.join(skillRoot, "clean-code", "SKILL.md")}\n`, "utf8");

  const config = mergeConfig({
    sessionLogDirectories: [],
    analysis: {
      skillRoots: [skillRoot, path.join(root, "missing-skills")],
      topSessionLimit: 2,
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
        enabled: true,
        roots: [path.join(root, ".claude", "projects")],
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
      cursor_agent_transcripts: {
        name: "cursor_agent_transcripts",
        enabled: true,
        roots: [path.join(root, ".cursor", "projects")],
        includeGlobs: ["**/agent-transcripts/*.txt"],
        excludeGlobs: [],
        maxDepth: 8,
        agentHint: "cursor",
      },
    },
  });

  const index = new TraceIndex(config);
  await index.refresh();
  return index;
}

describe("buildAnalysis", () => {
  it("aggregates configured, unconfigured, inferred skills and subagent spawns", async () => {
    const index = await buildAnalysisFixture();

    const analysis = buildAnalysis(index);

    expect(analysis.summary.traceCount).toBe(3);
    expect(analysis.summary.supportedTraceCount).toBe(2);
    expect(analysis.summary.explicitSkillCount).toBe(3);
    expect(analysis.summary.inferredSkillCount).toBe(1);
    expect(analysis.summary.subagentSpawnCount).toBe(2);
    expect(analysis.inventory.configuredSkills).toEqual(["bug-hunt-swarm", "clean-code", "imagegen", "unused-skill"]);
    expect(analysis.inventory.unusedConfiguredSkills).toEqual(["unused-skill"]);
    expect(analysis.inventory.observedUnconfiguredSkills).toEqual(["unlisted"]);
    expect(analysis.inventory.warnings[0]).toContain("Skill root not found:");

    expect(analysis.skills).toMatchObject([
      { name: "bug-hunt-swarm", inventoryStatus: "configured", explicitCount: 1, inferredCount: 0, totalCount: 1 },
      { name: "clean-code", inventoryStatus: "configured", explicitCount: 0, inferredCount: 1, totalCount: 1 },
      { name: "imagegen", inventoryStatus: "configured", explicitCount: 1, inferredCount: 0, totalCount: 1 },
      { name: "unlisted", inventoryStatus: "unconfigured", explicitCount: 1, inferredCount: 0, totalCount: 1 },
    ]);
    expect(analysis.subagents).toMatchObject([
      { name: "explorer", spawnCount: 1 },
      { name: "worker", spawnCount: 1 },
    ]);
    expect(analysis.byAgent.find((row) => row.agent === "cursor")).toMatchObject({
      detectorSupport: "unsupported",
      sessionCount: 1,
      totalSkillCount: 0,
      subagentSpawnCount: 0,
    });
    expect(analysis.topSessions[0]).toMatchObject({
      agent: "codex",
      explicitSkillCount: 3,
      inferredSkillCount: 1,
      subagentSpawnCount: 1,
    });
  });

  it("filters by source agent and recency window", async () => {
    const index = await buildAnalysisFixture();

    const codexOnly = buildAnalysis(index, { agent: "codex" });
    expect(codexOnly.summary.traceCount).toBe(1);
    expect(codexOnly.summary.subagentSpawnCount).toBe(1);
    expect(codexOnly.byAgent.find((row) => row.agent === "claude")?.sessionCount).toBe(0);

    const noneRecent = buildAnalysis(index, { since: 1 });
    expect(noneRecent.summary.traceCount).toBe(0);
    expect(noneRecent.skills).toEqual([]);
  });

  it("reuses cached per-session analysis across repeated builds", async () => {
    const index = await buildAnalysisFixture();
    let cachedDetailCalls = 0;
    let uncachedDetailCalls = 0;
    const originalGetSessionDetail = index.getSessionDetail.bind(index);
    const originalGetSessionDetailUncached = index.getSessionDetailUncached.bind(index);
    index.getSessionDetail = ((id: string) => {
      cachedDetailCalls += 1;
      return originalGetSessionDetail(id);
    }) as TraceIndex["getSessionDetail"];
    index.getSessionDetailUncached = ((id: string) => {
      uncachedDetailCalls += 1;
      return originalGetSessionDetailUncached(id);
    }) as TraceIndex["getSessionDetailUncached"];

    buildAnalysis(index);
    const firstCallCount = uncachedDetailCalls;
    buildAnalysis(index);

    expect(firstCallCount).toBeGreaterThan(0);
    expect(uncachedDetailCalls).toBe(firstCallCount);
    expect(cachedDetailCalls).toBe(0);
  });
});
