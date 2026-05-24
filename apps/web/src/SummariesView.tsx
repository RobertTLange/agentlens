import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentKind,
  RagIndexStatus,
  RagProjectionResponse,
  RagSearchMode,
  RagSearchResult,
  RagSummaryRecord,
} from "@agentlens/contracts";

const SEARCH_DEBOUNCE_MS = 250;
const SUMMARY_REFRESH_MS = 30_000;
const SUMMARY_LIST_LIMIT = 5000;
const PROJECTION_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const AGENT_OPTIONS: Array<AgentKind | ""> = ["", "codex", "claude", "cursor", "gemini", "opencode", "pi", "unknown"];
const STATUS_OPTIONS = ["complete", "stale", "failed", "skipped", "pending"] as const;
const CLUSTER_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0f766e", "#be123c", "#4b5563"];
type ProjectionItem = RagProjectionResponse["items"][number];

interface SummariesViewProps {
  onInspectTrace: (traceId: string) => void;
  selectedTraceId?: string;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function originalTraceAtMs(summary: RagSummaryRecord): number {
  return summary.lastEventTs ?? summary.mtimeMs;
}

function summaryAtMs(summary: RagSummaryRecord): number {
  return summary.summaryGeneratedAtMs ?? summary.updatedAtMs;
}

function sortSummariesByOriginalTraceTime(summaries: RagSummaryRecord[]): RagSummaryRecord[] {
  return [...summaries].sort((left, right) => (
    originalTraceAtMs(right) - originalTraceAtMs(left) ||
    summaryAtMs(right) - summaryAtMs(left) ||
    left.traceId.localeCompare(right.traceId)
  ));
}

function clusterColor(clusterId: number): string {
  const fixedColor = CLUSTER_COLORS[clusterId];
  if (fixedColor) return fixedColor;
  const hue = (clusterId * 137.508) % 360;
  return `hsl(${hue.toFixed(1)} 58% 42%)`;
}

function projectionTimeline(items: ProjectionItem[]): { oldestMs: number; latestMs: number; maxOffsetDays: number } | null {
  if (items.length === 0) return null;
  const times = items.map((item) => item.originalTraceAtMs);
  const oldestMs = Math.min(...times);
  const latestMs = Math.max(...times);
  const maxOffsetDays = Math.max(0, Math.ceil((latestMs - oldestMs - PROJECTION_WINDOW_DAYS * DAY_MS) / DAY_MS));
  return { oldestMs, latestMs, maxOffsetDays };
}

function projectionWindowRange(
  timeline: { latestMs: number; maxOffsetDays: number } | null,
  offsetDays: number,
): { startMs: number; endMs: number; offsetDays: number } | null {
  if (!timeline) return null;
  const effectiveOffsetDays = Math.min(Math.max(0, offsetDays), timeline.maxOffsetDays);
  const endMs = timeline.latestMs - effectiveOffsetDays * DAY_MS;
  return {
    startMs: endMs - PROJECTION_WINDOW_DAYS * DAY_MS,
    endMs,
    offsetDays: effectiveOffsetDays,
  };
}

function projectionDateLabel(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

function projectionRangeLabel(range: { startMs: number; endMs: number } | null): string {
  if (!range) return "No window";
  return `${projectionDateLabel(range.startMs)} - ${projectionDateLabel(range.endMs)}`;
}

function SectionList({ title, values }: { title: string; values: string[] }): JSX.Element | null {
  if (values.length === 0) return null;
  return (
    <section className="rag-detail-section">
      <h3>{title}</h3>
      <ul>
        {values.map((value, index) => (
          <li key={`${title}-${index}`}>{value}</li>
        ))}
      </ul>
    </section>
  );
}

function SearchResultDetail({ result }: { result: RagSearchResult }): JSX.Element {
  return (
    <div className="rag-detail-scroll">
      <section className="rag-detail-section">
        <h3>Goal</h3>
        <p>{result.userGoal || "-"}</p>
      </section>
      <section className="rag-detail-section">
        <h3>Outcome</h3>
        <p>{result.outcome || "-"}</p>
      </section>
      <SectionList title="Matched Text" values={result.snippets} />
    </div>
  );
}

function SummaryProjectionPlot({
  projection,
  projectionOffsetDays,
  onProjectionOffsetDaysChange,
  selectedTraceId,
  onSelectTrace,
}: {
  projection: RagProjectionResponse | null;
  projectionOffsetDays: number;
  onProjectionOffsetDaysChange: (offsetDays: number) => void;
  selectedTraceId: string;
  onSelectTrace: (traceId: string) => void;
}): JSX.Element {
  const items = projection?.items ?? [];
  const timeline = useMemo(() => projectionTimeline(items), [items]);
  const windowRange = useMemo(
    () => projectionWindowRange(timeline, projectionOffsetDays),
    [timeline, projectionOffsetDays],
  );
  const visibleItems = windowRange
    ? items.filter((item) => item.originalTraceAtMs >= windowRange.startMs && item.originalTraceAtMs <= windowRange.endMs)
    : [];
  const drawableItems = visibleItems.length >= 2 ? visibleItems : [];
  const [previewTraceId, setPreviewTraceId] = useState("");
  const previewItem = drawableItems.find((item) => item.traceId === previewTraceId);
  const previewRawLeft = previewItem ? 8 + previewItem.x * 84 : 50;
  const previewAlign = previewRawLeft < 32 ? "left" : previewRawLeft > 68 ? "right" : "center";
  const previewLeft = previewAlign === "left"
    ? Math.min(92, previewRawLeft + 2)
    : previewAlign === "right"
      ? Math.max(8, previewRawLeft - 2)
      : Math.min(72, Math.max(28, previewRawLeft));
  const previewRawTop = previewItem ? 8 + (1 - previewItem.y) * 84 : 50;
  const previewBelow = previewRawTop < 24;
  const previewTop = previewBelow ? Math.min(92, previewRawTop + 4) : Math.max(8, previewRawTop - 4);
  const totalCount = projection?.sourceCount ?? items.length;
  const pointLabel = items.length
    ? `${visibleItems.length}/${totalCount} visible`
    : projection && projection.sourceCount > items.length
      ? `${items.length}/${projection.sourceCount} points`
      : "empty";
  const emptyMessage = items.length > 0
    ? "Need at least two summaries in the selected seven-day window."
    : projection?.warnings[0] ?? "Need at least two summary embeddings.";
  const canWindowProjection = Boolean(timeline && timeline.maxOffsetDays > 0);
  const rangeLabel = projectionRangeLabel(windowRange);
  return (
    <section className="rag-projection" aria-label="Summary embedding map">
      <div className="rag-projection-head">
        <div className="rag-projection-title">
          <h3>Embedding Map</h3>
          <span className="mono">{pointLabel}</span>
        </div>
        {timeline && (
          <div className="rag-projection-window">
            <span className="mono">{rangeLabel}</span>
            <input
              type="range"
              min="0"
              max={timeline.maxOffsetDays}
              step="1"
              value={windowRange?.offsetDays ?? 0}
              disabled={!canWindowProjection}
              aria-label="Projection time window"
              onChange={(event) => onProjectionOffsetDaysChange(Number(event.currentTarget.value))}
            />
          </div>
        )}
      </div>
      <div className="rag-projection-plot" role="group" aria-label="Projected summary embeddings">
        {drawableItems.length > 0 ? (
          drawableItems.map((item) => {
            const color = clusterColor(item.clusterId);
            return (
              <button
                key={item.traceId}
                type="button"
                className={`rag-projection-point ${selectedTraceId === item.traceId ? "active" : ""}`}
                style={{
                  left: `${8 + item.x * 84}%`,
                  top: `${8 + (1 - item.y) * 84}%`,
                  backgroundColor: color,
                }}
                aria-label={`${item.title || item.traceId}, ${item.agent}, ${fmtTime(item.originalTraceAtMs)}`}
                aria-pressed={selectedTraceId === item.traceId}
                title={item.title || item.traceId}
                onMouseEnter={() => setPreviewTraceId(item.traceId)}
                onMouseLeave={() => setPreviewTraceId("")}
                onFocus={() => setPreviewTraceId(item.traceId)}
                onBlur={() => setPreviewTraceId("")}
                onClick={() => onSelectTrace(item.traceId)}
              />
            );
          })
        ) : (
          <div className="rag-projection-empty">
            {emptyMessage}
          </div>
        )}
        {previewItem && (
          <div
            className={`rag-projection-preview ${previewBelow ? "below" : ""} align-${previewAlign}`}
            style={{ left: `${previewLeft}%`, top: `${previewTop}%` }}
          >
            {previewItem.title || previewItem.traceId}
          </div>
        )}
      </div>
    </section>
  );
}

export function SummariesView({ onInspectTrace, selectedTraceId: selectedTraceIdProp = "" }: SummariesViewProps): JSX.Element {
  const [status, setStatus] = useState<RagIndexStatus | null>(null);
  const [summaries, setSummaries] = useState<RagSummaryRecord[]>([]);
  const [projection, setProjection] = useState<RagProjectionResponse | null>(null);
  const [projectionOffsetDays, setProjectionOffsetDays] = useState(0);
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RagSearchMode>("hybrid");
  const [agent, setAgent] = useState<AgentKind | "">("");
  const [summaryStatus, setSummaryStatus] = useState<(typeof STATUS_OPTIONS)[number]>("complete");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const userSelectedTraceRef = useRef(false);

  const selectedSummary = useMemo(
    () => summaries.find((summary) => summary.traceId === selectedTraceId) ?? null,
    [selectedTraceId, summaries],
  );
  const selectedResult = useMemo(
    () => results.find((result) => result.traceId === selectedTraceId) ?? null,
    [selectedTraceId, results],
  );
  const tocSummaries = useMemo(() => sortSummariesByOriginalTraceTime(summaries), [summaries]);
  const projectionMaxOffsetDays = useMemo(
    () => projectionTimeline(projection?.items ?? [])?.maxOffsetDays ?? 0,
    [projection],
  );
  const isSearching = query.trim().length > 0;
  const listTitle = isSearching ? "Search Results" : "Summaries";
  const listCount = isSearching ? `${results.length} results` : `${tocSummaries.length} rows`;

  function selectTraceFromUser(traceId: string): void {
    userSelectedTraceRef.current = true;
    setSelectedTraceId(traceId);
  }

  async function refreshBaseData(options: { showLoading?: boolean } = {}): Promise<void> {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    setError("");
    try {
      const statusResponse = await fetch("/api/rag/status");
      const statusJson = (await statusResponse.json()) as RagIndexStatus;
      setStatus(statusJson);
      const params = new URLSearchParams({ status: summaryStatus, limit: String(SUMMARY_LIST_LIMIT) });
      if (agent) params.set("agent", agent);
      const projectionParams = new URLSearchParams({ status: summaryStatus, limit: "5000" });
      if (agent) projectionParams.set("agent", agent);
      const [summariesResponse, projectionResponse] = await Promise.all([
        fetch(`/api/rag/summaries?${params.toString()}`),
        fetch(`/api/rag/projection?${projectionParams.toString()}`),
      ]);
      if (!summariesResponse.ok) throw new Error("failed to load summaries");
      if (!projectionResponse.ok) throw new Error("failed to load projection");
      const summariesJson = (await summariesResponse.json()) as { summaries: RagSummaryRecord[] };
      const projectionJson = (await projectionResponse.json()) as RagProjectionResponse;
      const sortedSummaries = sortSummariesByOriginalTraceTime(summariesJson.summaries);
      setSummaries(sortedSummaries);
      setProjection(projectionJson);
      setSelectedTraceId((current) => {
        if (current && sortedSummaries.some((summary) => summary.traceId === current)) return current;
        return sortedSummaries[0]?.traceId || "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    void refreshBaseData();
  }, [agent, summaryStatus]);

  useEffect(() => {
    setProjectionOffsetDays(0);
  }, [agent, summaryStatus]);

  useEffect(() => {
    setProjectionOffsetDays((current) => current > projectionMaxOffsetDays ? 0 : current);
  }, [projectionMaxOffsetDays]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshBaseData({ showLoading: false });
    }, SUMMARY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [agent, summaryStatus]);

  useEffect(() => {
    if (!selectedTraceIdProp) return;
    userSelectedTraceRef.current = false;
    setSelectedTraceId(selectedTraceIdProp);
  }, [selectedTraceIdProp]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSelectedTraceId((current) => {
        if (selectedTraceIdProp && !userSelectedTraceRef.current && summaries.some((summary) => summary.traceId === selectedTraceIdProp)) {
          return selectedTraceIdProp;
        }
        if (current && summaries.some((summary) => summary.traceId === current)) return current;
        return summaries[0]?.traceId || "";
      });
      return;
    }
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: trimmed, mode, limit: "50" });
      if (agent) params.set("agent", agent);
      setLoading(true);
      setError("");
      fetch(`/api/rag/search?${params.toString()}`)
        .then(async (response) => {
          if (!response.ok) throw new Error("search failed");
          return response.json() as Promise<{ results: RagSearchResult[]; embeddings: RagIndexStatus["embeddings"] }>;
        })
        .then((json) => {
          setResults(json.results);
          setStatus((current) => current ? { ...current, embeddings: json.embeddings } : current);
          setSelectedTraceId(json.results[0]?.traceId || "");
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [agent, mode, query, selectedTraceIdProp, summaries]);

  return (
    <div className="rag-view">
      <section className="rag-toolbar" aria-label="RAG summary controls">
        <input
          className="search rag-search"
          placeholder="Search summaries and redacted trace text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="rag-segmented" role="radiogroup" aria-label="Search mode">
          {(["hybrid", "lexical", "semantic"] as RagSearchMode[]).map((item) => (
            <button
              key={item}
              type="button"
              className={`mono rag-segment ${mode === item ? "active" : ""}`}
              onClick={() => setMode(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <select className="mono rag-select" value={agent} onChange={(event) => setAgent(event.target.value as AgentKind | "")}>
          {AGENT_OPTIONS.map((value) => (
            <option key={value || "all"} value={value}>{value || "all agents"}</option>
          ))}
        </select>
        <select
          className="mono rag-select"
          value={summaryStatus}
          onChange={(event) => setSummaryStatus(event.target.value as (typeof STATUS_OPTIONS)[number])}
        >
          {STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <button type="button" className="mono rag-refresh" onClick={() => void refreshBaseData()}>
          refresh
        </button>
      </section>

      <section className="rag-status-strip mono" aria-label="RAG status">
        <span>{status?.daemon.running ? `daemon ${status.daemon.pid ?? "-"}` : "daemon stopped"}</span>
        <span>{`complete ${status?.sessions.complete ?? 0}`}</span>
        <span>{`stale ${status?.sessions.stale ?? 0}`}</span>
        <span>{`failed ${status?.sessions.failed ?? 0}`}</span>
        <span>{`embeddings ${status?.embeddings.status ?? "missing"}`}</span>
        <span>{`last ${fmtTime(status?.lastRunAtMs ?? null)}`}</span>
      </section>

      {error && <div className="hero-warning mono">{error}</div>}

      <div className="rag-layout">
        <section className="panel rag-results-panel">
          <div className="panel-head">
            <h2>{listTitle}</h2>
            <span className="mono rag-count">{loading ? "loading" : listCount}</span>
          </div>
          <div className="rag-results-list">
            {isSearching ? (
              results.map((result) => (
                <button
                  key={result.traceId}
                  type="button"
                  className={`rag-result-row ${selectedTraceId === result.traceId ? "active" : ""}`}
                  onClick={() => selectTraceFromUser(result.traceId)}
                >
                  <span className="rag-result-main">
                    <strong>{result.title || result.traceId}</strong>
                    <span>{result.outcome}</span>
                  </span>
                  <span className="mono rag-result-time">{result.score.toFixed(4)}</span>
                </button>
              ))
            ) : (
              tocSummaries.map((summary) => (
                <button
                  key={summary.traceId}
                  type="button"
                  className={`rag-result-row ${selectedTraceId === summary.traceId ? "active" : ""}`}
                  onClick={() => selectTraceFromUser(summary.traceId)}
                >
                  <span className="rag-result-main">
                    <strong>{summary.summary?.title || summary.traceId}</strong>
                  </span>
                  <span className="mono rag-result-time">{fmtTime(originalTraceAtMs(summary))}</span>
                </button>
              ))
            )}
            {isSearching && results.length === 0 && <div className="empty">No search results</div>}
            {!isSearching && tocSummaries.length === 0 && <div className="empty">No summaries</div>}
          </div>
          <SummaryProjectionPlot
            projection={projection}
            projectionOffsetDays={projectionOffsetDays}
            onProjectionOffsetDaysChange={setProjectionOffsetDays}
            selectedTraceId={selectedTraceId}
            onSelectTrace={selectTraceFromUser}
          />
        </section>

        <section className="panel rag-detail-panel">
          <div className="panel-head rag-detail-head">
            <div>
              <h2>{selectedSummary?.summary?.title || selectedResult?.title || "Summary detail"}</h2>
              <div className="detail-head-meta mono">{selectedSummary?.traceId || selectedResult?.traceId || "-"}</div>
            </div>
            {(selectedSummary || selectedResult) && (
              <button
                type="button"
                className="mono rag-refresh"
                onClick={() => onInspectTrace((selectedSummary?.traceId ?? selectedResult?.traceId) as string)}
              >
                Inspect trace
              </button>
            )}
          </div>
          {selectedSummary?.summary ? (
            <div className="rag-detail-scroll">
              <section className="rag-detail-section">
                <h3>Goal</h3>
                <p>{selectedSummary.summary.userGoal}</p>
              </section>
              <section className="rag-detail-section">
                <h3>Outcome</h3>
                <p>{selectedSummary.summary.outcome}</p>
              </section>
              <SectionList title="Key Steps" values={selectedSummary.summary.keySteps} />
              <SectionList title="Files / Projects" values={selectedSummary.summary.filesOrProjects} />
              <SectionList title="Errors / Blockers" values={selectedSummary.summary.errorsOrBlockers} />
              <SectionList title="Workflow Observations" values={selectedSummary.summary.workflowObservations} />
              <SectionList title="Followups" values={selectedSummary.summary.followups} />
            </div>
          ) : selectedResult ? (
            <SearchResultDetail result={selectedResult} />
          ) : (
            <div className="empty">Select a complete summary.</div>
          )}
        </section>
      </div>
    </div>
  );
}
