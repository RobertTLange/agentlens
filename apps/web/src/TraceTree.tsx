import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { EventKind, NormalizedEvent } from "@agentlens/contracts";
import { buildAgentLoopTree, traceTreeMeasurements, type TraceTreeNode } from "./trace-tree-model.js";
import type { TimelineSortDirection } from "./view-model.js";

interface TraceTreeProps {
  headerActions?: ReactNode;
  events: NormalizedEvent[];
  measurementEvents: NormalizedEvent[];
  selectedEventId: string;
  onSelectEvent: (eventId: string) => void;
}

const EVENT_ICONS: Record<EventKind | "model", string> = {
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21v-2a8 8 0 0 1 16 0v2",
  assistant: "M5 4h14v12H9l-4 4V4m4 5h6m-6 3h4",
  reasoning: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0l-1 2H9l-1-2",
  tool_use: "m9 6-6 6 6 6m6-12 6 6-6 6m-2-15-2 18",
  tool_result: "M9 4H5v16h14V4h-4M9 3h6v4H9V3m-1 11 3 3 5-6",
  system: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4m0 5v5m0 3v1",
  compaction: "M4 4h16v4H4V4m2 8h12m-10 4h8m-6 4h4",
  meta: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m0 7v7m0-10v.5",
  model: "M7 7h10v10H7V7m3-4v4m4-4v4m-4 10v4m4-4v4M3 10h4m-4 4h4m10-4h4m-4 4h4m-11-4h4v4h-4v-4",
};

const ROW_STEP = 160;

