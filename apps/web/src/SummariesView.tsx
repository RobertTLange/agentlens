import { useEffect, useMemo, useState } from "react";
import type {
  AgentKind,
  RagIndexStatus,
  RagProjectionResponse,
  RagSearchMode,
  RagSearchResult,
  RagSummaryRecord,
} from "@agentlens/contracts";

const SEARCH_DEBOUNCE_MS = 250;
const AGENT_OPTIONS: Array<AgentKind | ""> = ["", "codex", "claude", "cursor", "gemini", "opencode", "pi", "unknown"];
const STATUS_OPTIONS = ["complete", "stale", "failed", "skipped", "pending"] as const;
const CLUSTER_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0f766e", "#be123c", "#4b5563"];

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

function SummaryProjectionPlot({
  projection,
  selectedTraceId,
  onSelectTrace,
}: {
  projection: RagProjectionResponse | null;
  selectedTraceId: string;
  onSelectTrace: (traceId: string) => void;
}): JSX.Element {
  const items = projection?.items ?? [];
  const [previewTraceId, setPreviewTraceId] = useState("");
  const previewItem = items.find((item) => item.traceId === previewTraceId);
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
  return (
    <section className="rag-projection" aria-label="Summary embedding map">
      <div className="rag-projection-head">
        <h3>Embedding Map</h3>
        <span className="mono">{items.length ? `${items.length} points` : "empty"}</span>
      </div>
      <div className="rag-projection-plot" role="group" aria-label="Projected summary embeddings">
        {items.length > 0 ? (
          items.map((item) => {
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
            {projection?.warnings[0] ?? "Need at least two summary embeddings."}
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
  const [results, setResults] = useState<RagSearchResult[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RagSearchMode>("hybrid");
  const [agent, setAgent] = useState<AgentKind | "">("");
  const [summaryStatus, setSummaryStatus] = useState<(typeof STATUS_OPTIONS)[number]>("complete");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const selectedSummary = useMemo(
    () => summaries.find((summary) => summary.traceId === selectedTraceId) ?? null,
    [selectedTraceId, summaries],
  );
  const selectedResult = useMemo(
    () => results.find((result) => result.traceId === selectedTraceId) ?? null,
    [selectedTraceId, results],
  );
  const tocSummaries = useMemo(() => sortSummariesByOriginalTraceTime(summaries), [summaries]);

  async function refreshBaseData(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const statusResponse = await fetch("/api/rag/status");
      const statusJson = (await statusResponse.json()) as RagIndexStatus;
      setStatus(statusJson);
      const params = new URLSearchParams({ status: summaryStatus, limit: "200" });
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
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshBaseData();
  }, [agent, summaryStatus]);

  useEffect(() => {
    if (!selectedTraceIdProp) return;
    setSelectedTraceId(selectedTraceIdProp);
  }, [selectedTraceIdProp]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
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
  }, [agent, mode, query]);

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
            <h2>Summaries</h2>
            <span className="mono rag-count">{loading ? "loading" : `${tocSummaries.length} rows`}</span>
          </div>
          <div className="rag-results-list">
            {tocSummaries.map((summary) => (
              <button
                key={summary.traceId}
                type="button"
                className={`rag-result-row ${selectedTraceId === summary.traceId ? "active" : ""}`}
                onClick={() => setSelectedTraceId(summary.traceId)}
              >
                <span className="rag-result-main">
                  <strong>{summary.summary?.title || summary.traceId}</strong>
                </span>
                <span className="mono rag-result-time">{fmtTime(originalTraceAtMs(summary))}</span>
              </button>
            ))}
            {tocSummaries.length === 0 && <div className="empty">No summaries</div>}
          </div>
          <SummaryProjectionPlot projection={projection} selectedTraceId={selectedTraceId} onSelectTrace={setSelectedTraceId} />
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
          ) : (
            <div className="empty">Select a complete summary.</div>
          )}
        </section>
      </div>
    </div>
  );
}
