import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentKind,
  DailyWorkSummaryRecord,
  RagIndexStatus,
  RagProjectionResponse,
  RagSearchMode,
  RagSearchResult,
  RagSummaryRecord,
} from "@agentlens/contracts";

const SEARCH_DEBOUNCE_MS = 250;
const SUMMARY_REFRESH_MS = 30_000;
const SUMMARY_LIST_PAGE_SIZE = 100;
const SUMMARY_LIST_MAX_LIMIT = 5000;
const PROJECTION_LIMIT = 500;
const DAILY_REPORT_LIMIT = 60;
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

function sortDailyReports(reports: DailyWorkSummaryRecord[]): DailyWorkSummaryRecord[] {
  return [...reports].sort((left, right) => right.scheduledAtMs - left.scheduledAtMs || left.id.localeCompare(right.id));
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
  const [viewMode, setViewMode] = useState<"sessions" | "daily">("sessions");
  const [status, setStatus] = useState<RagIndexStatus | null>(null);
  const [summaries, setSummaries] = useState<RagSummaryRecord[]>([]);
  const [dailyReports, setDailyReports] = useState<DailyWorkSummaryRecord[]>([]);
  const [projection, setProjection] = useState<RagProjectionResponse | null>(null);
  const [projectionVisible, setProjectionVisible] = useState(false);
  const [projectionOffsetDays, setProjectionOffsetDays] = useState(0);
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [selectedDailyId, setSelectedDailyId] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RagSearchMode>("hybrid");
  const [agent, setAgent] = useState<AgentKind | "">("");
  const [summaryStatus, setSummaryStatus] = useState<(typeof STATUS_OPTIONS)[number]>("complete");
  const [summaryListLimit, setSummaryListLimit] = useState(SUMMARY_LIST_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const userSelectedTraceRef = useRef(false);
  const projectionRequestRef = useRef(0);
  const detailRequestedTraceIdsRef = useRef<Set<string>>(new Set());

  const selectedSummary = useMemo(
    () => summaries.find((summary) => summary.traceId === selectedTraceId) ?? null,
    [selectedTraceId, summaries],
  );
  const selectedResult = useMemo(
    () => results.find((result) => result.traceId === selectedTraceId) ?? null,
    [selectedTraceId, results],
  );
  const tocSummaries = useMemo(() => sortSummariesByOriginalTraceTime(summaries), [summaries]);
  const dailyToc = useMemo(() => sortDailyReports(dailyReports), [dailyReports]);
  const selectedDailyReport = useMemo(
    () => dailyReports.find((report) => report.id === selectedDailyId) ?? null,
    [dailyReports, selectedDailyId],
  );
  const projectionMaxOffsetDays = useMemo(
    () => projectionTimeline(projection?.items ?? [])?.maxOffsetDays ?? 0,
    [projection],
  );
  const isSearching = query.trim().length > 0;
  const listTitle = viewMode === "daily" ? "Daily Reports" : isSearching ? "Search Results" : "Summaries";
  const canLoadMoreSummaries = viewMode !== "daily" && !isSearching && tocSummaries.length >= summaryListLimit && summaryListLimit < SUMMARY_LIST_MAX_LIMIT;
  const listCount = viewMode === "daily"
    ? `${dailyToc.length} reports`
    : isSearching
      ? `${results.length} results`
      : canLoadMoreSummaries
        ? `${tocSummaries.length}+ rows`
        : `${tocSummaries.length} rows`;

  function selectTraceFromUser(traceId: string): void {
    userSelectedTraceRef.current = true;
    detailRequestedTraceIdsRef.current.add(traceId);
    setSelectedTraceId(traceId);
  }

  function loadMoreSummariesNearBottom(scroller: HTMLDivElement): void {
    if (viewMode === "daily" || isSearching) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 96) return;
    setSummaryListLimit((current) => {
      if (tocSummaries.length < current || current >= SUMMARY_LIST_MAX_LIMIT) return current;
      return Math.min(SUMMARY_LIST_MAX_LIMIT, current + SUMMARY_LIST_PAGE_SIZE);
    });
  }

  async function refreshProjectionData(requestId: number): Promise<void> {
    const projectionParams = new URLSearchParams({ status: summaryStatus, limit: String(PROJECTION_LIMIT) });
    if (agent) projectionParams.set("agent", agent);
    try {
      const projectionResponse = await fetch(`/api/rag/projection?${projectionParams.toString()}`);
      if (!projectionResponse.ok) throw new Error("failed to load projection");
      const projectionJson = (await projectionResponse.json()) as RagProjectionResponse;
      if (projectionRequestRef.current === requestId) setProjection(projectionJson);
    } catch {
      if (projectionRequestRef.current === requestId) setProjection(null);
    }
  }

  async function refreshBaseData(options: { showLoading?: boolean } = {}): Promise<void> {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    setError("");
    const projectionRequestId = projectionRequestRef.current + 1;
    projectionRequestRef.current = projectionRequestId;
    if (!projectionVisible) setProjection(null);
    try {
      const params = new URLSearchParams({ status: summaryStatus, limit: String(summaryListLimit), summary_text: "0", summary: "title" });
      if (agent) params.set("agent", agent);
      const [statusResponse, summariesResponse] = await Promise.all([
        fetch("/api/rag/status"),
        fetch(`/api/rag/summaries?${params.toString()}`),
      ]);
      if (!statusResponse.ok) throw new Error("failed to load RAG status");
      if (!summariesResponse.ok) throw new Error("failed to load summaries");
      const statusJson = (await statusResponse.json()) as RagIndexStatus;
      const summariesJson = (await summariesResponse.json()) as { summaries: RagSummaryRecord[] };
      const sortedSummaries = sortSummariesByOriginalTraceTime(summariesJson.summaries);
      setStatus(statusJson);
      setSummaries(sortedSummaries);
      setSelectedTraceId((current) => {
        if (current && sortedSummaries.some((summary) => summary.traceId === current)) return current;
        if (selectedTraceIdProp && sortedSummaries.some((summary) => summary.traceId === selectedTraceIdProp)) return selectedTraceIdProp;
        return "";
      });
      if (projectionVisible) void refreshProjectionData(projectionRequestId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function refreshDailyData(options: { showLoading?: boolean } = {}): Promise<void> {
    const showLoading = options.showLoading ?? true;
    if (showLoading) setLoading(true);
    setError("");
    try {
      const [statusResponse, reportsResponse] = await Promise.all([
        fetch("/api/rag/status"),
        fetch(`/api/rag/daily/reports?limit=${DAILY_REPORT_LIMIT}`),
      ]);
      if (!statusResponse.ok) throw new Error("failed to load RAG status");
      if (!reportsResponse.ok) throw new Error("failed to load daily reports");
      setStatus((await statusResponse.json()) as RagIndexStatus);
      const reportsJson = (await reportsResponse.json()) as { reports: DailyWorkSummaryRecord[] };
      const sortedReports = sortDailyReports(reportsJson.reports);
      setDailyReports(sortedReports);
      setSelectedDailyId((current) => {
        if (current && sortedReports.some((report) => report.id === current)) return current;
        return sortedReports[0]?.id || "";
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    if (viewMode === "daily") void refreshDailyData();
    else void refreshBaseData();
  }, [agent, summaryStatus, summaryListLimit, viewMode]);

  useEffect(() => {
    if (viewMode !== "sessions" || !projectionVisible) return;
    const requestId = projectionRequestRef.current + 1;
    projectionRequestRef.current = requestId;
    void refreshProjectionData(requestId);
  }, [agent, projectionVisible, summaryStatus, viewMode]);

  useEffect(() => {
    setProjectionOffsetDays(0);
  }, [agent, summaryStatus]);

  useEffect(() => {
    setProjectionOffsetDays((current) => current > projectionMaxOffsetDays ? 0 : current);
  }, [projectionMaxOffsetDays]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (viewMode === "daily") void refreshDailyData({ showLoading: false });
      else void refreshBaseData({ showLoading: false });
    }, SUMMARY_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [agent, summaryStatus, summaryListLimit, viewMode]);

  useEffect(() => {
    if (!selectedTraceIdProp) return;
    userSelectedTraceRef.current = false;
    setSelectedTraceId(selectedTraceIdProp);
  }, [selectedTraceIdProp]);

  useEffect(() => {
    const trimmed = query.trim();
    if (viewMode === "daily") return;
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
  }, [agent, mode, query, selectedTraceIdProp, summaries, viewMode]);

  useEffect(() => {
    if (viewMode !== "sessions" || isSearching || !selectedTraceId) return;
    if (!detailRequestedTraceIdsRef.current.has(selectedTraceId) && selectedTraceId !== selectedTraceIdProp) return;
    const current = summaries.find((summary) => summary.traceId === selectedTraceId);
    if (!current?.summary || current.summary.userGoal) return;
    let cancelled = false;
    fetch(`/api/rag/summaries/${encodeURIComponent(selectedTraceId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("failed to load summary detail");
        return response.json() as Promise<{ summary: RagSummaryRecord }>;
      })
      .then((json) => {
        if (cancelled) return;
        setSummaries((existing) => existing.map((summary) => summary.traceId === json.summary.traceId ? json.summary : summary));
      })
      .catch(() => {
        // Keep the compact row visible if the detail request fails.
      });
    return () => {
      cancelled = true;
    };
  }, [isSearching, selectedTraceId, summaries, viewMode]);

  return (
    <div className="rag-view">
      <section className="rag-toolbar" aria-label="RAG summary controls">
        <div className="rag-segmented rag-view-toggle" role="tablist" aria-label="Summary view">
          {(["sessions", "daily"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={viewMode === item}
              className={`mono rag-segment ${viewMode === item ? "active" : ""}`}
              onClick={() => setViewMode(item)}
            >
              {item}
            </button>
          ))}
        </div>
        {viewMode === "sessions" && (
          <>
            <input
              className="search rag-search"
              placeholder="Search summaries and redacted trace text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="rag-segmented rag-search-mode" role="radiogroup" aria-label="Search mode">
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
            <select
              className="mono rag-select"
              value={agent}
              onChange={(event) => {
                setAgent(event.target.value as AgentKind | "");
                setSummaryListLimit(SUMMARY_LIST_PAGE_SIZE);
              }}
            >
              {AGENT_OPTIONS.map((value) => (
                <option key={value || "all"} value={value}>{value || "all agents"}</option>
              ))}
            </select>
            <select
              className="mono rag-select"
              value={summaryStatus}
              onChange={(event) => {
                setSummaryStatus(event.target.value as (typeof STATUS_OPTIONS)[number]);
                setSummaryListLimit(SUMMARY_LIST_PAGE_SIZE);
              }}
            >
              {STATUS_OPTIONS.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </>
        )}
        <button type="button" className="mono rag-refresh" onClick={() => viewMode === "daily" ? void refreshDailyData() : void refreshBaseData()}>
          refresh
        </button>
      </section>

      <section className="rag-status-strip mono" aria-label="RAG status">
        <span>{status?.daemon.running ? `daemon ${status.daemon.pid ?? "-"}` : "daemon stopped"}</span>
        <span>{`complete ${status?.sessions.complete ?? 0}`}</span>
        <span>{`stale ${status?.sessions.stale ?? 0}`}</span>
        <span>{`failed ${status?.sessions.failed ?? 0}`}</span>
        <span>{`embeddings ${status?.embeddings.status ?? "missing"}`}</span>
        <span>{`daily ${status?.daily.lastStatus ?? "-"}`}</span>
        <span>{`last ${fmtTime(status?.lastRunAtMs ?? null)}`}</span>
      </section>

      {error && <div className="hero-warning mono">{error}</div>}

      <div className="rag-layout">
        <section className="panel rag-results-panel">
          <div className="panel-head">
            <h2>{listTitle}</h2>
            <span className="mono rag-count">{loading ? "loading" : listCount}</span>
          </div>
          <div className="rag-results-list" onScroll={(event) => loadMoreSummariesNearBottom(event.currentTarget)}>
            {viewMode === "daily" ? (
              dailyToc.map((report) => (
                <button
                  key={report.id}
                  type="button"
                  className={`rag-result-row ${selectedDailyId === report.id ? "active" : ""}`}
                  onClick={() => setSelectedDailyId(report.id)}
                >
                  <span className="rag-result-main">
                    <strong>{report.content?.title || report.id}</strong>
                    <span>{report.status}</span>
                  </span>
                  <span className="mono rag-result-time">{fmtTime(report.scheduledAtMs)}</span>
                </button>
              ))
            ) : isSearching ? (
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
            {viewMode === "daily" && dailyToc.length === 0 && <div className="empty">No daily reports</div>}
            {viewMode !== "daily" && isSearching && results.length === 0 && <div className="empty">No search results</div>}
            {viewMode !== "daily" && !isSearching && tocSummaries.length === 0 && <div className="empty">No summaries</div>}
          </div>
          {viewMode !== "daily" && !projectionVisible && (
            <div className="rag-result-actions">
              <button
                type="button"
                className="mono rag-refresh"
                onClick={() => setProjectionVisible(true)}
              >
                load map
              </button>
            </div>
          )}
          {viewMode !== "daily" && projectionVisible && (
            <SummaryProjectionPlot
              projection={projection}
              projectionOffsetDays={projectionOffsetDays}
              onProjectionOffsetDaysChange={setProjectionOffsetDays}
              selectedTraceId={selectedTraceId}
              onSelectTrace={selectTraceFromUser}
            />
          )}
        </section>

        <section className="panel rag-detail-panel">
          <div className="panel-head rag-detail-head">
            <div>
              <h2>{viewMode === "daily" ? selectedDailyReport?.content?.title || "Daily detail" : selectedSummary?.summary?.title || selectedResult?.title || "Summary detail"}</h2>
              <div className="detail-head-meta mono">{viewMode === "daily" ? selectedDailyReport?.id || "-" : selectedSummary?.traceId || selectedResult?.traceId || "-"}</div>
            </div>
            {viewMode !== "daily" && (selectedSummary || selectedResult) && (
              <button
                type="button"
                className="mono rag-refresh"
                onClick={() => onInspectTrace((selectedSummary?.traceId ?? selectedResult?.traceId) as string)}
              >
                Inspect trace
              </button>
            )}
          </div>
          {viewMode === "daily" && selectedDailyReport?.content ? (
            <div className="rag-detail-scroll">
              <section className="rag-detail-section">
                <h3>Window</h3>
                <p>{selectedDailyReport.content.windowLabel}</p>
              </section>
              <section className="rag-detail-section">
                <h3>Overview</h3>
                <p>{selectedDailyReport.content.overview}</p>
              </section>
              <SectionList title="Completed Work" values={selectedDailyReport.content.completedWork} />
              <SectionList title="Notable Sessions" values={selectedDailyReport.content.notableSessions} />
              <SectionList title="Files / Projects" values={selectedDailyReport.content.filesOrProjects} />
              <SectionList title="Tools / Workflows" values={selectedDailyReport.content.toolsOrWorkflows} />
              <SectionList title="Blockers" values={selectedDailyReport.content.blockers} />
              <SectionList title="Followups" values={selectedDailyReport.content.followups} />
            </div>
          ) : viewMode === "daily" && selectedDailyReport ? (
            <div className="rag-detail-scroll">
              <section className="rag-detail-section">
                <h3>Status</h3>
                <p>{selectedDailyReport.error || selectedDailyReport.status}</p>
              </section>
            </div>
          ) : viewMode === "daily" ? (
            <div className="empty">Select a daily report.</div>
          ) : selectedSummary?.summary ? (
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
