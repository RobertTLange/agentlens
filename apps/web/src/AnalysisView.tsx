import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { AgentKind, AnalysisResponse, NamedCount } from "@agentlens/contracts";
import {
  buildAnalysisDashboardModel,
  type AnalysisAgentCardRow,
  type AnalysisOverviewMetric,
  type AnalysisSessionCardRow,
  type AnalysisSkillBarRow,
  type AnalysisSubagentBarRow,
} from "./analysis-view-model.js";

const AGENT_OPTIONS: Array<AgentKind | ""> = ["", "codex", "claude", "cursor", "gemini", "antigravity", "opencode", "pi", "unknown"];
const SINCE_OPTIONS = ["", "24h", "7d", "30d", "custom"] as const;
const DEFAULT_SINCE_MODE: (typeof SINCE_OPTIONS)[number] = "7d";

interface AnalysisViewProps {
  onInspectTrace: (traceId: string) => void;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function fmtRuntime(analysis: AnalysisResponse | null): string {
  if (!analysis?.runtime) return `generated ${fmtTime(analysis?.summary.generatedAtMs ?? null)}`;
  const cacheLabel = analysis.runtime.cache === "hit"
    ? "cache hit"
    : analysis.runtime.cache === "stale"
      ? "refreshing cached data"
      : analysis.runtime.cache === "inflight"
      ? "joined build"
      : `built in ${fmtDuration(analysis.runtime.buildDurationMs)}`;
  return `generated ${fmtTime(analysis.summary.generatedAtMs)} · ${cacheLabel}`;
}

function fmtNamedCounts(rows: NamedCount[]): string {
  if (rows.length === 0) return "-";
  return rows.map((row) => `${row.name} ${row.count}`).join(", ");
}

function fmtByAgent(rows: Array<{ agent: AgentKind; count: number }>): string {
  if (rows.length === 0) return "-";
  return rows.map((row) => `${row.agent} ${row.count}`).join(", ");
}

function pctStyle(name: string, value: number): CSSProperties {
  return { [name]: `${Math.max(0, Math.min(100, value))}%` } as CSSProperties;
}

function OverviewMetricCard({ metric }: { metric: AnalysisOverviewMetric }): JSX.Element {
  return (
    <div className={`analysis-overview-card analysis-overview-${metric.tone}`}>
      <span className="analysis-overview-label">{metric.label}</span>
      <span className="mono analysis-overview-value">{metric.value}</span>
      <span className="mono analysis-overview-detail">{metric.detail}</span>
    </div>
  );
}

function loadingTitle(since: string): string {
  return since ? "Building recent analysis" : "Building all-time analysis";
}

function LoadingPanel({ since }: { since: string }): JSX.Element {
  return (
    <section className="panel analysis-loading-panel" aria-label="Analysis loading">
      <div className="analysis-loading-copy">
        <h2>{loadingTitle(since)}</h2>
        <p>Scanning sessions and skill signals.</p>
      </div>
      <div className="analysis-loading-grid" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function SkillBar({ row }: { row: AnalysisSkillBarRow }): JSX.Element {
  return (
    <article className="analysis-skill-bar" aria-label={`${row.name}: ${row.totalCount} total uses`}>
      <div className="analysis-bar-row-head">
        <div>
          <h3>{row.name}</h3>
          <span className="mono">{row.inventoryStatus} · {row.sessionCount.toLocaleString()} sessions</span>
        </div>
        <strong className="mono">{row.totalCount.toLocaleString()} total uses</strong>
      </div>
      <div className="analysis-stacked-track">
        <span className="analysis-stacked-fill" style={pctStyle("--bar-width", row.totalWidthPct)}>
          <span
            className="analysis-segment analysis-segment-explicit"
            style={pctStyle("--segment-width", row.explicitPct)}
            aria-label={`explicit ${row.explicitCount}`}
          />
          <span
            className="analysis-segment analysis-segment-inferred"
            style={pctStyle("--segment-width", row.inferredPct)}
            aria-label={`inferred ${row.inferredCount}`}
          />
        </span>
      </div>
      <div className="analysis-bar-meta mono">
        <span>explicit {row.explicitCount.toLocaleString()}</span>
        <span>inferred {row.inferredCount.toLocaleString()}</span>
        <span>{row.byAgentLabel}</span>
      </div>
    </article>
  );
}

function AgentCard({ row }: { row: AnalysisAgentCardRow }): JSX.Element {
  return (
    <article className={`analysis-agent-card ${row.kindClass}`}>
      <div className="analysis-agent-head">
        <span className="analysis-agent-icon" aria-hidden="true">
          {row.icon ? <img src={row.icon} alt="" /> : row.agent.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h3>{row.agent}</h3>
          <span className="mono">{row.detectorSupport}</span>
        </div>
      </div>
      <div className="analysis-agent-stat-grid">
        <span><strong className="mono">{row.sessionCount.toLocaleString()}</strong> sessions</span>
        <span><strong className="mono">{row.totalSkillCount.toLocaleString()}</strong> skill uses</span>
        <span><strong className="mono">{row.subagentSpawnCount.toLocaleString()}</strong> spawns</span>
      </div>
      <div className="analysis-mini-bars">
        <label>
          <span className="mono">skill share</span>
          <i style={pctStyle("--bar-width", row.skillSharePct)} />
        </label>
        <label>
          <span className="mono">session share</span>
          <i style={pctStyle("--bar-width", row.sessionSharePct)} />
        </label>
      </div>
    </article>
  );
}

function SubagentBar({ row }: { row: AnalysisSubagentBarRow }): JSX.Element {
  return (
    <article className="analysis-subagent-bar">
      <div className="analysis-bar-row-head">
        <div>
          <h3>{row.name}</h3>
          <span className="mono">{row.sessionCount.toLocaleString()} sessions · {row.byAgentLabel}</span>
        </div>
        <strong className="mono">{row.spawnCount.toLocaleString()}</strong>
      </div>
      <div className="analysis-meter-track">
        <span style={pctStyle("--bar-width", row.widthPct)} />
      </div>
    </article>
  );
}

function SessionCard({ row, onInspectTrace }: { row: AnalysisSessionCardRow; onInspectTrace: (traceId: string) => void }): JSX.Element {
  return (
    <article className="analysis-session-card">
      <div className="analysis-session-main">
        <span className="mono analysis-session-id">{row.sessionId || row.traceId}</span>
        <span className="analysis-session-agent">{row.agent}</span>
        <button type="button" className="mono analysis-inspect-button" onClick={() => onInspectTrace(row.traceId)}>
          Inspect
        </button>
      </div>
      <div className="analysis-session-meter" aria-label={`${row.activityCount} detected activities`}>
        <span style={pctStyle("--bar-width", row.activityWidthPct)} />
      </div>
      <div className="analysis-session-stats mono">
        <span>{row.explicitSkillCount.toLocaleString()} explicit</span>
        <span>{row.inferredSkillCount.toLocaleString()} inferred</span>
        <span>{row.subagentSpawnCount.toLocaleString()} spawns</span>
        <span>{fmtTime(row.lastEventTs ?? row.mtimeMs)}</span>
      </div>
      <p><strong>Skills</strong> {row.topSkillsLabel}</p>
      <p><strong>Subagents</strong> {row.topSubagentsLabel}</p>
    </article>
  );
}

export function AnalysisView({ onInspectTrace }: AnalysisViewProps): JSX.Element {
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [agent, setAgent] = useState<AgentKind | "">("");
  const [sinceMode, setSinceMode] = useState<(typeof SINCE_OPTIONS)[number]>(DEFAULT_SINCE_MODE);
  const [customSince, setCustomSince] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [refreshCount, setRefreshCount] = useState(0);

  const since = sinceMode === "custom" ? customSince.trim() : sinceMode;
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (agent) params.set("agent", agent);
    if (since) params.set("since", since);
    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
  }, [agent, since]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setAnalysis(null);
    if (sinceMode === "custom" && !since) {
      setLoading(false);
      setError("Enter a custom range, such as 14d, to load analysis.");
      return;
    }
    fetch(`/api/analysis${query}`)
      .then(async (response) => {
        const json = (await response.json()) as AnalysisResponse | { error?: string };
        if (!response.ok) {
          throw new Error("error" in json && json.error ? json.error : "failed to load analysis");
        }
        return json as AnalysisResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setAnalysis(json);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, refreshCount, sinceMode, since]);

  const summary = analysis?.summary;
  const noTraces = summary ? summary.traceCount === 0 : false;
  const noSupported = summary ? summary.traceCount > 0 && summary.supportedTraceCount === 0 : false;
  const noObserved = summary ? summary.totalSkillCount === 0 && summary.subagentSpawnCount === 0 : false;
  const dashboard = useMemo(() => (analysis ? buildAnalysisDashboardModel(analysis) : null), [analysis]);

  const highlightedSession = dashboard?.sessionCards[0];
  const leadingSkill = dashboard?.skillBars[0];

  return (
    <div className="analysis-view" aria-busy={loading}>
      <section className="analysis-intro">
        <div>
          <span className="analysis-eyebrow">WORKFLOW INSIGHTS</span>
          <h2>Understand how your agents work</h2>
          <p>Explore skill usage and delegation, review your setup, and open the sessions behind the numbers.</p>
        </div>
        <button type="button" className="analysis-inspect-button" disabled={loading} onClick={() => setRefreshCount((count) => count + 1)}>
          {loading ? "Refreshing…" : error ? "Retry analysis" : "Refresh analysis"}
        </button>
      </section>
      <section className="analysis-toolbar" aria-label="Analysis controls">
        <label className="analysis-filter">
          Agent
          <select aria-label="Agent" className="analysis-select" value={agent} onChange={(event) => setAgent(event.target.value as AgentKind | "")}>
            {AGENT_OPTIONS.map((value) => (
              <option key={value || "all"} value={value}>{value || "all agents"}</option>
            ))}
          </select>
        </label>
        <label className="analysis-filter">
          Time range
          <select
            aria-label="Time range"
            className="analysis-select"
            value={sinceMode}
            onChange={(event) => setSinceMode(event.target.value as (typeof SINCE_OPTIONS)[number])}
          >
            <option value="">All time</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {sinceMode === "custom" && (
          <input
            className="search analysis-custom-since"
            aria-label="Custom time range"
            value={customSince}
            placeholder="e.g. 14d"
            onChange={(event) => setCustomSince(event.target.value)}
          />
        )}
        <span className="mono analysis-loading">{loading ? "loading" : fmtRuntime(analysis)}</span>
      </section>

      {error && <div className="analysis-notice" role="alert">{error}</div>}
      {loading && !analysis && !error && <LoadingPanel since={since} />}
      {noTraces && <div className="analysis-notice">No sessions indexed for this selection. Try a wider time range or select all agents.</div>}
      {noSupported && <div className="analysis-notice">No supported sessions in this selection. Skill and delegation detection currently covers Codex and Claude; other agents still appear in Source mix.</div>}
      {noObserved && !noTraces && !noSupported && <div className="analysis-notice">No skills or subagents observed in this selection. Try a wider range, or inspect a session to see its raw activity.</div>}

      {analysis && (
        <>
          {analysis.inventory.warnings.length > 0 && (
            <section className="analysis-warning-list mono" aria-label="Inventory warnings">
              {analysis.inventory.warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </section>
          )}

          {dashboard && (
            <>
              <section className="analysis-overview" aria-label="Analysis overview">
                <div className="analysis-section-title">
                  <h2>Analysis overview</h2>
                  <span className="mono">detectors: codex, claude</span>
                </div>
                <div className="analysis-overview-grid">
                  {dashboard.overview.map((metric) => (
                    <OverviewMetricCard key={metric.label} metric={metric} />
                  ))}
                </div>
              </section>

              <details className="analysis-notice" aria-label="How to read this analysis">
                <summary>How to read these insights</summary>
                <p>Explicit uses are recorded in traces. Inferred uses are text matches and may include mentions rather than invocations. More activity does not necessarily mean better results.</p>
                {summary && summary.supportedTraceCount < summary.traceCount && (
                  <p><strong>Partial coverage:</strong> {summary.traceCount - summary.supportedTraceCount} sessions have no supported skill detector. Their missing signals are not evidence of zero usage.</p>
                )}
                {analysis.runtime?.cache === "stale" && <p>Showing cached results while the server refreshes. Refresh analysis shortly to retrieve the latest results.</p>}
              </details>

              <section className="analysis-insights" aria-label="Useful insights">
                <article className="analysis-insight-card">
                  <span className="analysis-eyebrow">SKILL USAGE</span>
                  <h3>{leadingSkill?.name ?? "No skill signals yet"}</h3>
                  <p>{leadingSkill
                    ? `Most observed skill: ${leadingSkill.totalCount.toLocaleString()} ${leadingSkill.totalCount === 1 ? "use" : "uses"} across ${leadingSkill.sessionCount.toLocaleString()} ${leadingSkill.sessionCount === 1 ? "session" : "sessions"} in this selection.`
                    : "Choose a wider range to look for recorded skill usage."}</p>
                  <a href="#analysis-skills">Explore skill usage →</a>
                </article>
                <article className="analysis-insight-card">
                  <span className="analysis-eyebrow">CONFIGURATION REVIEW</span>
                  <h3>{analysis.inventory.unusedConfiguredSkills.length.toLocaleString()} {analysis.inventory.unusedConfiguredSkills.length === 1 ? "skill" : "skills"} without observed usage</h3>
                  <p>Review these against your workflow. A skill may be useful outside this time range; missing usage alone is not a reason to remove it.</p>
                  <a href="#analysis-inventory">Review configured skills →</a>
                </article>
                <article className="analysis-insight-card">
                  <span className="analysis-eyebrow">SESSION SPOTLIGHT</span>
                  <h3>{highlightedSession ? "Explore the most active workflow" : "No session highlights yet"}</h3>
                  <p>{highlightedSession
                    ? `${highlightedSession.activityCount.toLocaleString()} skill and delegation signals. Inspect the trace to understand how this session used them.`
                    : "Highlights appear when skills or subagent activity are detected."}</p>
                  {highlightedSession && <button type="button" className="analysis-insight-action" onClick={() => onInspectTrace(highlightedSession.traceId)}>Inspect highlighted session →</button>}
                </article>
              </section>

              <section className="analysis-dashboard-grid" aria-label="Analysis dashboard">
                <section id="analysis-skills" className="panel analysis-visual-panel analysis-skill-panel">
                  <div className="panel-head">
                    <h2>Skill adoption</h2>
                    <span className="mono">top {dashboard.skillBars.length} of {analysis.skills.length}</span>
                  </div>
                  <div className="analysis-skill-bars">
                    {dashboard.skillBars.map((row) => <SkillBar key={row.name} row={row} />)}
                    {dashboard.skillBars.length === 0 && <span className="empty">No skill usage detected</span>}
                  </div>
                </section>

                <aside className="analysis-side-stack">
                  <section className="panel analysis-visual-panel">
                    <div className="panel-head">
                      <h2>Source mix</h2>
                      <span className="mono">{analysis.byAgent.length} agents</span>
                    </div>
                    <div className="analysis-agent-grid">
                      {dashboard.agentCards.map((row) => <AgentCard key={row.agent} row={row} />)}
                    </div>
                  </section>

                  <section className="panel analysis-visual-panel">
                    <div className="panel-head">
                      <h2>Subagent roles</h2>
                      <span className="mono">{analysis.subagents.length} rows</span>
                    </div>
                    <div className="analysis-subagent-bars">
                      {dashboard.subagentBars.map((row) => <SubagentBar key={row.name} row={row} />)}
                      {dashboard.subagentBars.length === 0 && <span className="empty">No subagent spawns detected</span>}
                    </div>
                  </section>
                </aside>
              </section>

              <section className="panel analysis-visual-panel">
                <div className="panel-head">
                  <h2>Session highlights</h2>
                  <span className="mono">Ranked by detected skills + subagent spawns</span>
                </div>
                <div className="analysis-session-grid">
                  {dashboard.sessionCards.map((row) => (
                    <SessionCard key={row.traceId} row={row} onInspectTrace={onInspectTrace} />
                  ))}
                  {dashboard.sessionCards.length === 0 && <span className="empty">No active sessions to rank</span>}
                </div>
              </section>
            </>
          )}

          <section id="analysis-inventory" className="panel analysis-section analysis-inventory-panel">
            <div className="panel-head">
              <h2>Unused Configured Skills</h2>
              <span className="mono">{analysis.inventory.unusedConfiguredSkills.length} rows</span>
            </div>
            <p className="analysis-panel-description">Configured skills with no detected use in this selection. Check a wider range before changing your setup.</p>
            <div className="analysis-skill-list">
              {analysis.inventory.unusedConfiguredSkills.map((skill) => (
                <span key={skill} className="mono">{skill}</span>
              ))}
              {analysis.inventory.unusedConfiguredSkills.length === 0 && <span className="empty">No unused configured skills</span>}
            </div>
          </section>

          <details className="panel analysis-section analysis-detail-section">
            <summary className="panel-head analysis-details-toggle">Detailed data · source agents, skills, roles, and sessions</summary>
            <div className="analysis-detail-grid">
              <section>
                <div className="analysis-detail-head">
                  <h3>Source Agents</h3>
                  <span className="mono">{analysis.byAgent.length} rows</span>
                </div>
                <div className="analysis-table-scroll">
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Support</th>
                        <th>Sessions</th>
                        <th>Explicit</th>
                        <th>Inferred</th>
                        <th>Skill Uses</th>
                        <th>Subagent Spawns</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.byAgent.map((row) => (
                        <tr key={row.agent}>
                          <td>{row.agent}</td>
                          <td>{row.detectorSupport}</td>
                          <td>{row.sessionCount}</td>
                          <td>{row.explicitSkillCount}</td>
                          <td>{row.inferredSkillCount}</td>
                          <td>{row.totalSkillCount}</td>
                          <td>{row.subagentSpawnCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <div className="analysis-detail-head">
                  <h3>Skills</h3>
                  <span className="mono">{analysis.skills.length} rows</span>
                </div>
                <div className="analysis-table-scroll">
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>Skill</th>
                        <th>Status</th>
                        <th>Explicit</th>
                        <th>Inferred</th>
                        <th>Total</th>
                        <th>Sessions</th>
                        <th>By Agent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.skills.map((row) => (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td>{row.inventoryStatus}</td>
                          <td>{row.explicitCount}</td>
                          <td>{row.inferredCount}</td>
                          <td>{row.totalCount}</td>
                          <td>{row.sessionCount}</td>
                          <td>{fmtByAgent(row.byAgent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <div className="analysis-detail-head">
                  <h3>Subagents</h3>
                  <span className="mono">{analysis.subagents.length} rows</span>
                </div>
                <div className="analysis-table-scroll">
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Spawns</th>
                        <th>Sessions</th>
                        <th>By Agent</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.subagents.map((row) => (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td>{row.spawnCount}</td>
                          <td>{row.sessionCount}</td>
                          <td>{fmtByAgent(row.byAgent)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section>
                <div className="analysis-detail-head">
                  <h3>Top Sessions</h3>
                  <span className="mono">{analysis.topSessions.length} rows</span>
                </div>
                <div className="analysis-table-scroll">
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>Session</th>
                        <th>Agent</th>
                        <th>Explicit</th>
                        <th>Inferred</th>
                        <th>Spawns</th>
                        <th>Top Skills</th>
                        <th>Top Subagents</th>
                        <th>Updated</th>
                        <th>Inspect</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.topSessions.map((row) => (
                        <tr key={row.traceId}>
                          <td className="mono">{row.sessionId || row.traceId}</td>
                          <td>{row.agent}</td>
                          <td>{row.explicitSkillCount}</td>
                          <td>{row.inferredSkillCount}</td>
                          <td>{row.subagentSpawnCount}</td>
                          <td>{fmtNamedCounts(row.topSkills)}</td>
                          <td>{fmtNamedCounts(row.topSubagents)}</td>
                          <td>{fmtTime(row.lastEventTs ?? row.mtimeMs)}</td>
                          <td>
                            <button type="button" className="mono analysis-inspect-button" onClick={() => onInspectTrace(row.traceId)}>
                              Inspect
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </div>
          </details>

          <section className="analysis-coverage-note mono">
            Supported detectors: codex, claude. Other source agents are scanned and marked unsupported for v1-specific detection.
          </section>
        </>
      )}
    </div>
  );
}
