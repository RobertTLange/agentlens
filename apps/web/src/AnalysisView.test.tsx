/* @vitest-environment happy-dom */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AnalysisResponse } from "@agentlens/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisView } from "./AnalysisView.js";

function makeAnalysisResponse(overrides: Partial<AnalysisResponse> = {}): AnalysisResponse {
  const base: AnalysisResponse = {
    summary: {
      generatedAtMs: 1_700_000_000_000,
      traceCount: 2,
      supportedTraceCount: 2,
      explicitSkillCount: 1,
      inferredSkillCount: 1,
      totalSkillCount: 2,
      subagentSpawnCount: 1,
      configuredSkillCount: 2,
      unusedConfiguredSkillCount: 1,
      observedUnconfiguredSkillCount: 0,
    },
    inventory: {
      configuredSkills: ["clean-code", "unused-skill"],
      unusedConfiguredSkills: ["unused-skill"],
      observedUnconfiguredSkills: [],
      skillRoots: ["/tmp/skills"],
      warnings: [],
    },
    byAgent: [
      {
        agent: "codex",
        detectorSupport: "supported",
        sessionCount: 2,
        explicitSkillCount: 1,
        inferredSkillCount: 1,
        totalSkillCount: 2,
        subagentSpawnCount: 1,
      },
    ],
    skills: [
      {
        name: "clean-code",
        inventoryStatus: "configured",
        explicitCount: 1,
        inferredCount: 1,
        totalCount: 2,
        sessionCount: 1,
        byAgent: [{ agent: "codex", count: 2 }],
      },
    ],
    subagents: [
      {
        name: "worker",
        spawnCount: 1,
        sessionCount: 1,
        byAgent: [{ agent: "codex", count: 1 }],
      },
    ],
    topSessions: [
      {
        traceId: "trace-a",
        sessionId: "session-a",
        agent: "codex",
        path: "/tmp/trace-a.jsonl",
        lastEventTs: 4_000,
        mtimeMs: 3_900,
        explicitSkillCount: 1,
        inferredSkillCount: 1,
        subagentSpawnCount: 1,
        topSkills: [{ name: "clean-code", count: 2 }],
        topSubagents: [{ name: "worker", count: 1 }],
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...overrides.summary },
    inventory: { ...base.inventory, ...overrides.inventory },
  };
}

let requestedUrls: string[];
let response: AnalysisResponse;
let responseStatus: number;

beforeEach(() => {
  requestedUrls = [];
  response = makeAnalysisResponse();
  responseStatus = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
      requestedUrls.push(url);
      if (responseStatus >= 400) {
        return new Response(JSON.stringify({ error: "bad filter" }), { status: responseStatus });
      }
      return new Response(JSON.stringify(response), { status: responseStatus });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AnalysisView", () => {
  it("defaults to a recent range and shows a full loading panel before data arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
        requestedUrls.push(url);
        return new Promise<Response>(() => undefined);
      }) as typeof fetch,
    );

    render(<AnalysisView onInspectTrace={() => {}} />);

    expect(requestedUrls).toEqual(["/api/analysis?since=7d"]);
    expect((document.querySelectorAll(".analysis-select")[1] as HTMLSelectElement | undefined)?.value).toBe("7d");
    expect(document.querySelector(".analysis-loading-panel")).toBeTruthy();
    expect(document.body.textContent).toContain("Building recent analysis");
    expect(document.body.textContent).toContain("Scanning sessions and skill signals");
  });

  it("renders dashboard visuals, detailed data, warnings, and inspect callback", async () => {
    response = makeAnalysisResponse({
      inventory: {
        configuredSkills: ["clean-code", "unused-skill"],
        unusedConfiguredSkills: ["unused-skill"],
        observedUnconfiguredSkills: [],
        skillRoots: ["/tmp/skills"],
        warnings: ["Skill root not found: /tmp/missing"],
      },
    });
    const onInspectTrace = vi.fn();

    render(<AnalysisView onInspectTrace={onInspectTrace} />);

    await waitFor(() => expect(document.body.textContent).toContain("clean-code"));
    expect(document.body.textContent).toContain("Analysis overview");
    expect(document.body.textContent).toContain("Skill adoption");
    expect(document.body.textContent).toContain("Source mix");
    expect(document.body.textContent).toContain("Subagent roles");
    expect(document.body.textContent).toContain("Session highlights");
    expect(document.body.textContent).toContain("Detailed data");
    expect(document.querySelector(".analysis-skill-bar")).toBeTruthy();
    expect(document.querySelector(".analysis-agent-card")).toBeTruthy();
    expect(document.querySelector(".analysis-subagent-bar")).toBeTruthy();
    expect(document.querySelector(".analysis-session-card")).toBeTruthy();
    expect(document.body.textContent).toContain("2 total uses");
    expect(document.body.textContent).toContain("explicit 1");
    expect(document.body.textContent).toContain("inferred 1");
    expect(document.body.textContent).toContain("unused-skill");
    expect(document.body.textContent).toContain("Skill root not found");

    const inspect = document.querySelector(".analysis-inspect-button");
    if (!(inspect instanceof HTMLButtonElement)) throw new Error("missing inspect button");
    fireEvent.click(inspect);
    expect(onInspectTrace).toHaveBeenCalledWith("trace-a");
  });

  it("updates request parameters from filters", async () => {
    render(<AnalysisView onInspectTrace={() => {}} />);
    await waitFor(() => expect(requestedUrls).toContain("/api/analysis?since=7d"));

    const selects = Array.from(document.querySelectorAll(".analysis-select"));
    fireEvent.change(selects[0] as HTMLSelectElement, { target: { value: "codex" } });
    fireEvent.change(selects[1] as HTMLSelectElement, { target: { value: "24h" } });

    await waitFor(() => expect(requestedUrls.some((url) => url.includes("agent=codex") && url.includes("since=24h"))).toBe(true));
  });

  it("renders empty and error states", async () => {
    response = makeAnalysisResponse({
      summary: {
        generatedAtMs: 1,
        traceCount: 0,
        supportedTraceCount: 0,
        explicitSkillCount: 0,
        inferredSkillCount: 0,
        totalSkillCount: 0,
        subagentSpawnCount: 0,
        configuredSkillCount: 0,
        unusedConfiguredSkillCount: 0,
        observedUnconfiguredSkillCount: 0,
      },
      skills: [],
      subagents: [],
      topSessions: [],
    });

    render(<AnalysisView onInspectTrace={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain("No sessions indexed"));

    cleanup();
    responseStatus = 400;
    render(<AnalysisView onInspectTrace={() => {}} />);
    await waitFor(() => expect(document.body.textContent).toContain("bad filter"));
  });
});
