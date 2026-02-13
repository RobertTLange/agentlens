import type { SessionActivityStatus, TraceSummary } from "@agentlens/contracts";
import { iconForAgent, pathTail } from "./view-model.js";

const ACTIVITY_BIN_COUNT = 12;
const ACTIVITY_SPARKLINE_WIDTH = 56;
const ACTIVITY_SPARKLINE_HEIGHT = 18;
const ACTIVITY_SPARKLINE_PADDING = 1.5;
const COMPOSITION_PIE_SIZE = 18;
const COMPOSITION_PIE_CENTER = COMPOSITION_PIE_SIZE / 2;
const COMPOSITION_PIE_RADIUS = COMPOSITION_PIE_CENTER - 0.6;

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
  mode: "time" | "event_index";
  windowMinutes: number | undefined;
  binMinutes: number | undefined;
  linePoints: string;
  areaPath: string;
}

interface ActivityHoverSection {
  key: string;
  x: number;
  width: number;
  tooltip: string;
}

type CompositionSliceKey = "assistant" | "user" | "tool_use" | "tool_result";

interface CompositionSlice {
  key: CompositionSliceKey;
  path: string;
}

interface CompositionPieModel {
  assistantCount: number;
  userCount: number;
  toolUseCount: number;
  toolResultCount: number;
  total: number;
  isEmpty: boolean;
  slices: CompositionSlice[];
}

async function copyPathText(path: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(path);
    return;
  }

  const hiddenField = document.createElement("textarea");
  hiddenField.value = path;
  hiddenField.setAttribute("readonly", "true");
  hiddenField.style.position = "fixed";
  hiddenField.style.opacity = "0";
  hiddenField.style.pointerEvents = "none";
  document.body.append(hiddenField);
  hiddenField.select();
  if (typeof document.execCommand === "function") {
    document.execCommand("copy");
  }
  hiddenField.remove();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sanitizeCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function sanitizeActivityBins(rawBins: number[] | undefined): number[] {
  const numericBins = Array.isArray(rawBins)
    ? rawBins
        .filter((value) => typeof value === "number" && Number.isFinite(value))
        .map((value) => clamp01(value))
    : [];
  if (numericBins.length > ACTIVITY_BIN_COUNT) return numericBins.slice(-ACTIVITY_BIN_COUNT);
  if (numericBins.length === 0) return Array.from({ length: ACTIVITY_BIN_COUNT }, () => 0);
  return numericBins;
}

function formatBinMinutes(minutes: number): string {
  if (Number.isInteger(minutes)) return String(minutes);
  return minutes.toFixed(1).replace(/\.0$/, "");
}

function buildActivitySparkline(trace: TraceSummary): ActivitySparklineModel {
  const bins = sanitizeActivityBins(trace.activityBins);
  const mode = trace.activityBinsMode === "event_index" ? "event_index" : "time";
  const windowMinutes =
    typeof trace.activityWindowMinutes === "number" && Number.isFinite(trace.activityWindowMinutes) && trace.activityWindowMinutes > 0
      ? trace.activityWindowMinutes
      : undefined;
  const binMinutes =
    typeof trace.activityBinMinutes === "number" && Number.isFinite(trace.activityBinMinutes) && trace.activityBinMinutes > 0
      ? trace.activityBinMinutes
      : windowMinutes && bins.length > 0
        ? windowMinutes / bins.length
        : undefined;
  const isFlat = bins.every((value) => value <= 0);

  const baselineY = ACTIVITY_SPARKLINE_HEIGHT - ACTIVITY_SPARKLINE_PADDING;
  const chartHeight = ACTIVITY_SPARKLINE_HEIGHT - ACTIVITY_SPARKLINE_PADDING * 2;
  const xStep = bins.length > 1 ? ACTIVITY_SPARKLINE_WIDTH / (bins.length - 1) : ACTIVITY_SPARKLINE_WIDTH;
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
    mode,
    windowMinutes,
    binMinutes,
    linePoints,
    areaPath,
  };
}

