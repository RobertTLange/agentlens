import { useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedEvent, OverviewStats, SessionActivityStatus, TracePage, TraceSummary } from "@agentlens/contracts";
import {
  buildTimelineStripSegments,
  classForKind,
  domIdForEvent,
  eventCardClass,
  kindClassSuffix,
  sortTimelineItems,
  truncateText,
  type TimelineSortDirection,
} from "./view-model.js";
import { SessionTraceRow } from "./SessionTraceRow.js";
import { useListReorderAnimation } from "./useListReorderAnimation.js";
import { useTraceRowReorderAnimation } from "./useTraceRowReorderAnimation.js";

const API = "";
const EVENT_SNIPPET_CHAR_LIMIT = 320;
const RUNNING_WINDOW_MS = 10_000;
const WAITING_WINDOW_MS = 120_000;
const EVENT_ENTER_ANIMATION_MS = 560;
const TRACE_ENTER_ANIMATION_MS = 620;

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function sortTraces(traces: TraceSummary[]): TraceSummary[] {
  return [...traces].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function deriveSessionActivityStatus(trace: TraceSummary, nowMs: number): SessionActivityStatus {
  const updatedMs = Math.max(trace.lastEventTs ?? 0, trace.mtimeMs);
  if (updatedMs <= 0) return "idle";
  const ageMs = Math.max(0, nowMs - updatedMs);
  if (ageMs < RUNNING_WINDOW_MS) return "running";
  if (ageMs < WAITING_WINDOW_MS) return "waiting_input";
  return "idle";
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function clearAnimationTimers(timerById: Map<string, number>): void {
  for (const timeoutId of timerById.values()) {
    window.clearTimeout(timeoutId);
  }
  timerById.clear();
}

export function App(): JSX.Element {
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [page, setPage] = useState<TracePage | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [query, setQuery] = useState("");
  const [includeMeta, setIncludeMeta] = useState(true);
  const [tocQuery, setTocQuery] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [expandedSnippetEventIds, setExpandedSnippetEventIds] = useState<Set<string>>(new Set());
  const [expandedPathTraceIds, setExpandedPathTraceIds] = useState<Set<string>>(new Set());
  const [autoFollow, setAutoFollow] = useState(true);
  const [timelineSortDirection, setTimelineSortDirection] = useState<TimelineSortDirection>("first-latest");
  const [liveTick, setLiveTick] = useState(0);
  const [enteringTraceIds, setEnteringTraceIds] = useState<Set<string>>(new Set());
  const [enteringEventIds, setEnteringEventIds] = useState<Set<string>>(new Set());
  const [pulseSeqByTraceId, setPulseSeqByTraceId] = useState<Record<string, number>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const selectedIdRef = useRef("");
  const previousTraceFilterRef = useRef("");
  const traceEnterAnimationInitializedRef = useRef(false);
  const previousVisibleTraceIdsRef = useRef<Set<string>>(new Set());
  const previousSelectedTraceIdRef = useRef("");
  const previousAnimatedTraceIdRef = useRef("");
  const previousPageEventIdsRef = useRef<Set<string>>(new Set());
  const enterAnimationTimerByTraceIdRef = useRef<Map<string, number>>(new Map());
  const enterAnimationTimerByEventIdRef = useRef<Map<string, number>>(new Map());

  const filteredTraces = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = sortTraces(traces);
    if (!q) return base;
    return base.filter((trace) => {
      const search = `${trace.path}\n${trace.agent}\n${trace.sessionId}\n${trace.id}`.toLowerCase();
      return search.includes(q);
    });
  }, [traces, query]);

  const tocRows = useMemo(() => {
    const rows = sortTimelineItems(page?.toc ?? [], timelineSortDirection);
    const q = tocQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const search = `${row.index}\n${row.eventKind}\n${row.label}`.toLowerCase();
      return search.includes(q);
    });
  }, [page, tocQuery, timelineSortDirection]);

  const timelineEvents = useMemo(
    () => sortTimelineItems(page?.events ?? [], timelineSortDirection),
    [page, timelineSortDirection],
  );
  const timelineStripEvents = useMemo(() => buildTimelineStripSegments(page?.events ?? []), [page]);
  const tocRowIds = useMemo(() => tocRows.map((row) => row.eventId), [tocRows]);
  const timelineEventIds = useMemo(() => timelineEvents.map((event) => event.eventId), [timelineEvents]);
  const filteredTraceIds = useMemo(() => filteredTraces.map((trace) => trace.id), [filteredTraces]);
  const sessionStatusCounts = useMemo(() => {
    const counts = {
      running: 0,
      waiting_input: 0,
      idle: 0,
    };
    for (const trace of filteredTraces) {
      const activityStatus = deriveSessionActivityStatus(trace, nowMs);
      if (activityStatus === "running") counts.running += 1;
      else if (activityStatus === "waiting_input") counts.waiting_input += 1;
      else counts.idle += 1;
    }
    return counts;
  }, [filteredTraces, nowMs]);
  const { bindTraceRowRef, removeTraceRow } = useTraceRowReorderAnimation(filteredTraceIds);
  const { bindItemRef: bindTocRowRef } = useListReorderAnimation<HTMLButtonElement>(tocRowIds, { resetKey: selectedId });
  const { bindItemRef: bindEventCardRef } = useListReorderAnimation<HTMLElement>(timelineEventIds, {
    resetKey: selectedId,
  });

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(
    () => () => {
      clearAnimationTimers(enterAnimationTimerByTraceIdRef.current);
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
    },
    [],
  );

  useEffect(() => {
    const filter = query.trim().toLowerCase();
    const filterChanged = previousTraceFilterRef.current !== filter;
    previousTraceFilterRef.current = filter;

    const currentTraceIds = new Set(filteredTraceIds);
    if (filterChanged || !traceEnterAnimationInitializedRef.current) {
      traceEnterAnimationInitializedRef.current = true;
      previousVisibleTraceIdsRef.current = currentTraceIds;
      setEnteringTraceIds(new Set());
      clearAnimationTimers(enterAnimationTimerByTraceIdRef.current);
      return;
    }

    const appendedTraceIds = filteredTraceIds.filter((traceId) => !previousVisibleTraceIdsRef.current.has(traceId));
    previousVisibleTraceIdsRef.current = currentTraceIds;
    if (appendedTraceIds.length === 0) return;

    setEnteringTraceIds((prev) => {
      const next = new Set(prev);
      for (const traceId of appendedTraceIds) next.add(traceId);
      return next;
    });

    appendedTraceIds.forEach((traceId, index) => {
      const existingTimer = enterAnimationTimerByTraceIdRef.current.get(traceId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        enterAnimationTimerByTraceIdRef.current.delete(traceId);
      }
      const timeoutId = window.setTimeout(() => {
        setEnteringTraceIds((prev) => {
          if (!prev.has(traceId)) return prev;
          const next = new Set(prev);
          next.delete(traceId);
          return next;
        });
        enterAnimationTimerByTraceIdRef.current.delete(traceId);
      }, TRACE_ENTER_ANIMATION_MS + index * 45);
      enterAnimationTimerByTraceIdRef.current.set(traceId, timeoutId);
    });
  }, [filteredTraceIds, query]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const bumpPulse = (traceId: string): void => {
      if (!traceId) return;
      setPulseSeqByTraceId((prev) => ({
        ...prev,
        [traceId]: (prev[traceId] ?? 0) + 1,
      }));
    };

    const loadBoot = async (): Promise<void> => {
      try {
        const [overviewResp, tracesResp] = await Promise.all([
          fetchJson<{ overview: OverviewStats }>(`${API}/api/overview`),
          fetchJson<{ traces: TraceSummary[] }>(`${API}/api/traces`),
        ]);
        const sorted = sortTraces(tracesResp.traces);
        setOverview(overviewResp.overview);
        setTraces(sorted);
        setSelectedId((prev) => prev || sorted[0]?.id || "");
        setStatus(`Loaded ${sorted.length} traces`);
      } catch (error) {
        setStatus(`Failed: ${String(error)}`);
      }
    };

    void loadBoot();

    const source = new EventSource(`${API}/api/stream`);

    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          payload?: { traces?: TraceSummary[]; overview?: OverviewStats };
        };
        const nextTraces = sortTraces(data.payload?.traces ?? []);
        if (nextTraces.length > 0) {
          setTraces(nextTraces);
          setSelectedId((prev) => prev || nextTraces[0]?.id || "");
        }
        if (data.payload?.overview) setOverview(data.payload.overview);
        setStatus(`Live: ${nextTraces.length} traces`);
      } catch {
        setStatus("Live update parse error");
      }
    });

    const upsert = (summary: TraceSummary): void => {
      setTraces((prev) => {
        const next = [...prev];
        const index = next.findIndex((item) => item.id === summary.id);
        if (index >= 0) {
          next[index] = summary;
        } else {
          next.push(summary);
        }
        return sortTraces(next);
      });
      setSelectedId((prev) => prev || summary.id);
    };

    source.addEventListener("trace_added", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { summary?: TraceSummary } };
      if (data.payload?.summary) {
        upsert(data.payload.summary);
        bumpPulse(data.payload.summary.id);
      }
    });

    source.addEventListener("trace_updated", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { summary?: TraceSummary } };
      if (data.payload?.summary) {
        upsert(data.payload.summary);
        bumpPulse(data.payload.summary.id);
      }
    });

    source.addEventListener("trace_removed", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { id?: string } };
      const id = data.payload?.id;
      if (!id) return;
      setTraces((prev) => prev.filter((trace) => trace.id !== id));
      setSelectedId((prev) => (prev === id ? "" : prev));
      removeTraceRow(id);
      setEnteringTraceIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      const traceEnterTimer = enterAnimationTimerByTraceIdRef.current.get(id);
      if (traceEnterTimer !== undefined) {
        window.clearTimeout(traceEnterTimer);
        enterAnimationTimerByTraceIdRef.current.delete(id);
      }
      setPulseSeqByTraceId((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    });

    source.addEventListener("overview_updated", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { overview?: OverviewStats } };
      if (data.payload?.overview) setOverview(data.payload.overview);
    });

    source.addEventListener("events_appended", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { id?: string; appended?: number } };
      if (data.payload?.id && data.payload.id === selectedIdRef.current) {
        setStatus("Live update received");
        if ((data.payload.appended ?? 0) > 0) {
          setLiveTick((value) => value + 1);
        }
      }
    });

    source.onerror = () => {
      setStatus("Live stream disconnected; retrying...");
    };

    return () => {
      source.close();
    };
  }, [removeTraceRow]);

  useEffect(() => {
    if (!selectedId) {
      setPage(null);
      setExpandedEventIds(new Set());
      setExpandedSnippetEventIds(new Set());
      setEnteringEventIds(new Set());
      previousAnimatedTraceIdRef.current = "";
      previousPageEventIdsRef.current = new Set();
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
      previousSelectedTraceIdRef.current = "";
      return;
    }

    const isTraceChanged = previousSelectedTraceIdRef.current !== selectedId;
    previousSelectedTraceIdRef.current = selectedId;

    const loadTrace = async (): Promise<void> => {
      try {
        const detail = await fetchJson<TracePage>(
          `${API}/api/trace/${encodeURIComponent(selectedId)}?limit=1200&include_meta=${includeMeta ? "1" : "0"}`,
        );
        const eventIds = new Set(detail.events.map((event) => event.eventId));
        setPage(detail);
        setExpandedEventIds((prev) => {
          if (isTraceChanged) return new Set();
          const next = new Set<string>();
          for (const eventId of prev) {
            if (eventIds.has(eventId)) next.add(eventId);
          }
          return next;
        });
        setExpandedSnippetEventIds((prev) => {
          if (isTraceChanged) return new Set();
          const next = new Set<string>();
          for (const eventId of prev) {
            if (eventIds.has(eventId)) next.add(eventId);
          }
          return next;
        });
        setSelectedEventId((prev) => {
          if (prev && detail.events.some((event) => event.eventId === prev)) {
            return prev;
          }
          return sortTimelineItems(detail.events, timelineSortDirection)[0]?.eventId ?? "";
        });
      } catch (error) {
        setStatus(`Trace load failed: ${String(error)}`);
      }
    };

    void loadTrace();
  }, [selectedId, includeMeta, liveTick]);

  useEffect(() => {
    if (!autoFollow) return;
    if (!page || page.events.length === 0) return;
    const last = page.events[page.events.length - 1];
    if (!last) return;
    setSelectedEventId(last.eventId);
  }, [autoFollow, page]);

  useEffect(() => {
    if (!selectedId || !page) {
      previousAnimatedTraceIdRef.current = "";
      previousPageEventIdsRef.current = new Set();
      setEnteringEventIds(new Set());
      return;
    }

    const currentEventIds = new Set(page.events.map((event) => event.eventId));
    const isTraceChanged = previousAnimatedTraceIdRef.current !== selectedId;
    previousAnimatedTraceIdRef.current = selectedId;

    if (isTraceChanged) {
      previousPageEventIdsRef.current = currentEventIds;
      setEnteringEventIds(new Set());
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
      return;
    }

    const appendedEventIds: string[] = [];
    for (const eventId of currentEventIds) {
      if (!previousPageEventIdsRef.current.has(eventId)) appendedEventIds.push(eventId);
    }
    previousPageEventIdsRef.current = currentEventIds;
    if (appendedEventIds.length === 0) return;

    setEnteringEventIds((prev) => {
      const next = new Set(prev);
      for (const eventId of appendedEventIds) next.add(eventId);
      return next;
    });

    for (const eventId of appendedEventIds) {
      const existingTimer = enterAnimationTimerByEventIdRef.current.get(eventId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        enterAnimationTimerByEventIdRef.current.delete(eventId);
      }
      const timeoutId = window.setTimeout(() => {
        setEnteringEventIds((prev) => {
          if (!prev.has(eventId)) return prev;
          const next = new Set(prev);
          next.delete(eventId);
          return next;
        });
        enterAnimationTimerByEventIdRef.current.delete(eventId);
      }, EVENT_ENTER_ANIMATION_MS);
      enterAnimationTimerByEventIdRef.current.set(eventId, timeoutId);
    }
  }, [page, selectedId]);

  const jumpToEvent = (eventId: string): void => {
    setSelectedEventId(eventId);
    const target = document.getElementById(domIdForEvent(eventId));
    if (!target) return;
    const scroller = target.closest(".events-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    const targetRect = target.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const relativeTop = targetRect.top - scrollerRect.top;
    const centeredOffset = (scroller.clientHeight - targetRect.height) / 2;
    const top = scroller.scrollTop + relativeTop - centeredOffset;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  const toggleExpanded = (eventId: string): void => {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const toggleSnippetExpanded = (eventId: string): void => {
    setExpandedSnippetEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const toggleTracePathExpanded = (traceId: string): void => {
    setExpandedPathTraceIds((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  };

  const renderCompactSnippet = (event: NormalizedEvent): string => {
    if (event.toolResultText) return event.toolResultText;
    if (event.toolArgsText) return event.toolArgsText;
    if (event.textBlocks[0]) return event.textBlocks[0];
    return event.preview;
  };

  return (
    <main className="shell">
      <header className="hero">
        <h1>AgentLens</h1>
        <p>Live observability for Codex, Claude, Cursor, OpenCode traces.</p>
        <div className="hero-metrics">
          <span>{`traces ${overview?.traceCount ?? 0}`}</span>
          <span>{`events ${overview?.eventCount ?? 0}`}</span>
          <span>{`errors ${overview?.errorCount ?? 0}`}</span>
          <span>{`tool io ${(overview?.toolUseCount ?? 0) + (overview?.toolResultCount ?? 0)}`}</span>
        </div>
      </header>

      <section className="timeline-strip-panel" aria-label="Session timeline summary">
        {timelineStripEvents.length > 0 ? (
          <div className="timeline-strip-scroll">
            <div className="timeline-strip-track" aria-label="Chronological timeline events">
              {timelineStripEvents.map((event) => {
                const isActive = event.eventId === selectedEventId;
                const eventTime = fmtTime(event.timestampMs);
                const eventLabel = event.label || event.eventKind;
                return (
                  <button
                    key={event.eventId}
                    type="button"
                    className={`timeline-segment kind-${kindClassSuffix(event.colorKey)} ${isActive ? "active" : ""} ${enteringEventIds.has(event.eventId) ? "timeline-segment-enter" : ""}`}
                    onClick={() => jumpToEvent(event.eventId)}
                    title={`${eventLabel} (${event.eventKind}) #${event.index} ${eventTime}`}
                    aria-label={`Jump to event #${event.index} ${event.eventKind}: ${eventLabel}`}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="timeline-strip-empty">No timeline events</div>
        )}
      </section>

      <div className="grid">
        <section className="panel list-panel">
          <div className="panel-head">
            <div className="session-head-top">
              <h2>Sessions</h2>
              <div className="session-head-counters mono">
                <span className="session-head-counter status-running">{`running ${sessionStatusCounts.running}`}</span>
                <span className="session-head-counter status-waiting">{`waiting ${sessionStatusCounts.waiting_input}`}</span>
              </div>
            </div>
            <input
              className="search"
              placeholder="Search session/path"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="list-scroll">
            {filteredTraces.map((trace) => {
              const isActive = trace.id === selectedId;
              const isPathExpanded = expandedPathTraceIds.has(trace.id);
              const pulseSeq = pulseSeqByTraceId[trace.id] ?? 0;
              const activityStatus = deriveSessionActivityStatus(trace, nowMs);
              return (
                <SessionTraceRow
                  key={trace.id}
                  trace={trace}
                  activityStatus={activityStatus}
                  isActive={isActive}
                  isPathExpanded={isPathExpanded}
                  isEntering={enteringTraceIds.has(trace.id)}
                  pulseSeq={pulseSeq}
                  onSelect={setSelectedId}
                  onTogglePath={toggleTracePathExpanded}
                  rowRef={bindTraceRowRef(trace.id)}
                  fmtTime={fmtTime}
                />
              );
            })}
            {filteredTraces.length === 0 && <div className="empty">No sessions</div>}
          </div>
        </section>

        <section className="panel toc-panel">
          <div className="panel-head toc-head">
            <div className="toc-head-top">
              <h2>Timeline TOC</h2>
              <button
                type="button"
                className="sort-toggle mono"
                title="Toggle timeline sort direction"
                onClick={() =>
                  setTimelineSortDirection((prev) => (prev === "latest-first" ? "first-latest" : "latest-first"))
                }
              >
                {timelineSortDirection === "latest-first" ? "latest->first" : "first->latest"}
              </button>
            </div>
            <input
              className="search"
              placeholder="Filter by kind/text"
              value={tocQuery}
              onChange={(event) => setTocQuery(event.target.value)}
            />
          </div>
          <div className="toc-scroll">
            {tocRows.map((row) => {
              const isActive = row.eventId === selectedEventId;
              return (
                <button
                  key={row.eventId}
                  className={`toc-row ${isActive ? "active" : ""} ${enteringEventIds.has(row.eventId) ? "toc-row-enter" : ""}`}
                  onClick={() => jumpToEvent(row.eventId)}
                  ref={bindTocRowRef(row.eventId)}
                >
                  <span className={`toc-dot kind-${kindClassSuffix(row.colorKey)}`} />
                  <span className="mono toc-index">{`#${row.index}`}</span>
                  <span className={classForKind(row.eventKind)}>{row.eventKind}</span>
                  <span className="toc-label">{row.label}</span>
                </button>
              );
            })}
            {tocRows.length === 0 && <div className="empty">No timeline rows</div>}
          </div>
        </section>

        <section className="panel detail-panel">
          <div className="panel-head detail-head">
            <h2>Trace Inspector</h2>
            <div className="detail-controls">
              <label className="mono checkbox">
                <input
                  type="checkbox"
                  checked={includeMeta}
                  onChange={(event) => setIncludeMeta(event.target.checked)}
                />
                include meta
              </label>
              <label className="mono checkbox">
                <input type="checkbox" checked={autoFollow} onChange={(event) => setAutoFollow(event.target.checked)} />
                auto follow
              </label>
            </div>
          </div>

          {page ? (
            <>
              <div className="summary-grid mono">
                <span>{`agent ${page.summary.agent}`}</span>
                <span>{`parser ${page.summary.parser}`}</span>
                <span>{`session ${page.summary.sessionId || "-"}`}</span>
                <span>{`events ${page.summary.eventCount}`}</span>
                <span>{`errors ${page.summary.errorCount}`}</span>
                <span>{`unmatched ${page.summary.unmatchedToolUses + page.summary.unmatchedToolResults}`}</span>
              </div>
              <div className="events-scroll">
                {timelineEvents.map((event) => {
                  const fullSnippet = renderCompactSnippet(event);
                  const snippet = truncateText(fullSnippet, EVENT_SNIPPET_CHAR_LIMIT);
                  const isSnippetExpanded = expandedSnippetEventIds.has(event.eventId);
                  const snippetText = isSnippetExpanded || !snippet.isTruncated ? fullSnippet : snippet.value;
                  return (
                    <article
                      key={event.eventId}
                      id={domIdForEvent(event.eventId)}
                      className={`${eventCardClass(event.eventKind)} ${selectedEventId === event.eventId ? "selected" : ""} ${enteringEventIds.has(event.eventId) ? "event-card-enter" : ""}`}
                      ref={bindEventCardRef(event.eventId)}
                    >
                      <button className="expand-btn mono" onClick={() => toggleExpanded(event.eventId)}>
                        {expandedEventIds.has(event.eventId) ? "collapse" : "expand"}
                      </button>
                      <div className="event-top mono">
                        <span>{`#${event.index}`}</span>
                        <span className={classForKind(event.eventKind)}>{event.eventKind}</span>
                        <span>{fmtTime(event.timestampMs)}</span>
                      </div>
                      <h3>{event.preview}</h3>
                      {(event.toolName || event.functionName) && (
                        <div className="mono subtle">
                          {`tool ${event.toolName || event.functionName}${event.toolCallId ? ` (${event.toolCallId})` : ""}`}
                        </div>
                      )}
                      <p className="event-snippet">
                        {snippetText}
                        {snippet.isTruncated && (
                          <button
                            type="button"
                            className="snippet-toggle mono"
                            onClick={() => toggleSnippetExpanded(event.eventId)}
                            aria-label={isSnippetExpanded ? "Show less text" : "Show full text"}
                          >
                            {isSnippetExpanded ? "show less" : "... more"}
                          </button>
                        )}
                      </p>
                      {expandedEventIds.has(event.eventId) && (
                        <pre className="event-raw-json">{JSON.stringify(event.raw, null, 2)}</pre>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="empty">Pick a session to inspect.</div>
          )}
        </section>
      </div>

      <footer className="status mono">{status}</footer>
    </main>
  );
}
