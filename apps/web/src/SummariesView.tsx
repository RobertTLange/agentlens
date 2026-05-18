import { useEffect, useMemo, useState } from "react";
import type {
  AgentKind,
  RagIndexStatus,
  RagSearchMode,
  RagSearchResult,
  RagSummaryRecord,
} from "@agentlens/contracts";

const SEARCH_DEBOUNCE_MS = 250;
const AGENT_OPTIONS: Array<AgentKind | ""> = ["", "codex", "claude", "cursor", "gemini", "opencode", "pi", "unknown"];
const STATUS_OPTIONS = ["complete", "stale", "failed", "skipped", "pending"] as const;

interface SummariesViewProps {
  onInspectTrace: (traceId: string) => void;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function scoreLabel(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "-";
}

function asResult(summary: RagSummaryRecord): RagSearchResult {
  return {
    traceId: summary.traceId,
    sessionId: summary.sessionId,
    agent: summary.agent,
    path: summary.path,
    title: summary.summary?.title ?? summary.traceId,
    userGoal: summary.summary?.userGoal ?? "",
    outcome: summary.summary?.outcome ?? "",
    updatedAtMs: summary.updatedAtMs,
    summaryGeneratedAtMs: summary.summaryGeneratedAtMs,
    score: 0,
    matchedKinds: ["summary"],
    snippets: summary.summaryText ? [summary.summaryText.slice(0, 220)] : [],
  };
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

export function SummariesView({ onInspectTrace }: SummariesViewProps): JSX.Element {
  const [status, setStatus] = useState<RagIndexStatus | null>(null);
  const [summaries, setSummaries] = useState<RagSummaryRecord[]>([]);
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
  const displayed = query.trim() ? results : summaries.map(asResult);

  async function refreshBaseData(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const statusResponse = await fetch("/api/rag/status");
      const statusJson = (await statusResponse.json()) as RagIndexStatus;
      setStatus(statusJson);
      const params = new URLSearchParams({ status: summaryStatus, limit: "200" });
      if (agent) params.set("agent", agent);
      const summariesResponse = await fetch(`/api/rag/summaries?${params.toString()}`);
      if (!summariesResponse.ok) throw new Error("failed to load summaries");
      const summariesJson = (await summariesResponse.json()) as { summaries: RagSummaryRecord[] };
      setSummaries(summariesJson.summaries);
      setSelectedTraceId((current) => current || summariesJson.summaries[0]?.traceId || "");
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
          setSelectedTraceId((current) => current || json.results[0]?.traceId || "");
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
            <span className="mono rag-count">{loading ? "loading" : `${displayed.length} rows`}</span>
          </div>
          <div className="rag-results-list">
            {displayed.map((result, index) => (
              <button
                key={`${result.traceId}-${index}`}
                type="button"
                className={`rag-result-row ${selectedTraceId === result.traceId ? "active" : ""}`}
                onClick={() => setSelectedTraceId(result.traceId)}
              >
                <span className={`agent-badge agent-${result.agent}`}>{result.agent}</span>
                <span className="rag-result-main">
                  <strong>{result.title || result.traceId}</strong>
                  <span>{result.outcome || result.userGoal || result.path}</span>
                  {result.snippets[0] && <em>{result.snippets[0]}</em>}
                </span>
                <span className="mono rag-score">{query.trim() ? scoreLabel(result.score) : selectedSummary?.status ?? "complete"}</span>
              </button>
            ))}
            {displayed.length === 0 && <div className="empty">No summaries</div>}
          </div>
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