function describeActivity(sparkline: ActivitySparklineModel): string {
  const peak = Math.round(Math.max(...sparkline.bins) * 100);
  const latest = Math.round((sparkline.bins[sparkline.bins.length - 1] ?? 0) * 100);

  if (sparkline.mode === "event_index") {
    if (sparkline.isFlat) {
      return "Activity trend: timestamp data unavailable; event-order density is flat.";
    }
    return `Activity trend: event-order density fallback, peak ${peak}% and latest ${latest}%.`;
  }

  if (sparkline.isFlat) {
    return "Activity trend: no timestamped activity across this session lifetime.";
  }
  if (sparkline.windowMinutes && sparkline.binMinutes) {
    return `Activity trend: peak ${peak}% and latest ${latest}% over this session lifetime (${Math.round(sparkline.windowMinutes)} minutes) in ${formatBinMinutes(sparkline.binMinutes)}-minute bins.`;
  }
  return `Activity trend: peak ${peak}% and latest ${latest}% over this session lifetime.`;
}

function describeActivitySectionTooltip(
  trace: TraceSummary,
  sparkline: ActivitySparklineModel,
  sectionIndex: number,
  fmtTime: (ms: number | null) => string,
): string {
  const level = Math.round((sparkline.bins[sectionIndex] ?? 0) * 100);
  const sectionCount = Math.max(1, sparkline.bins.length);
  const firstTs = trace.firstEventTs ?? null;
  const lastTs = trace.lastEventTs ?? null;

  if (
    sparkline.mode === "time" &&
    typeof firstTs === "number" &&
    Number.isFinite(firstTs) &&
    typeof lastTs === "number" &&
    Number.isFinite(lastTs) &&
    lastTs > firstTs
  ) {
    const spanMs = lastTs - firstTs;
    const sectionStartMs = Math.round(firstTs + (sectionIndex / sectionCount) * spanMs);
    const sectionEndMs =
      sectionIndex >= sectionCount - 1
        ? lastTs
        : Math.round(firstTs + ((sectionIndex + 1) / sectionCount) * spanMs);
    return `Activity ${level}%\n${fmtTime(sectionStartMs)} to ${fmtTime(sectionEndMs)}`;
  }

  if (
    typeof firstTs === "number" &&
    Number.isFinite(firstTs) &&
    typeof lastTs === "number" &&
    Number.isFinite(lastTs) &&
    lastTs === firstTs
  ) {
    return `Activity ${level}%\n${fmtTime(firstTs)}`;
  }

  return `Activity ${level}%\nTimestamp unavailable for this section`;
}

function buildActivityHoverSections(
  trace: TraceSummary,
  sparkline: ActivitySparklineModel,
  fmtTime: (ms: number | null) => string,
): ActivityHoverSection[] {
  if (sparkline.bins.length <= 0) return [];
  const sectionWidth = ACTIVITY_SPARKLINE_WIDTH / sparkline.bins.length;
  return sparkline.bins.map((_, index) => ({
    key: `section-${index}`,
    x: index * sectionWidth,
    width: sectionWidth,
    tooltip: describeActivitySectionTooltip(trace, sparkline, index, fmtTime),
  }));
}

function formatRatioPercent(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 100);
}

function polarPoint(angleRad: number): { x: number; y: number } {
  return {
    x: COMPOSITION_PIE_CENTER + COMPOSITION_PIE_RADIUS * Math.cos(angleRad),
    y: COMPOSITION_PIE_CENTER + COMPOSITION_PIE_RADIUS * Math.sin(angleRad),
  };
}

