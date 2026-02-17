/* @vitest-environment happy-dom */

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { NormalizedEvent, OverviewStats, TracePage, TraceSummary } from "@agentlens/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

class MockEventSource {
  static instances: MockEventSource[] = [];

  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  private listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(_url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const normalized =
      typeof listener === "function"
        ? (listener as (event: MessageEvent) => void)
        : ((event: MessageEvent) => listener.handleEvent(event as unknown as Event));
    const bucket = this.listeners.get(type);
    if (bucket) {
      bucket.add(normalized);
      return;
    }
    this.listeners.set(type, new Set([normalized]));
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const bucket = this.listeners.get(type);
    if (!bucket) return;
    const normalized =
      typeof listener === "function"
        ? (listener as (event: MessageEvent) => void)
        : ((event: MessageEvent) => listener.handleEvent(event as unknown as Event));
    bucket.delete(normalized);
    if (bucket.size === 0) {
      this.listeners.delete(type);
    }
  }

  close(): void {
    this.listeners.clear();
  }

  emit(type: string, payload: unknown): void {
    const event = { data: JSON.stringify({ payload }) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makeTrace(
  id: string,
  mtimeMs: number,
  activityStatus: TraceSummary["activityStatus"] = "idle",
): TraceSummary {
  return {
    id,
    sourceProfile: "session_log",
    path: `/tmp/${id}.jsonl`,
    agent: "codex",
    parser: "codex",
    sessionId: `session-${id}`,
    sizeBytes: 100,
    mtimeMs,
    firstEventTs: mtimeMs - 60_000,
    lastEventTs: mtimeMs,
    eventCount: 2,
    parseable: true,
    parseError: "",
    errorCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    unmatchedToolUses: 0,
    unmatchedToolResults: 0,
    activityStatus,
    activityReason: `fixture_${activityStatus}`,
    activityBins: [0, 0, 0.25, 0.4, 0.6, 0.5, 0.35, 0.2, 0.15, 0.3, 0.5, 0.8],
    activityBinsMode: "time",
    activityWindowMinutes: 60,
    activityBinMinutes: 5,
    activityBinCount: 12,
    tokenTotals: {
      inputTokens: 1000,
      cachedReadTokens: 300,
      cachedCreateTokens: 200,
      outputTokens: 400,
      reasoningOutputTokens: 120,
      totalTokens: 2020,
    },
    modelTokenSharesTop: [
      { model: "gpt-5.3-codex", tokens: 1800, percent: 89.1089 },
      { model: "gpt-5.2-codex", tokens: 220, percent: 10.8911 },
    ],
    modelTokenSharesEstimated: true,
    contextWindowPct: 18.2,
    costEstimateUsd: null,
    residentTier: "hot",
    isMaterialized: true,
    eventKindCounts: {
      system: 0,
      assistant: 1,
      user: 1,
      tool_use: 0,
      tool_result: 0,
      reasoning: 0,
      meta: 0,
    },
  };
}

function makeOverview(traceCount: number): OverviewStats {
  return {
    traceCount,
    sessionCount: traceCount,
    eventCount: traceCount * 2,
    errorCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    byAgent: { codex: traceCount },
    byEventKind: {
      system: 0,
      assistant: traceCount,
      user: traceCount,
      tool_use: 0,
      tool_result: 0,
      reasoning: 0,
      meta: 0,
    },
    updatedAtMs: 1_000,
  };
}

function makeTracePage(summary: TraceSummary): TracePage {
  return makeTracePageWithEvents(summary, []);
}

function makeTracePageWithEvents(summary: TraceSummary, events: NormalizedEvent[]): TracePage {
  return {
    summary,
    events,
    toc: events.map((event) => ({
      eventId: event.eventId,
      index: event.index,
      timestampMs: event.timestampMs,
      eventKind: event.eventKind,
      label: event.tocLabel || event.preview,
      colorKey: event.eventKind,
      toolType: event.toolType,
    })),
    nextBefore: "",
    liveCursor: "",
  };
}

function makeEvent(eventId: string, raw: Record<string, unknown>): NormalizedEvent {
  return {
    eventId,
    traceId: "trace-c",
    index: 4,
    offset: 4,
    timestampMs: 1_000,
    sessionId: "session-trace-c",
    eventKind: "assistant",
    rawType: "message",
    role: "assistant",
    preview: "expanded json",
    textBlocks: ["expanded json"],
    toolUseId: "",
    parentToolUseId: "",
    toolName: "",
    toolType: "",
    toolCallId: "",
    functionName: "",
    toolArgsText: "",
    toolResultText: "",
    parentEventId: "",
    tocLabel: "expanded json",
    hasError: false,
    searchText: "expanded json",
    raw,
  };
}

function traceIdFromTraceUrl(url: string): string {
  const match = url.match(/\/api\/trace\/([^?]+)/);
  return decodeURIComponent(match?.[1] ?? "");
}

function traceIdFromStopUrl(url: string): string {
  const match = url.match(/\/api\/trace\/([^/]+)\/stop(?:\?|$)/);
  return decodeURIComponent(match?.[1] ?? "");
}

function traceIdFromOpenUrl(url: string): string {
  const match = url.match(/\/api\/trace\/([^/]+)\/open(?:\?|$)/);
  return decodeURIComponent(match?.[1] ?? "");
}

function countTraceDetailRequests(traceId: string): number {
  const detailUrlFragment = `/api/trace/${traceId}`;
  return requestedUrls.filter((url) => {
    if (!url.includes(detailUrlFragment)) return false;
    if (url.includes("/stop")) return false;
    if (url.includes("/open")) return false;
    return true;
  }).length;
}

function getTraceRow(id: string): HTMLDivElement {
  const row = document.querySelector(`[data-trace-id="${id}"]`);
  if (!row) throw new Error(`missing row for ${id}`);
  return row as HTMLDivElement;
}

function getTraceStopButton(id: string): HTMLButtonElement {
  const button = getTraceRow(id).querySelector(".trace-stop-button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`missing stop button for ${id}`);
  }
  return button;
}

function getTraceOpenButton(id: string): HTMLButtonElement {
  const button = getTraceRow(id).querySelector(".trace-open-button");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`missing open button for ${id}`);
  }
  return button;
}

function getTimelineStripPanel(): HTMLElement {
  const panel = document.querySelector(".timeline-strip-panel");
  if (!panel) throw new Error("missing timeline strip panel");
  return panel as HTMLElement;
}

function getTimelineStripScroll(): HTMLDivElement {
  const scroller = document.querySelector(".timeline-strip-scroll");
  if (!(scroller instanceof HTMLDivElement)) {
    throw new Error("missing timeline strip scroller");
  }
  return scroller;
}

function getTocTimestampByIndex(index: number): string {
  const tocRows = Array.from(document.querySelectorAll(".toc-row"));
  const row = tocRows.find((candidate) => candidate.querySelector(".toc-index")?.textContent?.trim() === `#${index}`);
  if (!(row instanceof HTMLButtonElement)) {
    throw new Error(`missing toc row #${index}`);
  }
  const value = row.querySelector(".toc-timestamp")?.textContent?.trim();
  if (!value) {
    throw new Error(`missing toc timestamp for row #${index}`);
  }
  return value;
}

function setTimelineStripMetrics(
  scroller: HTMLDivElement,
  metrics: { clientWidth: number; scrollWidth: number; scrollLeft: number },
): void {
  Object.defineProperty(scroller, "clientWidth", { configurable: true, value: metrics.clientWidth });
  Object.defineProperty(scroller, "scrollWidth", { configurable: true, value: metrics.scrollWidth });
  Object.defineProperty(scroller, "scrollLeft", { configurable: true, writable: true, value: metrics.scrollLeft });
}

function installTimelineStripScrollTo(scroller: HTMLDivElement) {
  const scrollToSpy = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    if (typeof options === "number") {
      scroller.scrollLeft = options;
      return;
    }
    if (options && typeof options.left === "number") {
      scroller.scrollLeft = options.left;
      return;
    }
    if (typeof y === "number") {
      scroller.scrollLeft = y;
    }
  });
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollToSpy });
  return scrollToSpy;
}

