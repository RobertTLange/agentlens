import type { SessionActivityStatus, TraceSummary } from "@agentlens/contracts";
import { iconForAgent, pathTail } from "./view-model.js";

const ACTIVITY_BIN_COUNT = 12;
const ACTIVITY_WINDOW_MINUTES = 60;
const ACTIVITY_SPARKLINE_WIDTH = 56;
const ACTIVITY_SPARKLINE_HEIGHT = 18;
const ACTIVITY_SPARKLINE_PADDING = 1.5;

interface SessionTraceRowProps {
  trace: TraceSummary;
  activityStatus: SessionActivityStatus;
  isActive: boolean;
  isPathExpanded: boolean;
  isEntering: boolean;
  pulseSeq: number;
  onSelect: (traceId: string) => void;
  onTogglePath: (traceId: string) => void;
  rowRef: (node: HTMLDivElement | null) => void;
  fmtTime: (ms: number | null) => string;
}

interface ActivitySparklineModel {
  bins: number[];
  isFlat: boolean;
  windowMinutes: number;
  binMinutes: number;
  linePoints: string;
  areaPath: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sanitizePositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function sanitizeActivityBins(rawBins: number[] | undefined): number[] {
  const numericBins = Array.isArray(rawBins)
    ? rawBins
        .filter((value) => typeof value === "number" && Number.isFinite(value))
        .map((value) => clamp01(value))
    : [];
  if (numericBins.length === ACTIVITY_BIN_COUNT) return numericBins;
  if (numericBins.length > ACTIVITY_BIN_COUNT) return numericBins.slice(-ACTIVITY_BIN_COUNT);
  if (numericBins.length === 0) return Array.from({ length: ACTIVITY_BIN_COUNT }, () => 0);
  return [...Array.from({ length: ACTIVITY_BIN_COUNT - numericBins.length }, () => 0), ...numericBins];
}

function formatBinMinutes(minutes: number): string {
  if (Number.isInteger(minutes)) return String(minutes);
  return minutes.toFixed(1).replace(/\.0$/, "");
}

function buildActivitySparkline(trace: TraceSummary): ActivitySparklineModel {
  const bins = sanitizeActivityBins(trace.activityBins);
  const windowMinutes = sanitizePositiveNumber(trace.activityWindowMinutes, ACTIVITY_WINDOW_MINUTES);
  const defaultBinMinutes = windowMinutes / ACTIVITY_BIN_COUNT;
  const binMinutes = sanitizePositiveNumber(trace.activityBinMinutes, defaultBinMinutes);
  const isFlat = bins.every((value) => value <= 0);

  const baselineY = ACTIVITY_SPARKLINE_HEIGHT - ACTIVITY_SPARKLINE_PADDING;
  const chartHeight = ACTIVITY_SPARKLINE_HEIGHT - ACTIVITY_SPARKLINE_PADDING * 2;
  const xStep = ACTIVITY_BIN_COUNT > 1 ? ACTIVITY_SPARKLINE_WIDTH / (ACTIVITY_BIN_COUNT - 1) : ACTIVITY_SPARKLINE_WIDTH;
  const points = bins.map((value, index) => {
    const x = index * xStep;
    const y = baselineY - value * chartHeight;
    return { x, y };
  });

  const linePoints = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  const areaPath = [
    `M ${points[0]?.x.toFixed(2) ?? "0.00"},${baselineY.toFixed(2)}`,
    ...points.map((point) => `L ${point.x.toFixed(2)},${point.y.toFixed(2)}`),
    `L ${(points[points.length - 1]?.x ?? ACTIVITY_SPARKLINE_WIDTH).toFixed(2)},${baselineY.toFixed(2)}`,
    "Z",
  ].join(" ");

  return {
    bins,
    isFlat,
    windowMinutes,
    binMinutes,
    linePoints,
    areaPath,
  };
}

function describeActivity(sparkline: ActivitySparklineModel): string {
  if (sparkline.isFlat) {
    return `Activity trend: no recent timestamped events in the last ${Math.round(sparkline.windowMinutes)} minutes.`;
  }
  const peak = Math.round(Math.max(...sparkline.bins) * 100);
  const latest = Math.round((sparkline.bins[sparkline.bins.length - 1] ?? 0) * 100);
  return `Activity trend: peak ${peak}% and latest ${latest}% over the last ${Math.round(sparkline.windowMinutes)} minutes in ${formatBinMinutes(sparkline.binMinutes)}-minute bins.`;
}

export function SessionTraceRow(props: SessionTraceRowProps): JSX.Element {
  const { trace, activityStatus, isActive, isPathExpanded, isEntering, pulseSeq, onSelect, onTogglePath, rowRef, fmtTime } =
    props;
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
  const activitySparkline = buildActivitySparkline(trace);

  return (
    <div
      className={`trace-row ${statusClass} ${isActive ? "active" : ""} ${isEntering ? "trace-row-enter" : ""}`}
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
          <span className="trace-time-graph-wrap">
            <svg
              className={`trace-activity-sparkline ${statusClass} ${activitySparkline.isFlat ? "is-flat" : ""}`}
              viewBox={`0 0 ${ACTIVITY_SPARKLINE_WIDTH} ${ACTIVITY_SPARKLINE_HEIGHT}`}
              role="img"
              aria-label={describeActivity(activitySparkline)}
              data-flat={activitySparkline.isFlat ? "true" : "false"}
              data-point-count={activitySparkline.bins.length}
            >
              <line
                className="trace-activity-baseline"
                x1={0}
                y1={ACTIVITY_SPARKLINE_HEIGHT - ACTIVITY_SPARKLINE_PADDING}
                x2={ACTIVITY_SPARKLINE_WIDTH}
                y2={ACTIVITY_SPARKLINE_HEIGHT - ACTIVITY_SPARKLINE_PADDING}
              />
              <path className="trace-activity-area" d={activitySparkline.areaPath} />
              <polyline className="trace-activity-line" points={activitySparkline.linePoints} />
            </svg>
          </span>
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