function fullCircleSlicePath(): string {
  const topY = COMPOSITION_PIE_CENTER - COMPOSITION_PIE_RADIUS;
  const bottomY = COMPOSITION_PIE_CENTER + COMPOSITION_PIE_RADIUS;
  return [
    `M ${COMPOSITION_PIE_CENTER.toFixed(2)} ${COMPOSITION_PIE_CENTER.toFixed(2)}`,
    `L ${COMPOSITION_PIE_CENTER.toFixed(2)} ${topY.toFixed(2)}`,
    `A ${COMPOSITION_PIE_RADIUS.toFixed(2)} ${COMPOSITION_PIE_RADIUS.toFixed(2)} 0 1 1 ${COMPOSITION_PIE_CENTER.toFixed(2)} ${bottomY.toFixed(2)}`,
    `A ${COMPOSITION_PIE_RADIUS.toFixed(2)} ${COMPOSITION_PIE_RADIUS.toFixed(2)} 0 1 1 ${COMPOSITION_PIE_CENTER.toFixed(2)} ${topY.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function pieSlicePath(startAngle: number, endAngle: number): string {
  const delta = Math.max(0, endAngle - startAngle);
  if (delta >= Math.PI * 2 - 1e-6) {
    return fullCircleSlicePath();
  }

  const start = polarPoint(startAngle);
  const end = polarPoint(endAngle);
  const largeArcFlag = delta > Math.PI ? 1 : 0;
  return [
    `M ${COMPOSITION_PIE_CENTER.toFixed(2)} ${COMPOSITION_PIE_CENTER.toFixed(2)}`,
    `L ${start.x.toFixed(2)} ${start.y.toFixed(2)}`,
    `A ${COMPOSITION_PIE_RADIUS.toFixed(2)} ${COMPOSITION_PIE_RADIUS.toFixed(2)} 0 ${largeArcFlag} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function buildCompositionPie(trace: TraceSummary): CompositionPieModel {
  const counts = trace.eventKindCounts;
  const assistantCount = sanitizeCount(counts.assistant);
  const userCount = sanitizeCount(counts.user);
  const toolUseCount = sanitizeCount(counts.tool_use);
  const toolResultCount = sanitizeCount(counts.tool_result);
  const total = assistantCount + userCount + toolUseCount + toolResultCount;

  if (total <= 0) {
    return {
      assistantCount,
      userCount,
      toolUseCount,
      toolResultCount,
      total: 0,
      isEmpty: true,
      slices: [],
    };
  }

  const ordered: Array<{ key: CompositionSliceKey; count: number }> = [
    { key: "assistant", count: assistantCount },
    { key: "user", count: userCount },
    { key: "tool_use", count: toolUseCount },
    { key: "tool_result", count: toolResultCount },
  ];

  let cursor = -Math.PI / 2;
  const slices: CompositionSlice[] = [];
  for (const item of ordered) {
    if (item.count <= 0) continue;
    const ratio = item.count / total;
    const nextCursor = cursor + ratio * Math.PI * 2;
    slices.push({
      key: item.key,
      path: pieSlicePath(cursor, nextCursor),
    });
    cursor = nextCursor;
  }

  return {
    assistantCount,
    userCount,
    toolUseCount,
    toolResultCount,
    total,
    isEmpty: false,
    slices,
  };
}

function describeComposition(pie: CompositionPieModel): string {
  if (pie.isEmpty) {
    return "Event mix: no user, assistant, tool use, or tool result events yet.";
  }
  const assistantPercent = formatRatioPercent(pie.assistantCount, pie.total);
  const userPercent = formatRatioPercent(pie.userCount, pie.total);
  const toolUsePercent = formatRatioPercent(pie.toolUseCount, pie.total);
  const toolResultPercent = formatRatioPercent(pie.toolResultCount, pie.total);
  return `Event mix: assistant ${assistantPercent}%, user ${userPercent}%, tool use ${toolUsePercent}%, tool result ${toolResultPercent}%.`;
}

function describeCompositionTooltip(pie: CompositionPieModel): string {
  if (pie.isEmpty) {
    return "No user, assistant, tool use, or tool result events yet.";
  }
  const assistantPercent = formatRatioPercent(pie.assistantCount, pie.total);
  const userPercent = formatRatioPercent(pie.userCount, pie.total);
  const toolUsePercent = formatRatioPercent(pie.toolUseCount, pie.total);
  const toolResultPercent = formatRatioPercent(pie.toolResultCount, pie.total);
  return [
    `Assistant: ${pie.assistantCount} (${assistantPercent}%)`,
    `User: ${pie.userCount} (${userPercent}%)`,
    `Tool use: ${pie.toolUseCount} (${toolUsePercent}%)`,
    `Tool result: ${pie.toolResultCount} (${toolResultPercent}%)`,
    `Total: ${pie.total}`,
  ].join("\n");
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
  const activityHoverSections = buildActivityHoverSections(trace, activitySparkline, fmtTime);
  const compositionPie = buildCompositionPie(trace);
  const compositionTooltip = describeCompositionTooltip(compositionPie);

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
          <span className="trace-time-label">updated</span>
          <span className="trace-time-value">{fmtTime(updatedMs)}</span>
          <span className="trace-time-label">start</span>
          <span className="trace-time-value">{fmtTime(startMs)}</span>
          <span className="trace-time-graph-wrap">
            <span className="trace-composition-wrap">
              <svg
                className="trace-composition-pie"
                viewBox={`0 0 ${COMPOSITION_PIE_SIZE} ${COMPOSITION_PIE_SIZE}`}
                role="img"
                aria-label={describeComposition(compositionPie)}
                data-total={compositionPie.total}
                data-assistant-count={compositionPie.assistantCount}
                data-user-count={compositionPie.userCount}
                data-tool-use-count={compositionPie.toolUseCount}
                data-tool-result-count={compositionPie.toolResultCount}
              >
                {compositionPie.isEmpty ? (
                  <circle
                    className="trace-composition-empty"
                    cx={COMPOSITION_PIE_CENTER}
                    cy={COMPOSITION_PIE_CENTER}
                    r={COMPOSITION_PIE_RADIUS}
                  />
                ) : (
                  compositionPie.slices.map((slice) => (
                    <path key={slice.key} className={`trace-composition-slice ${slice.key}`} d={slice.path} />
                  ))
                )}
                <circle
                  className="trace-composition-outline"
                  cx={COMPOSITION_PIE_CENTER}
                  cy={COMPOSITION_PIE_CENTER}
                  r={COMPOSITION_PIE_RADIUS}
                />
              </svg>
              <span className="trace-composition-tooltip mono" aria-hidden="true">
                {compositionTooltip}
              </span>
            </span>
            <svg
              className={`trace-activity-sparkline ${statusClass} ${activitySparkline.isFlat ? "is-flat" : ""}`}
              viewBox={`0 0 ${ACTIVITY_SPARKLINE_WIDTH} ${ACTIVITY_SPARKLINE_HEIGHT}`}
              role="img"
              aria-label={describeActivity(activitySparkline)}
              data-flat={activitySparkline.isFlat ? "true" : "false"}
              data-point-count={activitySparkline.bins.length}
              data-mode={activitySparkline.mode}
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
              {activityHoverSections.map((section) => (
                <rect
                  key={section.key}
                  className="trace-activity-hover-zone"
                  x={section.x}
                  y={0}
                  width={section.width}
                  height={ACTIVITY_SPARKLINE_HEIGHT}
                >
                  <title>{section.tooltip}</title>
                </rect>
              ))}
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
            {isPathExpanded && (
              <button
                type="button"
                className="trace-path-copy"
                onClick={(event) => {
                  event.stopPropagation();
                  void copyPathText(trace.path).catch(() => {});
                }}
                aria-label="Copy full log path"
                title="Copy full log path"
              >
                <svg viewBox="0 0 14 14" aria-hidden="true">
                  <rect x="4" y="1.5" width="8.5" height="9.5" rx="1.4" fill="none" stroke="currentColor" />
                  <rect x="1.5" y="4" width="8.5" height="8.5" rx="1.4" fill="none" stroke="currentColor" />
                </svg>
              </button>
            )}
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