let tracesById: Record<string, TraceSummary>;
let tracePagesById: Record<string, TracePage>;
let overview: OverviewStats;
let rafQueue: FrameRequestCallback[];
let requestedUrls: string[];
let stopResponsesByTraceId: Record<string, { status: number; body: Record<string, unknown> }>;
let openResponsesByTraceId: Record<string, { status: number; body: Record<string, unknown> }>;

beforeEach(() => {
  tracesById = {
    "trace-a": makeTrace("trace-a", 1_000),
    "trace-b": makeTrace("trace-b", 2_000),
    "trace-c": makeTrace("trace-c", 3_000),
  };
  overview = makeOverview(Object.keys(tracesById).length);
  tracePagesById = Object.fromEntries(
    Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
  );
  rafQueue = [];
  requestedUrls = [];
  stopResponsesByTraceId = {};
  openResponsesByTraceId = {};

  vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
  vi.stubGlobal(
    "requestAnimationFrame",
    ((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }) as typeof requestAnimationFrame,
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
      const method = String(init?.method ?? "GET").toUpperCase();
      requestedUrls.push(url);
      if (url.includes("/api/overview")) {
        return new Response(JSON.stringify({ overview }), { status: 200 });
      }
      if (url.includes("/api/traces")) {
        return new Response(JSON.stringify({ traces: Object.values(tracesById) }), { status: 200 });
      }
      if (method === "POST" && url.includes("/api/trace/") && url.includes("/stop")) {
        const traceId = traceIdFromStopUrl(url);
        const custom = stopResponsesByTraceId[traceId];
        const status = custom?.status ?? 200;
        const body = custom?.body ?? { ok: true, status: "terminated", signal: "SIGINT" };
        return new Response(JSON.stringify(body), { status });
      }
      if (method === "POST" && url.includes("/api/trace/") && url.includes("/open")) {
        const traceId = traceIdFromOpenUrl(url);
        const custom = openResponsesByTraceId[traceId];
        const status = custom?.status ?? 200;
        const body = custom?.body ?? { ok: true, status: "ghostty_activated" };
        return new Response(JSON.stringify(body), { status });
      }
      if (url.includes("/api/trace/")) {
        const traceId = traceIdFromTraceUrl(url);
        const tracePage = tracePagesById[traceId] ?? Object.values(tracePagesById)[0];
        if (!tracePage) {
          return new Response("{}", { status: 404 });
        }
        return new Response(JSON.stringify(tracePage), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  MockEventSource.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App sessions list live motion", () => {
  it("renders hero title with lens emoji and sessions metric label", async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const heroTitle = document.querySelector(".hero h1");
    expect(heroTitle?.textContent).toBe("🔍 AgentLens");

    const heroMetrics = Array.from(document.querySelectorAll(".hero-metrics span")).map((node) =>
      node.textContent?.trim(),
    );
    expect(heroMetrics[0]).toBe("sessions 3");
    expect(document.querySelector(".hero-github-tag")?.getAttribute("href")).toBe(
      "https://github.com/RobertTLange/agentlens",
    );
    expect(document.querySelector("footer")).toBeNull();
  });

  it("shows last live update time in header status", async () => {
    const nowMs = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(nowMs);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("snapshot", { traces: Object.values(tracesById), overview });
    });

    const expectedTime = new Date(nowMs).toLocaleTimeString();
    const expectedNewestEventTime = new Date(3_000).toLocaleTimeString();
    await waitFor(() => {
      const headerStatus = document.querySelector(".hero-status");
      expect(headerStatus?.textContent).toContain("Live: 3 traces");
      expect(headerStatus?.textContent).toContain(`updated ${expectedTime}`);
      expect(headerStatus?.textContent).toContain(`newest event ${expectedNewestEventTime}`);
    });
  });

  it("defaults include meta toggle to off in trace inspector", async () => {
    render(<App />);
    await waitFor(() => expect(requestedUrls.some((url) => url.includes("/api/trace/"))).toBe(true));

    const includeMetaLabel = Array.from(document.querySelectorAll(".detail-controls .checkbox")).find((node) =>
      node.textContent?.includes("include meta"),
    );
    if (!(includeMetaLabel instanceof HTMLLabelElement)) {
      throw new Error("missing include meta checkbox label");
    }
    const includeMetaInput = includeMetaLabel.querySelector('input[type="checkbox"]');
    if (!(includeMetaInput instanceof HTMLInputElement)) {
      throw new Error("missing include meta checkbox input");
    }

    expect(includeMetaInput.checked).toBe(false);
    const traceRequestUrl = requestedUrls.find((url) => url.includes("/api/trace/"));
    expect(traceRequestUrl).toContain("include_meta=0");
  });

  it("reuses cached trace detail when switching back to a previous session", async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));
    await waitFor(() => expect(countTraceDetailRequests("trace-c")).toBe(1));

    act(() => {
      getTraceRow("trace-a").click();
    });
    await waitFor(() => expect(countTraceDetailRequests("trace-a")).toBe(1));

    act(() => {
      getTraceRow("trace-c").click();
    });
    await waitFor(() => expect(getTraceRow("trace-c").className).toContain("active"));
    expect(countTraceDetailRequests("trace-c")).toBe(1);

    act(() => {
      getTraceRow("trace-a").click();
    });
    await waitFor(() => expect(getTraceRow("trace-a").className).toContain("active"));
    expect(countTraceDetailRequests("trace-a")).toBe(1);
  });

  it("renders trace inspector summary cards with token/model/tool data", async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".detail-summary-card").length).toBe(3));

    const cards = Array.from(document.querySelectorAll(".detail-summary-card"));
    const labels = cards.map((card) => card.querySelector(".detail-summary-title")?.textContent?.trim());
    expect(labels).toEqual(["tokens", "models", "tool calls"]);

    expect(cards[0]?.textContent).toContain("out");
    expect(cards[0]?.textContent).toContain("ctx");
    expect(cards[0]?.textContent).toContain("cost N/A");
    expect(cards[1]?.textContent).toContain("gpt-5.3-codex");
    expect(cards[2]?.textContent).toContain("types -");
    expect(cards[2]?.textContent).not.toContain("results");
    expect(cards[2]?.textContent).not.toContain("unmatched");
  });

  it("shows N/A cost when summary cost estimate is unknown", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) throw new Error("missing trace-c fixture");
    tracePagesById["trace-c"] = makeTracePage({
      ...selectedTrace,
      costEstimateUsd: null,
    });

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".detail-summary-card").length).toBe(3));

    const tokensCard = document.querySelector(".detail-summary-card");
    expect(tokensCard?.textContent).toContain("cost N/A");
  });

  it("updates trace inspector header in real time and pulses when selected trace updates", async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const initialMeta = document.querySelector(".detail-head-meta");
    expect(initialMeta?.textContent).toContain("session-trace-c");
    expect(initialMeta?.textContent).toContain("2 events");
    expect(document.querySelector(".detail-head-title-block.pulse")).toBeNull();

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    const updatedSelected = {
      ...makeTrace("trace-c", 9_500, "running"),
      eventCount: 7,
    };
    tracesById["trace-c"] = updatedSelected;

    act(() => {
      source.emit("trace_updated", { summary: updatedSelected });
    });

    await waitFor(() => {
      const nextMeta = document.querySelector(".detail-head-meta");
      expect(nextMeta?.textContent).toContain("session-trace-c");
      expect(nextMeta?.textContent).toContain("7 events");
    });
    expect(document.querySelector(".detail-head-title-block.pulse")).not.toBeNull();
  });

  it("shows running and waiting indicators from backend activity status", async () => {
    tracesById = {
      "trace-a": makeTrace("trace-a", 10_000, "running"),
      "trace-b": makeTrace("trace-b", 20_000, "waiting_input"),
      "trace-c": makeTrace("trace-c", 30_000, "idle"),
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    expect(document.querySelector(".session-head-counter.status-running")?.textContent).toBe("running 1");
    expect(document.querySelector(".session-head-counter.status-waiting")?.textContent).toBe("waiting 1");

    const runningRow = getTraceRow("trace-a");
    expect(runningRow.className).toContain("status-running");
    expect(runningRow.querySelector(".trace-status-chip")?.textContent).toBe("Running");
    expect(runningRow.querySelector(".trace-running-indicator")).not.toBeNull();

    const waitingRow = getTraceRow("trace-b");
    expect(waitingRow.className).toContain("status-waiting");
    expect(waitingRow.querySelector(".trace-status-chip")?.textContent).toBe("Waiting");
    expect(waitingRow.querySelector(".trace-running-indicator")).toBeNull();

    const idleRow = getTraceRow("trace-c");
    expect(idleRow.className).toContain("status-idle");
    expect(idleRow.querySelector(".trace-status-chip")?.textContent).toBe("Idle");
    expect(idleRow.querySelector(".trace-running-indicator")).toBeNull();
  });

  it("keeps stopped trace idle across stale snapshots and clears override on newer activity", async () => {
    const runningTrace = makeTrace("trace-c", 3_000, "running");
    tracesById["trace-c"] = runningTrace;
    tracePagesById["trace-c"] = makeTracePage(runningTrace);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));
    await waitFor(() => expect(getTraceRow("trace-c").querySelector(".trace-status-chip")?.textContent).toBe("Running"));
    await waitFor(() => expect(document.querySelector(".session-head-counter.status-running")?.textContent).toBe("running 1"));

    const stopButton = getTraceStopButton("trace-c");
    expect(stopButton.disabled).toBe(false);
    expect(stopButton.getAttribute("aria-label")).toBe("Stop session process");
    expect(stopButton.querySelector(".trace-stop-icon")).not.toBeNull();

    act(() => {
      stopButton.click();
    });

    await waitFor(() => expect(requestedUrls.some((url) => url.includes("/api/trace/trace-c/stop"))).toBe(true));
    await waitFor(() => expect(stopButton.disabled).toBe(false));
    await waitFor(() => expect(getTraceRow("trace-c").querySelector(".trace-status-chip")?.textContent).toBe("Idle"));
    await waitFor(() => expect(document.querySelector(".session-head-counter.status-running")?.textContent).toBe("running 0"));
    await waitFor(() =>
      expect(document.querySelector(".hero-status")?.textContent).toContain("Stop requested (SIGINT) for trace-c"),
    );

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("snapshot", {
        traces: [makeTrace("trace-a", 12_000, "running"), makeTrace("trace-b", 2_000, "idle"), makeTrace("trace-c", 3_000, "waiting_input")],
        overview: makeOverview(3),
      });
    });

    await waitFor(() => expect(getTraceRow("trace-c").querySelector(".trace-status-chip")?.textContent).toBe("Idle"));

    const resumedTrace = makeTrace("trace-c", Date.now() + 10_000, "running");
    act(() => {
      source.emit("trace_updated", { summary: resumedTrace });
    });

    await waitFor(() => expect(getTraceRow("trace-c").querySelector(".trace-status-chip")?.textContent).toBe("Running"));
  });

  it("shows stop failure error in the session row when terminate endpoint rejects", async () => {
    stopResponsesByTraceId["trace-c"] = {
      status: 409,
      body: { ok: false, error: "no active session process found" },
    };

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const stopButton = getTraceStopButton("trace-c");
    act(() => {
      stopButton.click();
    });

    await waitFor(() =>
      expect(getTraceRow("trace-c").querySelector(".trace-stop-error")?.textContent).toContain(
        "no active session process found",
      ),
    );
    await waitFor(() => expect(document.querySelector(".hero-status")?.textContent).toContain("Stop failed"));
  });

  it("opens the exact terminal pane when open endpoint reports focused_pane", async () => {
    openResponsesByTraceId["trace-c"] = {
      status: 200,
      body: {
        ok: true,
        status: "focused_pane",
        message: "focused tmux pane for session process",
        target: { tmuxSession: "main", windowIndex: 2, paneIndex: 1 },
        pid: 4242,
        tty: "/dev/ttys018",
      },
    };

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const openButton = getTraceOpenButton("trace-c");
    expect(openButton.disabled).toBe(false);
    expect(openButton.getAttribute("aria-label")).toBe("Open terminal pane");
    expect(openButton.querySelector(".trace-open-icon")).not.toBeNull();

    act(() => {
      openButton.click();
    });

    await waitFor(() => expect(requestedUrls.some((url) => url.includes("/api/trace/trace-c/open"))).toBe(true));
    await waitFor(() =>
      expect(document.querySelector(".hero-status")?.textContent).toContain(
        "Open focused_pane: focused tmux pane for session process (main:2.1 · pid 4242 · tty /dev/ttys018)",
      ),
    );
  });

  it("shows open debug status briefly then returns to base live status", async () => {
    openResponsesByTraceId["trace-c"] = {
      status: 200,
      body: {
        ok: true,
        status: "focused_pane",
        message: "focused tmux pane for session process",
        target: { tmuxSession: "main", windowIndex: 2, paneIndex: 1 },
        pid: 4242,
        tty: "/dev/ttys018",
      },
    };

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("snapshot", { traces: Object.values(tracesById), overview });
    });
    await waitFor(() => expect(document.querySelector(".hero-status")?.textContent).toContain("Live: 3 traces"));

    const openButton = getTraceOpenButton("trace-c");
    act(() => {
      openButton.click();
    });

    await waitFor(() =>
      expect(document.querySelector(".hero-status")?.textContent).toContain(
        "Open focused_pane: focused tmux pane for session process (main:2.1 · pid 4242 · tty /dev/ttys018)",
      ),
    );
    await waitFor(() => expect(document.querySelector(".hero-status")?.className).toContain("flash-active"));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 3_100));
    });

    await waitFor(() => expect(document.querySelector(".hero-status")?.textContent).toContain("Live: 3 traces"));
    expect(document.querySelector(".hero-status")?.className).not.toContain("flash-active");
  });

  it("falls back to Ghostty activation when open endpoint reports ghostty_activated", async () => {
    openResponsesByTraceId["trace-c"] = {
      status: 200,
      body: {
        ok: true,
        status: "ghostty_activated",
        message: "activated Ghostty (session process not resolved)",
      },
    };

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const openButton = getTraceOpenButton("trace-c");
    act(() => {
      openButton.click();
    });

    await waitFor(() => expect(requestedUrls.some((url) => url.includes("/api/trace/trace-c/open"))).toBe(true));
    await waitFor(() =>
      expect(document.querySelector(".hero-status")?.textContent).toContain(
        "Open ghostty_activated: activated Ghostty (session process not resolved)",
      ),
    );
  });

  it("shows open failure error in the session row when open endpoint rejects", async () => {
    openResponsesByTraceId["trace-c"] = {
      status: 409,
      body: { ok: false, error: "no active session process found" },
    };

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const openButton = getTraceOpenButton("trace-c");
    act(() => {
      openButton.click();
    });

    await waitFor(() =>
      expect(getTraceRow("trace-c").querySelector(".trace-open-error")?.textContent).toContain(
        "no active session process found",
      ),
    );
    await waitFor(() => expect(document.querySelector(".hero-status")?.textContent).toContain("Open failed"));
  });

  it("renders session rows with single-line name element and start/updated fields", async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const row = getTraceRow("trace-c");
    const name = row.querySelector(".trace-session-name");
    expect(name?.textContent).toBe("session-trace-c");
    expect(name?.getAttribute("title")).toBe("session-trace-c");

    const labels = Array.from(row.querySelectorAll(".trace-time-label")).map((node) => node.textContent?.trim());
    expect(labels).toEqual(["updated", "start"]);

    expect(row.querySelectorAll(".trace-time-value")).toHaveLength(2);
    expect(row.querySelector(".trace-meta")).toBeNull();
  });

  it("shows a copy icon in expanded path view and copies the full path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const row = getTraceRow("trace-c");
    expect(row.querySelector(".trace-path-copy")).toBeNull();

    const pathToggle = row.querySelector(".trace-path-toggle");
    if (!(pathToggle instanceof HTMLButtonElement)) {
      throw new Error("missing path toggle button");
    }

    act(() => {
      pathToggle.click();
    });

    const copyButton = row.querySelector(".trace-path-copy");
    if (!(copyButton instanceof HTMLButtonElement)) {
      throw new Error("missing path copy button");
    }

    act(() => {
      copyButton.click();
    });

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/tmp/trace-c.jsonl"));
  });

  it("formats timeline TOC timestamps with threshold buckets", async () => {
    const anchorMs = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(anchorMs);

    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) {
      throw new Error("missing trace-c test fixture");
    }

    const buildEvent = (eventId: string, index: number, timestampMs: number | null): NormalizedEvent => ({
      ...makeEvent(eventId, { signature: eventId }),
      index,
      offset: index,
      timestampMs,
      preview: eventId,
      textBlocks: [eventId],
      tocLabel: eventId,
      searchText: eventId,
    });

    const events: NormalizedEvent[] = [
      buildEvent("under-ten-seconds", 1, anchorMs - 9_000),
      buildEvent("ten-seconds", 2, anchorMs - 10_000),
      buildEvent("fifty-nine-seconds", 3, anchorMs - 59_000),
      buildEvent("sixty-seconds", 4, anchorMs - 60_000),
      buildEvent("fifty-nine-minutes", 5, anchorMs - 3_599_000),
      buildEvent("sixty-minutes", 6, anchorMs - 3_600_000),
      buildEvent("twenty-three-hours", 7, anchorMs - 86_399_000),
      buildEvent("twenty-four-hours", 8, anchorMs - 86_400_000),
      buildEvent("future", 9, anchorMs + 5_000),
      buildEvent("missing", 10, null),
    ];

    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, events);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".toc-row").length).toBe(events.length));

    expect(getTocTimestampByIndex(1)).toBe("now");
    expect(getTocTimestampByIndex(2)).toBe("10s ago");
    expect(getTocTimestampByIndex(3)).toBe("59s ago");
    expect(getTocTimestampByIndex(4)).toBe("1m ago");
    expect(getTocTimestampByIndex(5)).toBe("59m ago");
    expect(getTocTimestampByIndex(6)).toBe("1h ago");
    expect(getTocTimestampByIndex(7)).toBe("23h ago");
    expect(getTocTimestampByIndex(8)).toBe("1d ago");
    expect(getTocTimestampByIndex(9)).toBe("now");
    expect(getTocTimestampByIndex(10)).toBe("-");
  });

  it("renders compact last-event age chips beside the composition pie", async () => {
    const anchorMs = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(anchorMs);

    tracesById = {
      "trace-a": {
        ...makeTrace("trace-a", anchorMs - 60_000, "running"),
        lastEventTs: anchorMs - 60_000,
      },
      "trace-b": {
        ...makeTrace("trace-b", anchorMs - 3_600_000, "waiting_input"),
        lastEventTs: anchorMs - 3_600_000,
      },
      "trace-c": {
        ...makeTrace("trace-c", anchorMs - 9_000, "idle"),
        lastEventTs: anchorMs - 9_000,
      },
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const minuteChip = getTraceRow("trace-a").querySelector(".trace-last-event-chip");
    expect(minuteChip?.textContent?.trim()).toBe("1m");
    expect(minuteChip?.getAttribute("title")).toContain("1 minute ago");

    const hourChip = getTraceRow("trace-b").querySelector(".trace-last-event-chip");
    expect(hourChip?.textContent?.trim()).toBe("1h");
    expect(hourChip?.getAttribute("title")).toContain("1 hour ago");

    const nowChip = getTraceRow("trace-c").querySelector(".trace-last-event-chip");
    expect(nowChip?.textContent?.trim()).toBe("now");
    expect(nowChip?.getAttribute("title")).toContain("just now");
  });

  it("renders tool-type tags in TOC rows and trace inspector cards", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) throw new Error("missing trace-c test fixture");

    const taggedEvent: NormalizedEvent = {
      ...makeEvent("event-tool-type-tag", { signature: "tool typed event" }),
      eventKind: "tool_use",
      toolType: "bash",
      preview: "run command",
      tocLabel: "Tool: exec_command",
      searchText: "tool typed event bash",
    };
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [taggedEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".toc-row").length).toBe(1));
    await waitFor(() => expect(document.querySelectorAll(".event-card").length).toBe(1));
    await waitFor(() => expect(document.querySelectorAll(".detail-summary-card").length).toBe(3));

    const tocTag = document.querySelector(".toc-row .kind-tool-type");
    expect(tocTag?.textContent?.trim()).toBe("bash");

    const cardTag = document.querySelector(".event-card .event-top .kind-tool-type");
    expect(cardTag?.textContent?.trim()).toBe("bash");

    const toolCallsCard = document.querySelectorAll(".detail-summary-card")[2];
    expect(toolCallsCard?.textContent).toContain("bash 1");
  });

  it("counts tool calls by type including web-search events", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) throw new Error("missing trace-c test fixture");

    const toolUseEvent: NormalizedEvent = {
      ...makeEvent("event-tool-use", { signature: "tool use" }),
      eventKind: "tool_use",
      toolType: "bash",
      toolCallId: "call-1",
      toolUseId: "call-1",
      preview: "run command",
      tocLabel: "Tool: exec_command",
      searchText: "tool use bash",
    };

    const toolResultEvent: NormalizedEvent = {
      ...makeEvent("event-tool-result", { signature: "tool result" }),
      eventKind: "tool_result",
      toolType: "bash",
      toolCallId: "call-1",
      toolUseId: "call-1",
      preview: "command output",
      tocLabel: "Result: call-1",
      searchText: "tool result bash",
    };

    const webSearchEvent: NormalizedEvent = {
      ...makeEvent("event-web-search", { signature: "web search" }),
      eventKind: "assistant",
      rawType: "web_search_call",
      toolType: "web:search",
      preview: "search docs",
      tocLabel: "Web: search",
      searchText: "web search",
    };

    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [toolUseEvent, toolResultEvent, webSearchEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".detail-summary-card").length).toBe(3));

    const toolCallsCard = document.querySelectorAll(".detail-summary-card")[2];
    const toolCallsValue = toolCallsCard?.querySelector(".detail-summary-value")?.textContent?.trim();
    expect(toolCallsValue).toBe("2");
    expect(toolCallsCard?.textContent).toContain("bash 1");
    expect(toolCallsCard?.textContent).toContain("web:search 1");
    const toolCallRows = toolCallsCard ? Array.from(toolCallsCard.querySelectorAll(".detail-summary-sub")) : [];
    expect(toolCallRows).toHaveLength(1);
    expect(toolCallRows[0]?.textContent).toContain("bash 1 · web:search 1");
    expect(toolCallsCard?.textContent).not.toContain("results");
    expect(toolCallsCard?.textContent).not.toContain("unmatched");
  });

  it("does not render snippet text under the event header preview", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) throw new Error("missing trace-c test fixture");

    const duplicateEvent = makeEvent("event-duplicate-snippet", { signature: "duplicate" });
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [duplicateEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".event-card").length).toBe(1));

    expect(document.querySelector(".event-card h3")?.textContent).toBe("expanded json");
    expect(document.querySelector(".event-card .event-snippet")).toBeNull();
  });

  it("renders activity sparkline with status tint and accessibility label", async () => {
    tracesById = {
      "trace-a": makeTrace("trace-a", 10_000, "running"),
      "trace-b": makeTrace("trace-b", 20_000, "waiting_input"),
      "trace-c": {
        ...makeTrace("trace-c", 30_000, "idle"),
        activityBinsMode: "event_index",
      },
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const runningSparkline = getTraceRow("trace-a").querySelector(".trace-activity-sparkline");
    expect(runningSparkline?.getAttribute("class")).toContain("status-running");
    expect(runningSparkline?.getAttribute("data-point-count")).toBe("12");
    expect(runningSparkline?.getAttribute("data-mode")).toBe("time");
    expect(runningSparkline?.getAttribute("aria-label")).toContain("session lifetime");

    const waitingSparkline = getTraceRow("trace-b").querySelector(".trace-activity-sparkline");
    expect(waitingSparkline?.getAttribute("class")).toContain("status-waiting");

    const idleSparkline = getTraceRow("trace-c").querySelector(".trace-activity-sparkline");
    expect(idleSparkline?.getAttribute("class")).toContain("status-idle");
    expect(idleSparkline?.getAttribute("data-mode")).toBe("event_index");
    expect(idleSparkline?.getAttribute("aria-label")).toContain("event-order density fallback");
  });

  it("renders composition pie with assistant/user/tool proportions and combined tool counts", async () => {
    tracesById = {
      "trace-a": {
        ...makeTrace("trace-a", 10_000, "running"),
        eventKindCounts: {
          system: 0,
          assistant: 6,
          user: 3,
          tool_use: 1,
          tool_result: 2,
          reasoning: 0,
          meta: 0,
        },
      },
      "trace-b": makeTrace("trace-b", 20_000, "waiting_input"),
      "trace-c": makeTrace("trace-c", 30_000, "idle"),
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const pie = getTraceRow("trace-a").querySelector(".trace-composition-pie");
    expect(pie).toBeTruthy();
    expect(pie?.getAttribute("data-assistant-count")).toBe("6");
    expect(pie?.getAttribute("data-user-count")).toBe("3");
    expect(pie?.getAttribute("data-tool-use-count")).toBe("1");
    expect(pie?.getAttribute("data-tool-result-count")).toBe("2");
    expect(pie?.getAttribute("aria-label")).toContain("assistant 50%");
    expect(pie?.getAttribute("aria-label")).toContain("user 25%");
    expect(pie?.getAttribute("aria-label")).toContain("tool use 8%");
    expect(pie?.getAttribute("aria-label")).toContain("tool result 17%");

    const tooltip = getTraceRow("trace-a").querySelector(".trace-composition-tooltip");
    expect(tooltip?.textContent).toContain("Assistant: 6 (50%)");
    expect(tooltip?.textContent).toContain("User: 3 (25%)");
    expect(tooltip?.textContent).toContain("Tool use: 1 (8%)");
    expect(tooltip?.textContent).toContain("Tool result: 2 (17%)");
    expect(tooltip?.textContent).toContain("Total: 12");

    const slices = getTraceRow("trace-a").querySelectorAll(".trace-composition-slice");
    expect(slices).toHaveLength(4);

    const graphWrap = getTraceRow("trace-a").querySelector(".trace-time-graph-wrap");
    const graphChildren = graphWrap ? Array.from(graphWrap.children) : [];
    expect(graphChildren[0]?.classList.contains("trace-last-event-chip")).toBe(true);
    expect(graphChildren[1]?.classList.contains("trace-composition-wrap")).toBe(true);
    expect(graphChildren[2]?.classList.contains("trace-activity-sparkline")).toBe(true);
  });

  it("renders empty composition pie state when no user/assistant/tool events are present", async () => {
    tracesById = {
      "trace-a": makeTrace("trace-a", 10_000, "running"),
      "trace-b": makeTrace("trace-b", 20_000, "waiting_input"),
      "trace-c": {
        ...makeTrace("trace-c", 30_000, "idle"),
        eventKindCounts: {
          system: 1,
          assistant: 0,
          user: 0,
          tool_use: 0,
          tool_result: 0,
          reasoning: 2,
          meta: 1,
        },
      },
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const row = getTraceRow("trace-c");
    const pie = row.querySelector(".trace-composition-pie");
    expect(pie?.getAttribute("data-total")).toBe("0");
    expect(pie?.getAttribute("aria-label")).toContain("no user, assistant, tool use, or tool result events yet");
    expect(row.querySelector(".trace-composition-tooltip")?.textContent).toContain(
      "No user, assistant, tool use, or tool result events yet.",
    );
    expect(row.querySelector(".trace-composition-empty")).toBeTruthy();
    expect(row.querySelectorAll(".trace-composition-slice")).toHaveLength(0);
  });

  it("falls back to flat sparkline when activity bins are missing or invalid", async () => {
    const traceMissingBins = makeTrace("trace-a", 10_000, "idle");
    delete traceMissingBins.activityBins;
    delete traceMissingBins.activityBinsMode;
    delete traceMissingBins.activityWindowMinutes;
    delete traceMissingBins.activityBinMinutes;
    delete traceMissingBins.activityBinCount;

    tracesById = {
      "trace-a": traceMissingBins,
      "trace-b": {
        ...makeTrace("trace-b", 20_000, "idle"),
        activityBins: [0.4, Number.NaN, 2],
      },
      "trace-c": makeTrace("trace-c", 30_000, "idle"),
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const missingSparkline = getTraceRow("trace-a").querySelector(".trace-activity-sparkline");
    expect(missingSparkline?.getAttribute("data-flat")).toBe("true");
    expect(missingSparkline?.getAttribute("class")).toContain("is-flat");

    const invalidSparkline = getTraceRow("trace-b").querySelector(".trace-activity-sparkline");
    expect(invalidSparkline?.getAttribute("data-flat")).toBe("false");
    expect(invalidSparkline?.getAttribute("data-point-count")).toBe("2");
  });

  it("adds hover section tooltips on activity sparkline bins", async () => {
    tracesById = {
      "trace-a": makeTrace("trace-a", 10_000, "running"),
      "trace-b": makeTrace("trace-b", 20_000, "waiting_input"),
      "trace-c": makeTrace("trace-c", 30_000, "idle"),
    };
    tracePagesById = Object.fromEntries(
      Object.values(tracesById).map((summary) => [summary.id, makeTracePage(summary)]),
    );

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const sparkline = getTraceRow("trace-a").querySelector(".trace-activity-sparkline");
    const hoverZones = sparkline?.querySelectorAll(".trace-activity-hover-zone");
    expect(hoverZones?.length).toBe(12);
    const firstTooltip = hoverZones?.[0]?.querySelector("title")?.textContent ?? "";
    expect(firstTooltip).toContain("Activity");
    expect(firstTooltip).toContain("to");
  });

  it("pulses matching rows for trace updates and trace additions", async () => {
    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("overview_updated", { overview: { ...overview, updatedAtMs: 2_000 } });
    });
    expect(getTraceRow("trace-a").querySelector(".trace-row-inner.pulse")).toBeNull();
    expect(getTraceRow("trace-b").querySelector(".trace-row-inner.pulse")).toBeNull();

    const updatedB = makeTrace("trace-b", 4_000);
    tracesById["trace-b"] = updatedB;
    act(() => {
      source.emit("trace_updated", { summary: updatedB });
    });

    await waitFor(() =>
      expect(getTraceRow("trace-b").querySelector(".trace-row-inner.pulse")).not.toBeNull(),
    );
    expect(getTraceRow("trace-a").querySelector(".trace-row-inner.pulse")).toBeNull();

    const addedD = makeTrace("trace-d", 5_000);
    tracesById["trace-d"] = addedD;
    act(() => {
      source.emit("trace_added", { summary: addedD });
    });

    await waitFor(() => expect(getTraceRow("trace-d").querySelector(".trace-row-inner.pulse")).not.toBeNull());
  });

  it("animates only cards whose list position changed", async () => {
    const topByTraceId: Record<string, number> = {
      "trace-c": 100,
      "trace-b": 200,
      "trace-a": 300,
    };

    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement): DOMRect {
      const element = this;
      const top = element.dataset.traceId ? (topByTraceId[element.dataset.traceId] ?? 0) : 0;
      return {
        x: 0,
        y: top,
        width: 320,
        height: 40,
        top,
        right: 320,
        bottom: top + 40,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect;
    });

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".trace-row").length).toBe(3));
    await act(async () => {
      await Promise.resolve();
    });

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    topByTraceId["trace-b"] = 100;
    topByTraceId["trace-c"] = 200;
    topByTraceId["trace-a"] = 300;

    const updatedB = makeTrace("trace-b", 4_500);
    tracesById["trace-b"] = updatedB;

    act(() => {
      source.emit("trace_updated", { summary: updatedB });
    });

    await waitFor(() => expect(getTraceRow("trace-b").style.transform).toBe("translateY(100px)"));
    expect(getTraceRow("trace-c").style.transform).toBe("translateY(-100px)");
    expect(getTraceRow("trace-a").style.transform).toBe("");

    act(() => {
      for (const callback of rafQueue.splice(0)) {
        callback(0);
      }
    });

    expect(getTraceRow("trace-b").style.transition).toContain("transform");
    expect(getTraceRow("trace-c").style.transition).toContain("transform");
    expect(getTraceRow("trace-a").style.transition).toBe("");
  });

  it("shows expanded raw JSON inside wrap-safe block", async () => {
    const longToken = "A".repeat(1200);
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) {
      throw new Error("missing trace-c test fixture");
    }
    tracePagesById["trace-c"] = makeTracePageWithEvents(
      selectedTrace,
      [makeEvent("event-expand-1", { signature: longToken, info: "long json value" })],
    );

    render(<App />);
    await waitFor(() => expect(document.querySelector(".event-card")).not.toBeNull());

    const expandButton = document.querySelector(".event-card .expand-btn");
    if (!(expandButton instanceof HTMLButtonElement)) {
      throw new Error("missing expand button");
    }

    act(() => {
      expandButton.click();
    });

    await waitFor(() => expect(document.querySelector(".event-raw-json")).not.toBeNull());

    const rawBlock = document.querySelector(".event-raw-json");
    expect(rawBlock).toBeTruthy();
    expect(rawBlock?.textContent).toContain(longToken);
  });

  it("keeps expanded event JSON open when selected trace refreshes live", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) {
      throw new Error("missing trace-c test fixture");
    }
    const firstEvent = makeEvent("event-expand-keep", { signature: "first payload" });
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".event-card").length).toBe(1));

    const expandButton = document.querySelector(".event-card .expand-btn");
    if (!(expandButton instanceof HTMLButtonElement)) {
      throw new Error("missing expand button");
    }

    act(() => {
      expandButton.click();
    });
    await waitFor(() => expect(document.querySelectorAll(".event-raw-json").length).toBe(1));

    const appendedEvent: NormalizedEvent = {
      ...makeEvent("event-expand-new", { signature: "new payload" }),
      index: 5,
      offset: 5,
      timestampMs: 2_000,
      preview: "new payload",
      textBlocks: ["new payload"],
      tocLabel: "new payload",
      searchText: "new payload",
    };
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent, appendedEvent]);

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("events_appended", { id: "trace-c", appended: 1 });
    });

    await waitFor(() => expect(document.querySelectorAll(".event-card").length).toBe(2));
    await waitFor(() => expect(document.querySelectorAll(".event-raw-json").length).toBe(1));

    const expandedRawJson = document.querySelector(".event-raw-json");
    if (!(expandedRawJson instanceof HTMLElement)) {
      throw new Error("missing expanded raw json block after refresh");
    }
    expect(expandedRawJson.textContent).toContain("first payload");
    const expandedCard = expandedRawJson.closest(".event-card");
    if (!(expandedCard instanceof HTMLElement)) {
      throw new Error("missing expanded event card after refresh");
    }
    const expandedButton = expandedCard.querySelector(".expand-btn");
    if (!(expandedButton instanceof HTMLButtonElement)) {
      throw new Error("missing expand button for expanded card after refresh");
    }
    expect(expandedButton.textContent).toBe("collapse");
  });

  it("adds enter animation classes for newly appended timeline rows and event cards", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) {
      throw new Error("missing trace-c test fixture");
    }

    const firstEvent = makeEvent("event-motion-first", { signature: "first payload" });
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".toc-row").length).toBe(1));
    await waitFor(() => expect(document.querySelectorAll(".event-card").length).toBe(1));

    expect(document.querySelector(".toc-row")?.className).not.toContain("toc-row-enter");
    expect(document.querySelector(".event-card")?.className).not.toContain("event-card-enter");

    const appendedEvent: NormalizedEvent = {
      ...makeEvent("event-motion-new", { signature: "new payload" }),
      index: 5,
      offset: 5,
      timestampMs: 2_000,
      preview: "new payload",
      textBlocks: ["new payload"],
      tocLabel: "new payload",
      searchText: "new payload",
    };
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent, appendedEvent]);

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("events_appended", { id: "trace-c", appended: 1 });
    });

    await waitFor(() => expect(document.querySelectorAll(".toc-row").length).toBe(2));
    await waitFor(() => expect(document.querySelectorAll(".event-card").length).toBe(2));

    const newTocRow = Array.from(document.querySelectorAll(".toc-row")).find((row) => row.textContent?.includes("#5"));
    expect(newTocRow?.className).toContain("toc-row-enter");

    const newEventCard = Array.from(document.querySelectorAll(".event-card")).find(
      (card) => card.querySelector("h3")?.textContent === "new payload",
    );
    expect(newEventCard?.className).toContain("event-card-enter");
  });

  it("drains large appended event chunks through a TOC queue", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) {
      throw new Error("missing trace-c test fixture");
    }

    const firstEvent = makeEvent("event-queue-first", { signature: "first payload" });
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".toc-row").length).toBe(1));

    const appendedEvents: NormalizedEvent[] = Array.from({ length: 10 }, (_, idx) => ({
      ...makeEvent(`event-queue-${idx}`, { signature: `queued payload ${idx}` }),
      index: 5 + idx,
      offset: 5 + idx,
      timestampMs: 2_000 + idx,
      preview: `queued payload ${idx}`,
      textBlocks: [`queued payload ${idx}`],
      tocLabel: `queued payload ${idx}`,
      searchText: `queued payload ${idx}`,
    }));
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent, ...appendedEvents]);

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("events_appended", { id: "trace-c", appended: appendedEvents.length });
    });

    await waitFor(() => {
      const count = document.querySelectorAll(".toc-row").length;
      expect(count).toBeGreaterThan(1);
      expect(count).toBeLessThanOrEqual(11);
    });
    await waitFor(() => expect(document.querySelectorAll(".toc-row").length).toBe(11));
  });

  it("auto-scrolls strip to latest when pinned at right edge and new events append", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) throw new Error("missing trace-c test fixture");

    const firstEvent = makeEvent("event-strip-first", { signature: "first payload" });
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".timeline-segment").length).toBe(1));

    const panel = getTimelineStripPanel();
    const scroller = getTimelineStripScroll();
    const scrollToSpy = installTimelineStripScrollTo(scroller);

    setTimelineStripMetrics(scroller, { clientWidth: 100, scrollWidth: 220, scrollLeft: 120 });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => expect(scroller.getAttribute("data-at-latest")).toBe("true"));

    const appendedEvent: NormalizedEvent = {
      ...makeEvent("event-strip-new", { signature: "new payload" }),
      index: 5,
      offset: 5,
      timestampMs: 2_000,
      preview: "new payload",
      textBlocks: ["new payload"],
      tocLabel: "new payload",
      searchText: "new payload",
    };
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent, appendedEvent]);
    setTimelineStripMetrics(scroller, { clientWidth: 100, scrollWidth: 260, scrollLeft: 120 });

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("events_appended", { id: "trace-c", appended: 1 });
    });

    await waitFor(() => expect(document.querySelectorAll(".timeline-segment").length).toBe(2));
    await waitFor(() => expect(scrollToSpy).toHaveBeenCalled());

    const lastCall = scrollToSpy.mock.calls.at(-1)?.[0] as ScrollToOptions | undefined;
    expect(lastCall).toMatchObject({ left: 260, behavior: "smooth" });
    expect(panel.className).not.toContain("timeline-strip-has-right-glow");
  });

  it("keeps strip position and shows right glow cue when new events append off-screen", async () => {
    const selectedTrace = tracesById["trace-c"];
    if (!selectedTrace) throw new Error("missing trace-c test fixture");

    const firstEvent = makeEvent("event-strip-offscreen-first", { signature: "first payload" });
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent]);

    render(<App />);
    await waitFor(() => expect(document.querySelectorAll(".timeline-segment").length).toBe(1));

    const panel = getTimelineStripPanel();
    const scroller = getTimelineStripScroll();
    const scrollToSpy = installTimelineStripScrollTo(scroller);

    setTimelineStripMetrics(scroller, { clientWidth: 100, scrollWidth: 220, scrollLeft: 24 });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => expect(scroller.getAttribute("data-at-latest")).toBe("false"));

    const appendedEvent: NormalizedEvent = {
      ...makeEvent("event-strip-offscreen-new", { signature: "new payload" }),
      index: 5,
      offset: 5,
      timestampMs: 2_000,
      preview: "new payload",
      textBlocks: ["new payload"],
      tocLabel: "new payload",
      searchText: "new payload",
    };
    tracePagesById["trace-c"] = makeTracePageWithEvents(selectedTrace, [firstEvent, appendedEvent]);
    setTimelineStripMetrics(scroller, { clientWidth: 100, scrollWidth: 260, scrollLeft: 24 });

    const source = MockEventSource.instances[0];
    expect(source).toBeTruthy();
    if (!source) return;

    act(() => {
      source.emit("events_appended", { id: "trace-c", appended: 1 });
    });

    await waitFor(() => expect(document.querySelectorAll(".timeline-segment").length).toBe(2));
    await waitFor(() => expect(panel.className).toContain("timeline-strip-has-right-glow"));
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(panel.getAttribute("aria-label")).toContain("off-screen to the right");

    setTimelineStripMetrics(scroller, { clientWidth: 100, scrollWidth: 260, scrollLeft: 160 });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() => expect(scroller.getAttribute("data-at-latest")).toBe("true"));
    await waitFor(() => expect(panel.className).not.toContain("timeline-strip-has-right-glow"));
  });
});
