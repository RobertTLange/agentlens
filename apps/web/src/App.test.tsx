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

function makeTrace(id: string, mtimeMs: number): TraceSummary {
  return {
    id,
    sourceProfile: "session_log",
    path: `/tmp/${id}.jsonl`,
    agent: "codex",
    parser: "codex",
    sessionId: `session-${id}`,
    sizeBytes: 100,
    mtimeMs,
    lastEventTs: mtimeMs,
    eventCount: 2,
    parseable: true,
    parseError: "",
    errorCount: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    unmatchedToolUses: 0,
    unmatchedToolResults: 0,
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

function getTraceRow(id: string): HTMLDivElement {
  const row = document.querySelector(`[data-trace-id="${id}"]`);
  if (!row) throw new Error(`missing row for ${id}`);
  return row as HTMLDivElement;
}

let tracesById: Record<string, TraceSummary>;
let tracePagesById: Record<string, TracePage>;
let overview: OverviewStats;
let rafQueue: FrameRequestCallback[];

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
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
      if (url.includes("/api/overview")) {
        return new Response(JSON.stringify({ overview }), { status: 200 });
      }
      if (url.includes("/api/traces")) {
        return new Response(JSON.stringify({ traces: Object.values(tracesById) }), { status: 200 });
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

    expect(getTraceRow("trace-b").style.transition).toContain("transform 280ms");
    expect(getTraceRow("trace-c").style.transition).toContain("transform 280ms");
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
});
