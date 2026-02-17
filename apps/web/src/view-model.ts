import type { AgentKind, NormalizedEvent } from "@agentlens/contracts";

export type TimelineSortDirection = "first-latest" | "latest-first";

interface TimelineSortable {
  index: number;
  timestampMs: number | null;
}

export interface TruncatedText {
  value: string;
  isTruncated: boolean;
}

const AGENT_ICON_BY_KIND: Record<AgentKind, string | null> = {
  claude: "/icons/claude.svg",
  codex: "/icons/openai.svg",
  opencode: "/icons/opencode.png",
  unknown: null,
};

function sanitizeKind(kind: string): string {
  return kind.replace(/[^a-z_]/g, "");
}

export function kindClassSuffix(kind: string): string {
  return sanitizeKind(kind);
}

export function classForKind(kind: string): string {
  return `kind kind-${kindClassSuffix(kind)}`;
}

export function eventCardClass(kind: string): string {
  return `event-card event-kind-${kindClassSuffix(kind)}`;
}

export function iconForAgent(agent: AgentKind): string | null {
  return AGENT_ICON_BY_KIND[agent] ?? null;
}

export function pathTail(path: string): string {
  const trimmed = path.replace(/[\\/]+$/g, "");
  if (!trimmed) return path;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

export function domIdForEvent(eventId: string): string {
  return `trace-event-${eventId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export interface TimelineTocRow {
  eventId: string;
  index: number;
  timestampMs: number | null;
  eventKind: string;
  label: string;
  colorKey: string;
  toolType: string;
}

export interface TimelineStripSegment {
  eventId: string;
  index: number;
  timestampMs: number | null;
  eventKind: string;
  label: string;
  colorKey: string;
}

export function buildTimelineTocRows(events: NormalizedEvent[]): TimelineTocRow[] {
  return events.map((event) => ({
    eventId: event.eventId,
    index: event.index,
    timestampMs: event.timestampMs,
    eventKind: event.eventKind,
    label: event.tocLabel || event.preview,
    colorKey: event.eventKind,
    toolType: event.toolType,
  }));
}

export function buildTimelineStripSegments(events: NormalizedEvent[]): TimelineStripSegment[] {
  return sortTimelineItems(
    events.map((event) => ({
      eventId: event.eventId,
      index: event.index,
      timestampMs: event.timestampMs,
      eventKind: event.eventKind,
      label: event.tocLabel || event.preview,
      colorKey: event.eventKind,
    })),
    "first-latest",
  );
}

export function sortTimelineItems<T extends TimelineSortable>(items: T[], direction: TimelineSortDirection): T[] {
  const sorted = [...items].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0) || a.index - b.index);
  return direction === "latest-first" ? sorted.reverse() : sorted;
}

export function truncateText(value: string, maxChars: number): TruncatedText {
  const limit = Math.max(0, Math.floor(maxChars));
  if (value.length <= limit) {
    return { value, isTruncated: false };
  }
  return { value: value.slice(0, limit), isTruncated: true };
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${value.toFixed(digits)}%`;
}

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "N/A";
  return `$${value.toFixed(4)}`;
}
