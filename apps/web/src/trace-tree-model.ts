import type { NormalizedEvent } from "@agentlens/contracts";
import { groupInspectorEvents } from "./inspector-view-model.js";

export interface TraceTreeNode {
  event: NormalizedEvent;
  children: TraceTreeNode[];
  loopNumber?: number;
}

export function buildAgentLoopTree(events: NormalizedEvent[]): TraceTreeNode[] {
  const roots = buildTraceTree(events);
  const groupLoops = (nodes: TraceTreeNode[]): TraceTreeNode[] => {
    const children: TraceTreeNode[] = [];
    let pending: TraceTreeNode[] = [];
    let active: TraceTreeNode | undefined;
    let number = 0;
    for (const node of nodes) {
      if (node.event.modelUsage) {
        const loop = { ...node, children: [...node.children], loopNumber: ++number };
        if (node.event.modelUsage.agent === "codex") {
          loop.children.unshift(...pending);
          pending = [];
          active = undefined;
        } else {
          children.push(...pending);
          pending = [];
          active = loop;
        }
        children.push(loop);
      } else if (active) {
        active.children.push(node);
      } else {
        pending.push(node);
      }
    }
    return [...children, ...pending];
  };
  const grouped: TraceTreeNode[] = [];
  let orphaned: TraceTreeNode[] = [];
  for (const root of roots) {
    if (root.event.eventKind !== "user") {
      orphaned.push(root);
      continue;
    }
    grouped.push(...groupLoops(orphaned));
    orphaned = [];
    root.children = groupLoops(root.children);
    grouped.push(root);
  }
  return [...grouped, ...groupLoops(orphaned)];
}

export interface TraceTreeMeasurement {
  durationSeconds: number | null;
  durationEstimated?: boolean;
  tokens: number | null;
}

export function traceTreeMeasurements(roots: TraceTreeNode[]): Map<string, TraceTreeMeasurement> {
  const totals = new Map<string, { start: number | null; end: number | null; samples: number; tokens: number | null }>();
  const ordered: TraceTreeNode[] = [];
  const pending = [...roots];
  while (pending.length) {
    const node = pending.pop()!;
    ordered.push(node);
    pending.push(...node.children);
  }
  const result = new Map<string, TraceTreeMeasurement>();
  for (const node of ordered.reverse()) {
    const timestamp = node.event.timestampMs;
    let start = timestamp !== null && Number.isFinite(timestamp) ? timestamp : null;
    let end = start;
    let samples = start === null ? 0 : 1;
    let tokens = node.event.consumedTokens !== undefined && Number.isFinite(node.event.consumedTokens) && node.event.consumedTokens >= 0 ? node.event.consumedTokens : null;
    for (const child of node.children) {
      const childTotal = totals.get(child.event.eventId)!;
      if (childTotal.start !== null) start = start === null ? childTotal.start : Math.min(start, childTotal.start);
      if (childTotal.end !== null) end = end === null ? childTotal.end : Math.max(end, childTotal.end);
      samples += childTotal.samples;
      if (childTotal.tokens !== null) tokens = (tokens ?? 0) + childTotal.tokens;
    }
    totals.set(node.event.eventId, { start, end, samples, tokens });
    result.set(node.event.eventId, { durationSeconds: samples > 1 && start !== null && end !== null ? (end - start) / 1000 : null, tokens });
  }
  for (const { call, result: output } of groupInspectorEvents(ordered.map(node => node.event))) {
    if (!call || !output || call.timestampMs === null || output.timestampMs === null) continue;
    const seconds = (output.timestampMs - call.timestampMs) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    for (const event of [call, output]) {
      const measurement = result.get(event.eventId);
      if (measurement) measurement.durationSeconds = seconds;
    }
  }
  const nextByTrace = new Map<string, NormalizedEvent>();
  for (const { event } of [...ordered].sort((a, b) => b.event.index - a.event.index)) {
    const next = nextByTrace.get(event.traceId);
    nextByTrace.set(event.traceId, event);
    const measurement = result.get(event.eventId)!;
    if (measurement.durationSeconds !== null || event.timestampMs === null || next?.timestampMs == null) continue;
    const seconds = (next.timestampMs - event.timestampMs) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    measurement.durationSeconds = seconds;
    measurement.durationEstimated = true;
  }
  return result;
}

export function buildTraceTree(events: NormalizedEvent[]): TraceTreeNode[] {
  const ordered = [...events].sort((a, b) => a.index - b.index);
  const nodes = new Map(ordered.map((event) => [event.eventId, { event, children: [] } as TraceTreeNode]));
  const resultParents = new Map<string, string>();
  for (const { call, result } of groupInspectorEvents(ordered)) {
    if (call && result) resultParents.set(result.eventId, call.eventId);
  }
  const toolParents = new Map<string, TraceTreeNode | null>();
  for (const event of ordered) {
    const id = event.toolCallId || event.toolUseId;
    if (event.eventKind !== "tool_use" || !id) continue;
    const key = JSON.stringify([event.traceId, id]);
    toolParents.set(key, toolParents.has(key) ? null : nodes.get(event.eventId)!);
  }
  const roots: TraceTreeNode[] = [];
  let turn: TraceTreeNode | undefined;
  for (const event of ordered) {
    const node = nodes.get(event.eventId)!;
    const parentId = event.parentEventId || resultParents.get(event.eventId);
    const hasRecordedParent = !!event.parentEventId || !!event.parentToolUseId;
    const parent = parentId ? nodes.get(parentId) : event.parentToolUseId
      ? toolParents.get(JSON.stringify([event.traceId, event.parentToolUseId])) : undefined;
    // Only earlier parents form safe branches; missing or cyclic links stay at the root.
    if (parent && parent.event.traceId === event.traceId && parent.event.index < event.index) {
      parent.children.push(node);
    } else if (!hasRecordedParent && event.eventKind !== "user" && turn?.event.traceId === event.traceId) {
      turn.children.push(node);
    } else {
      roots.push(node);
    }
    if (event.eventKind === "user") turn = node;
  }
  return roots;
}

export interface TraceGroupUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
}

export function traceGroupUsage(root: TraceTreeNode): TraceGroupUsage {
  const totals: TraceGroupUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    pending.push(...node.children);
    const usage = node.event.modelUsage;
    if (!usage) continue;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.cachedInputTokens += usage.cachedInputTokens;
    totals.costUsd = totals.costUsd == null || usage.costUsd == null ? null : totals.costUsd + usage.costUsd;
  }
  return totals;
}
