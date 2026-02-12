import { useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedEvent, OverviewStats, TracePage, TraceSummary } from "@agentlens/contracts";
import {
  classForKind,
  domIdForEvent,
  eventCardClass,
  sortTimelineItems,
  truncateText,
  type TimelineSortDirection,
} from "./view-model.js";

const API = "";
const EVENT_SNIPPET_CHAR_LIMIT = 320;

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function sortTraces(traces: TraceSummary[]): TraceSummary[] {
  return [...traces].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
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
  const [autoFollow, setAutoFollow] = useState(true);
  const [timelineSortDirection, setTimelineSortDirection] = useState<TimelineSortDirection>("first-latest");
  const [liveTick, setLiveTick] = useState(0);
  const selectedIdRef = useRef("");

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

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
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
      if (data.payload?.summary) upsert(data.payload.summary);
    });

    source.addEventListener("trace_updated", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { summary?: TraceSummary } };
      if (data.payload?.summary) upsert(data.payload.summary);
    });

    source.addEventListener("trace_removed", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { id?: string } };
      const id = data.payload?.id;
      if (!id) return;
      setTraces((prev) => prev.filter((trace) => trace.id !== id));
      setSelectedId((prev) => (prev === id ? "" : prev));
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
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setPage(null);
      return;
    }

    const loadTrace = async (): Promise<void> => {
      try {
        const detail = await fetchJson<TracePage>(
          `${API}/api/trace/${encodeURIComponent(selectedId)}?limit=1200&include_meta=${includeMeta ? "1" : "0"}`,
        );
        setPage(detail);
        setExpandedEventIds(new Set());
        setExpandedSnippetEventIds(new Set());
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

  const jumpToEvent = (eventId: string): void => {
    setSelectedEventId(eventId);
    const target = document.getElementById(domIdForEvent(eventId));
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
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

      <div className="grid">
        <section className="panel list-panel">
          <div className="panel-head">
            <h2>Sessions</h2>
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
              return (
                <button
                  key={trace.id}
                  className={`trace-row ${isActive ? "active" : ""}`}
                  onClick={() => setSelectedId(trace.id)}
                >
                  <div className="trace-main">
                    <strong>{trace.agent}</strong>
                    <span className="mono">{trace.sessionId || trace.id}</span>
                  </div>
                  <div className="trace-meta mono">
                    <span>{fmtTime(trace.lastEventTs ?? trace.mtimeMs)}</span>
                    <span>{`events ${trace.eventCount}`}</span>
                    <span>{`errors ${trace.errorCount}`}</span>
                  </div>
                  <div className="trace-path mono">{trace.path}</div>
                </button>
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
                  className={`toc-row ${isActive ? "active" : ""}`}
                  onClick={() => jumpToEvent(row.eventId)}
                >
                  <span className={`toc-dot kind-${row.colorKey.replace(/[^a-z_]/g, "")}`} />
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
                      className={`${eventCardClass(event.eventKind)} ${selectedEventId === event.eventId ? "selected" : ""}`}
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
                        <pre>{JSON.stringify(event.raw, null, 2)}</pre>
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
