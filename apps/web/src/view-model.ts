import type { NormalizedEvent } from "@agentlens/contracts";

export type TimelineSortDirection = "first-latest" | "latest-first";

interface TimelineSortable {
  index: number;
  timestampMs: number | null;
}

export interface TruncatedText {
  value: string;
  isTruncated: boolean;
}

function sanitizeKind(kind: string): string {
  return kind.replace(/[^a-z_]/g, "");
}

export function classForKind(kind: string): string {
  return `kind kind-${sanitizeKind(kind)}`;
}

export function eventCardClass(kind: string): string {
  return `event-card event-kind-${sanitizeKind(kind)}`;
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
}

export function buildTimelineTocRows(events: NormalizedEvent[]): TimelineTocRow[] {
  return events.map((event) => ({
    eventId: event.eventId,
    index: event.index,
    timestampMs: event.timestampMs,
    eventKind: event.eventKind,
    label: event.tocLabel || event.preview,
    colorKey: event.eventKind,
  }));
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
