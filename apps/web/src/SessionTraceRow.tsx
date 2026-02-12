import type { SessionActivityStatus, TraceSummary } from "@agentlens/contracts";
import { iconForAgent, pathTail } from "./view-model.js";

interface SessionTraceRowProps {
  trace: TraceSummary;
  activityStatus: SessionActivityStatus;
  isActive: boolean;
  isPathExpanded: boolean;
  pulseSeq: number;
  onSelect: (traceId: string) => void;
  onTogglePath: (traceId: string) => void;
  rowRef: (node: HTMLDivElement | null) => void;
  fmtTime: (ms: number | null) => string;
}

export function SessionTraceRow(props: SessionTraceRowProps): JSX.Element {
  const { trace, activityStatus, isActive, isPathExpanded, pulseSeq, onSelect, onTogglePath, rowRef, fmtTime } = props;
  const traceIcon = iconForAgent(trace.agent);
  const sessionName = trace.sessionId || trace.id;
  const startMs = trace.firstEventTs ?? null;
  const updatedMs = Math.max(trace.lastEventTs ?? 0, trace.mtimeMs);
  const statusClass =
    activityStatus === "waiting_input"
      ? "status-waiting"
      : activityStatus === "running"
        ? "status-running"
        : "status-idle";
  const statusLabel =
    activityStatus === "waiting_input" ? "Waiting" : activityStatus === "running" ? "Running" : "Idle";

  return (
    <div
      className={`trace-row ${statusClass} ${isActive ? "active" : ""}`}
      data-trace-id={trace.id}
      ref={rowRef}
      onClick={() => onSelect(trace.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(trace.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <div key={`pulse-${pulseSeq}`} className={`trace-row-inner ${pulseSeq > 0 ? "pulse" : ""}`}>
        <div className="trace-topline">
          <span className="trace-session-name mono" title={sessionName}>
            {sessionName}
          </span>
          <div className="trace-topline-right">
            <span className={`trace-status-chip mono ${statusClass}`}>{statusLabel}</span>
            <span className="trace-agent-chip mono">{trace.agent}</span>
          </div>
        </div>
        <div className="trace-time-grid mono">
          <span className="trace-time-label">start</span>
          <span className="trace-time-value">{fmtTime(startMs)}</span>
          <span className="trace-time-label">updated</span>
          <span className="trace-time-value">{fmtTime(updatedMs)}</span>
        </div>
        <div className="trace-footer">
          <div className={`trace-path-box ${isPathExpanded ? "expanded" : ""}`}>
            <button
              type="button"
              className="trace-path-toggle mono"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePath(trace.id);
              }}
              aria-label={isPathExpanded ? "Collapse full log path" : "Expand full log path"}
              aria-expanded={isPathExpanded}
            >
              path
            </button>
            <span className={`trace-path-text mono ${isPathExpanded ? "expanded" : ""}`} title={trace.path}>
              {isPathExpanded ? trace.path : pathTail(trace.path)}
            </span>
          </div>
          <span className="trace-agent-icon-wrap">
            {traceIcon ? (
              <img className="trace-agent-icon" src={traceIcon} alt={`${trace.agent} icon`} loading="lazy" />
            ) : (
              <span className="trace-agent-fallback mono" role="img" aria-label="unknown agent">
                ?
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
