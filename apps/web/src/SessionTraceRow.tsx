import type { TraceSummary } from "@agentlens/contracts";
import { iconForAgent, pathTail } from "./view-model.js";

interface SessionTraceRowProps {
  trace: TraceSummary;
  isActive: boolean;
  isPathExpanded: boolean;
  pulseSeq: number;
  onSelect: (traceId: string) => void;
  onTogglePath: (traceId: string) => void;
  rowRef: (node: HTMLDivElement | null) => void;
  fmtTime: (ms: number | null) => string;
}

export function SessionTraceRow(props: SessionTraceRowProps): JSX.Element {
  const { trace, isActive, isPathExpanded, pulseSeq, onSelect, onTogglePath, rowRef, fmtTime } = props;
  const traceIcon = iconForAgent(trace.agent);

  return (
    <div
      className={`trace-row ${isActive ? "active" : ""}`}
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
        <div className="trace-main">
          <strong>{trace.agent}</strong>
          <span className="mono">{trace.sessionId || trace.id}</span>
        </div>
        <div className="trace-meta mono">
          <span>{fmtTime(trace.lastEventTs ?? trace.mtimeMs)}</span>
          <span>{`events ${trace.eventCount}`}</span>
          <span>{`errors ${trace.errorCount}`}</span>
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
