/* @vitest-environment happy-dom */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { AnalysisResponse } from "@agentlens/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisView } from "./AnalysisView.js";
import { buildAnalysisDashboardModel } from "./analysis-view-model.js";

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
    runtime: {
      cache: "miss",
      buildDurationMs: 42,
      cacheAgeMs: null,
      traceCount: 2,
      sinceMs: 604_800_000,
      agent: null,
    },
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
  it("orders source mix by session count without changing the response", () => {
    const analysis = makeAnalysisResponse();
    const base = analysis.byAgent[0]!;
    analysis.byAgent = [
      { ...base, agent: "codex", sessionCount: 2 },
      { ...base, agent: "claude", sessionCount: 10 },
      { ...base, agent: "pi", sessionCount: 2 },
    ];
    expect(buildAnalysisDashboardModel(analysis).agentCards.map((row) => row.agent)).toEqual(["claude", "codex", "pi"]);
    expect(analysis.byAgent.map((row) => row.agent)).toEqual(["codex", "claude", "pi"]);
  });

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
    expect(document.body.textContent).toContain("built in 42ms");
    expect(document.body.textContent).toContain("explicit 1");
    expect(document.body.textContent).toContain("inferred 1");
    expect(document.body.textContent).toContain("unused-skill");
    expect(document.body.textContent).toContain("Skill root not found");

    const inspect = document.querySelector(".analysis-session-card .analysis-inspect-button");
    if (!(inspect instanceof HTMLButtonElement)) throw new Error("missing inspect button");
    fireEvent.click(inspect);
    expect(onInspectTrace).toHaveBeenCalledWith("trace-a");
  });

  it("explains partial coverage and signal confidence and links insights to a session", async () => {
    response.summary.traceCount = 4;
    const onInspectTrace = vi.fn();
    const view = render(<AnalysisView onInspectTrace={onInspectTrace} />);

    await waitFor(() => expect(view.getByLabelText("Useful insights")).toBeTruthy());
    const metrics = Array.from(document.querySelectorAll(".analysis-overview-card"));
    expect(metrics.find((card) => card.textContent?.includes("Detection coverage"))?.textContent).toContain("50%");
    expect(metrics.find((card) => card.textContent?.includes("Explicit skill signals"))?.textContent).toContain("50%");
    expect(view.getByLabelText("How to read this analysis").textContent).toContain("2 sessions have no supported skill detector");
    expect(document.body.textContent).toContain("mentions rather than invocations");
    expect(document.body.textContent).toContain("missing usage alone is not a reason to remove it");
    fireEvent.click(view.getByRole("button", { name: /Inspect highlighted session/ }));
    expect(onInspectTrace).toHaveBeenCalledWith("trace-a");
    expect(document.querySelector("details")?.open).toBe(false);
  });

  it("does not present previous results after a failed filter change and can retry", async () => {
    const view = render(<AnalysisView onInspectTrace={() => {}} />);
    await waitFor(() => expect(view.getByLabelText("Useful insights")).toBeTruthy());
    responseStatus = 400;
    fireEvent.change(view.getByLabelText("Time range"), { target: { value: "30d" } });
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("bad filter"));
    expect(view.queryByLabelText("Useful insights")).toBeNull();
    responseStatus = 200;
    fireEvent.click(view.getByRole("button", { name: "Retry analysis" }));
    await waitFor(() => expect(view.getByLabelText("Useful insights")).toBeTruthy());
    expect(requestedUrls.filter((url) => url.includes("since=30d"))).toHaveLength(2);
  });

  it("uses unavailable percentages when there is no data and requires a custom range", async () => {
    response.summary.traceCount = 0;
    response.summary.supportedTraceCount = 0;
    response.summary.totalSkillCount = 0;
    response.summary.explicitSkillCount = 0;
    const view = render(<AnalysisView onInspectTrace={() => {}} />);
    await waitFor(() => expect(document.querySelectorAll(".analysis-overview-card").length).toBe(6));
    expect(document.querySelectorAll(".analysis-overview-value")[4]?.textContent).toBe("—");
    expect(document.querySelectorAll(".analysis-overview-value")[5]?.textContent).toBe("—");
    fireEvent.change(view.getByLabelText("Time range"), { target: { value: "custom" } });
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Enter a custom range"));
    expect(requestedUrls).toHaveLength(1);
    fireEvent.change(view.getByLabelText("Custom time range"), { target: { value: "14d" } });
    await waitFor(() => expect(requestedUrls).toContain("/api/analysis?since=14d"));
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

  it("labels stale cached analysis responses", async () => {
    response = makeAnalysisResponse({
      runtime: {
        cache: "stale",
        buildDurationMs: 0,
        cacheAgeMs: 31_000,
        traceCount: 2,
        sinceMs: null,
        agent: null,
      },
    });

    render(<AnalysisView onInspectTrace={() => {}} />);

    await waitFor(() => expect(document.body.textContent).toContain("refreshing cached data"));
  });
});