export function TraceTree({ headerActions, events, measurementEvents, selectedEventId, onSelectEvent }: TraceTreeProps): JSX.Element {
  const [query, setQuery] = useState("");
  const roots = useMemo(() => {
    const tree = buildAgentLoopTree(events);
    const term = query.trim().toLowerCase();
    if (!term) return tree;
    const filter = (nodes: TraceTreeNode[]): TraceTreeNode[] => nodes.flatMap(node => {
      const event = node.event;
      const text = [event.preview, event.searchText, event.eventKind, event.toolName, event.toolType, event.toolArgsText, event.toolResultText, event.modelUsage?.model, event.modelUsage ? `model call loop ${node.loopNumber ?? ""}` : "", `#${event.index}`].join(" ").toLowerCase();
      const children = filter(node.children);
      return text.includes(term) || children.length ? [{ ...node, children }] : [];
    });
    return filter(tree);
  }, [events, query]);
  const measurements = useMemo(() => traceTreeMeasurements(buildAgentLoopTree(measurementEvents)), [measurementEvents]);
  const preferredGroup = useMemo(() => {
    for (const root of roots) {
      const pending = [root];
      while (pending.length) {
        const node = pending.pop()!;
        if (node.event.eventId === selectedEventId && root.children.length) return root.event.eventId;
        pending.push(...node.children);
      }
    }
    return [...roots].reverse().find(root => root.children.length)?.event.eventId ?? null;
  }, [roots, selectedEventId]);
  const [openGroupId, setOpenGroupId] = useState<string | null | undefined>(undefined);
  const openGroup = openGroupId === undefined ? preferredGroup : openGroupId;
  const isCollapsed = (node: TraceTreeNode): boolean => collapsed.has(node.event.eventId) || (roots.includes(node) && node.children.length > 0 && node.event.eventId !== openGroup);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const branchIds = useMemo(() => {
    const ids: string[] = [];
    const pending = roots.filter(root => root.event.eventId === (openGroup || preferredGroup));
    while (pending.length) {
      const node = pending.pop()!;
      if (node.children.length) ids.push(node.event.eventId);
      pending.push(...node.children);
    }
    return ids;
  }, [roots, openGroup, preferredGroup]);
  const expandAll = !openGroup || branchIds.some(id => collapsed.has(id));
  const branchAction = expandAll ? "Expand group" : "Collapse group";
  const [limit, setLimit] = useState(ROW_STEP);
  const [sortDirection, setSortDirection] = useState<TimelineSortDirection>("latest-first");
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => {
    const result: { node: TraceTreeNode; depth: number }[] = [];
    const pending = roots.map((node) => ({ node, depth: 0 }));
    if (sortDirection === "first-latest") pending.reverse();
    while (pending.length && result.length <= limit) {
      const row = pending.pop()!;
      result.push(row);
      if (!isCollapsed(row.node)) {
        for (let i = 0; i < row.node.children.length; i++) {
          const index = sortDirection === "latest-first" ? i : row.node.children.length - 1 - i;
          pending.push({ node: row.node.children[index]!, depth: row.depth + 1 });
        }
      }
    }
    return result;
  }, [roots, collapsed, limit, sortDirection, openGroup]);
  return (
    <section className="panel trace-tree-panel" aria-label="Session trace tree">
      <div className="panel-head trace-tree-head">
        <div className="trace-tree-head-top">
          <h2>Trace tree</h2>
          <div className="trace-tree-head-actions">
            {headerActions}
            <button type="button" className="sort-toggle sort-icon" title={branchAction} aria-label={branchAction} disabled={!branchIds.length} onClick={() => {
              setOpenGroupId(expandAll ? openGroup || preferredGroup : null);
              setCollapsed(expandAll ? new Set() : new Set(branchIds));
              setLimit(expandAll ? Math.max(ROW_STEP, events.length) : ROW_STEP);
              if (!expandAll && scrollRef.current) scrollRef.current.scrollTop = 0;
            }}><svg viewBox="0 0 14 14" aria-hidden="true">{expandAll ? <path strokeWidth="1.25" d="M5.5 5.5 1 1m0 3V1h3m4.5 4.5L13 1m-3 0h3v3M5.5 8.5 1 13m0-3v3h3m4.5-4.5L13 13m-3 0h3v-3" /> : <path fill="currentColor" stroke="none" fillRule="evenodd" clipRule="evenodd" d="M13.4419 0.558058c0.2441 0.244078 0.2441 0.639802 0 0.883882L10.0089 4.875H12.5c0.3452 0 0.625 0.27982 0.625 0.625s-0.2798 0.625 -0.625 0.625h-4c-0.08474 0 -0.16555 -0.01687 -0.23924 -0.04742 -0.07372 -0.0305 -0.14278 -0.07572 -0.2027 -0.13564C7.93602 5.8199 7.875 5.65995 7.875 5.5v-4c0 -0.34518 0.27982 -0.625 0.625 -0.625s0.625 0.27982 0.625 0.625v2.49112L12.5581 0.558058c0.244 -0.244077 0.6398 -0.244077 0.8838 0ZM6.07758 8.26076c-0.03026 -0.07313 -0.075 -0.14168 -0.13421 -0.20127l-0.00143 -0.00143 -0.00143 -0.00143C5.82752 7.94437 5.67186 7.875 5.5 7.875h-4c-0.34518 0 -0.625 0.27982 -0.625 0.625s0.27982 0.625 0.625 0.625h2.49112L0.558058 12.5581c-0.244077 0.244 -0.244077 0.6398 0 0.8838 0.244078 0.2441 0.639802 0.2441 0.883882 0l3.43306 -3.433V12.5c0 0.3452 0.27982 0.625 0.625 0.625s0.625 -0.2798 0.625 -0.625v-4c0 -0.08474 -0.01687 -0.16555 -0.04742 -0.23924Zm3.93132 0.86424H12.5c0.3452 0 0.625 -0.27982 0.625 -0.625s-0.2798 -0.625 -0.625 -0.625h-4c-0.34518 0 -0.625 0.27982 -0.625 0.625v4c0 0.3452 0.27982 0.625 0.625 0.625s0.625 -0.2798 0.625 -0.625v-2.4911l3.4331 3.433c0.244 0.2441 0.6398 0.2441 0.8838 0 0.2441 -0.244 0.2441 -0.6398 0 -0.8838l-3.433 -3.4331ZM0.558058 0.558058c0.244078 -0.244077 0.639802 -0.244077 0.883882 0L4.875 3.99112V1.5c0 -0.34518 0.27982 -0.625 0.625 -0.625s0.625 0.27982 0.625 0.625v4c0 0.08474 -0.01687 0.16555 -0.04742 0.23924 -0.0305 0.07372 -0.07572 0.14278 -0.13564 0.2027 -0.12204 0.12204 -0.28199 0.18306 -0.44194 0.18306h-4c-0.34518 0 -0.625 -0.27982 -0.625 -0.625s0.27982 -0.625 0.625 -0.625h2.49112L0.558058 1.44194c-0.244077 -0.24408 -0.244077 -0.639804 0 -0.883882Z" />}</svg></button>
            <button type="button" className="sort-toggle sort-icon" title={`Order: ${sortDirection === "latest-first" ? "latest to first" : "first to latest"}. Click to reverse.`} aria-label={`Trace tree order: ${sortDirection === "latest-first" ? "latest to first" : "first to latest"}`} onClick={() => {
              setSortDirection(previous => previous === "latest-first" ? "first-latest" : "latest-first");
              setLimit(ROW_STEP);
              if (scrollRef.current) scrollRef.current.scrollTop = 0;
            }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={sortDirection === "latest-first" ? "M7 4v16m-4-4 4 4 4-4M14 5h7M14 10h5M14 15h3" : "M7 20V4m-4 4 4-4 4 4M14 5h3M14 10h5M14 15h7"} /></svg></button>
          </div>
        </div>
        <input type="search" className="search trace-tree-search" aria-label="Search trace tree" placeholder="Search traces, tools, or models" value={query} onChange={event => {
          setQuery(event.target.value);
          setCollapsed(new Set());
          setOpenGroupId(undefined);
          setLimit(ROW_STEP);
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
        }} />
        <p title="Recorded usage per model call. Event grouping follows usage checkpoints and is inferred. Loaded events only.">Recorded model usage · inferred grouping · loaded events</p>
      </div>
      <div className="trace-tree-scroll" ref={scrollRef}>
        <ul className="trace-tree-list">
          {rows.slice(0, limit).map(({ node: { event, children, loopNumber }, depth }) => (
            <li key={event.eventId} className={`trace-tree-row ${depth > 0 ? "nested" : ""} ${event.eventId === selectedEventId ? "active" : ""} ${event.hasError ? "has-error" : ""}`} style={{ paddingLeft: `${Math.min(depth, 8) * 16 + 2}px`, "--tree-indent": `${Math.min(depth, 8) * 16}px` } as CSSProperties}>
              {children.length ? (
                <button type="button" className="trace-tree-toggle" aria-label={`${(depth === 0 && event.eventId !== openGroup) || collapsed.has(event.eventId) ? "Expand" : "Collapse"} branch #${event.index}`} aria-expanded={!(depth === 0 && event.eventId !== openGroup) && !collapsed.has(event.eventId)} onClick={() => {
                  if (depth === 0) setOpenGroupId(event.eventId === openGroup && !collapsed.has(event.eventId) ? null : event.eventId);
                  setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (depth === 0) {
                    next.delete(event.eventId);
                  } else if (next.has(event.eventId)) next.delete(event.eventId); else next.add(event.eventId);
                  return next;
                  });
                }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg></button>
              ) : <span className="trace-tree-leaf" aria-hidden="true">·</span>}
              <button type="button" className="trace-tree-event" aria-label={`Inspect event #${event.index} ${event.eventKind}: ${event.preview}`} aria-current={event.eventId === selectedEventId ? "true" : undefined} onClick={() => onSelectEvent(event.eventId)} title={`#${event.index} · ${event.eventKind} · level ${depth + 1}\n${event.preview}`}>
                <svg className={`trace-tree-type-icon type-${event.modelUsage ? "model" : event.eventKind}`} data-event-type={event.modelUsage ? "model" : event.eventKind} data-event-kind={event.eventKind} viewBox="0 0 24 24" aria-hidden="true"><path d={EVENT_ICONS[event.modelUsage ? "model" : event.eventKind]} /></svg>
                <span className="trace-tree-copy">
                  <span className="trace-tree-preview">{event.modelUsage ? `${loopNumber ? `Loop ${loopNumber} · ` : ""}Model call` : event.eventKind === "tool_use" ? event.toolName || event.toolType || "Tool call" : event.eventKind === "tool_result" ? "Tool output" : event.eventKind === "reasoning" ? "Reasoning" : event.preview && event.preview !== "[]" ? event.preview : event.eventKind}</span>
                  <span className="trace-tree-meta">#{event.index} · {event.modelUsage ? `${event.modelUsage.model === "<unknown>" ? "Model response" : event.modelUsage.model}` : event.eventKind}{event.toolType ? ` · ${event.toolType}` : ""}{event.hasError ? " · Error" : ""}</span>
                  <span className="trace-tree-metrics" title="Elapsed span and recorded tokens for this loaded branch. Missing measurements are shown as —; tokens may cover only part of the branch.">
                    <span title={measurements.get(event.eventId)?.durationEstimated ? "Estimated gap to the next recorded event; includes waiting time." : "Elapsed span of linked events, when available."}>{measurements.get(event.eventId)?.durationEstimated ? "~" : ""}{measurements.get(event.eventId)?.durationSeconds?.toLocaleString(undefined, { maximumFractionDigits: 2 }) ?? "—"} s</span>
                    {measurements.get(event.eventId)?.tokens != null && <span title="Recorded usage; parent totals sum the loaded model calls.">{(event.modelUsage?.totalTokens ?? measurements.get(event.eventId)!.tokens!).toLocaleString()} {event.eventKind === "user" ? "turn tokens" : "tokens"}</span>}
                    {event.modelUsage?.costUsd != null && <span>{event.modelUsage.costUsd.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 4 })}</span>}
                  </span>
                  {event.modelUsage && <span className="trace-tree-usage">
                    <span><span className="trace-tree-usage-label">Input </span><strong>{event.modelUsage.inputTokens.toLocaleString()}</strong></span>
                    <span title="Cached input is included in the input count, not additional tokens."><span className="trace-tree-usage-label">Cached </span><strong>{event.modelUsage.cachedInputTokens.toLocaleString()}</strong></span>
                    <span><span className="trace-tree-usage-label">Output </span><strong>{event.modelUsage.outputTokens.toLocaleString()}</strong></span>
                  </span>}
                </span>
                {children.length > 0 && <span className="trace-tree-count" aria-label={`${children.length} child events`}>{children.length}</span>}
              </button>
            </li>
          ))}
        </ul>
        {rows.length > limit && <button type="button" className="load-more" onClick={() => setLimit((previous) => previous + ROW_STEP)}>Load more tree events</button>}
        {!roots.length && <div className="empty">{query.trim() ? "No matching traces in loaded events." : "Select a session with events to explore its trace tree."}</div>}
      </div>
    </section>
  );
}
