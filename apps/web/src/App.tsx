import { useCallback, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import type { OverviewStats, TracePage, TraceSummary } from "@agentlens/contracts";
import {
  buildTimelineStripSegments,
  classForKind,
  domIdForEvent,
  eventCardClass,
  formatCompactNumber,
  formatPercent,
  formatUsd,
  kindClassSuffix,
  sortTimelineItems,
  type TimelineSortDirection,
} from "./view-model.js";
import { SessionTraceRow } from "./SessionTraceRow.js";
import { useListReorderAnimation } from "./useListReorderAnimation.js";
import { useTraceRowReorderAnimation } from "./useTraceRowReorderAnimation.js";

const API = "";
const EVENT_ENTER_ANIMATION_MS = 560;
const EVENT_APPEND_QUEUE_BATCH_SIZE = 6;
const EVENT_APPEND_QUEUE_DELAY_MS = 36;
const TRACE_ENTER_ANIMATION_MS = 620;
const TIMELINE_LATEST_EPSILON_PX = 12;
const HEADER_FLASH_VISIBLE_MS = 2_400;
const HEADER_FLASH_FADE_MS = 380;
const CLOCK_TICK_MS = 5_000;
const TIMELINE_EVENT_INITIAL_RENDER_LIMIT = 240;
const TIMELINE_EVENT_RENDER_STEP = 240;
const TIMELINE_EVENT_RENDER_PREFETCH_PX = 320;
const RECENT_TRACE_LIMIT = 50;
const TRACE_PAGE_CACHE_ENTRY_LIMIT = RECENT_TRACE_LIMIT * 2;

interface StopTraceResponse {
  ok?: boolean;
  error?: string;
  signal?: string | null;
}

interface OpenTraceResponse {
  ok?: boolean;
  error?: string;
  status?: string;
  message?: string;
  pid?: number | null;
  tty?: string;
  target?: {
    tmuxSession?: string;
    windowIndex?: number;
    paneIndex?: number;
  } | null;
}

interface TracePageCacheEntry {
  page: TracePage;
  summaryStamp: string;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function fmtClockTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleTimeString();
}

function fmtTimeAgo(ms: number | null, nowMs: number): string {
  if (!ms) return "-";
  const deltaSeconds = Math.floor(Math.max(0, nowMs - ms) / 1000);
  if (deltaSeconds < 10) return "now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  if (deltaSeconds < 3_600) return `${Math.floor(deltaSeconds / 60)}m ago`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3_600)}h ago`;
  return `${Math.floor(deltaSeconds / 86_400)}d ago`;
}

function buildAgentBadges(event: TracePage["events"][number]): string[] {
  const badges: string[] = [];
  const addBadge = (badge: string): void => {
    if (!badge) return;
    if (!badges.includes(badge)) badges.push(badge);
  };
  const raw = event.raw;
  const rawType = typeof raw.type === "string" ? raw.type : "";

  const directModel = typeof raw.model === "string" ? raw.model.trim() : "";
  if (directModel) addBadge(`model:${directModel}`);

  if (rawType === "turn_context") {
    const payload = raw.payload as Record<string, unknown> | undefined;
    const model = typeof payload?.model === "string" ? payload.model : "";
    const approval = typeof payload?.approval_policy === "string" ? payload.approval_policy : "";
    if (model) addBadge(`model:${model}`);
    if (approval) addBadge(`approval:${approval}`);
  }

  if (rawType === "progress") {
    const data = raw.data as Record<string, unknown> | undefined;
    const hookEvent = typeof data?.hookEvent === "string" ? data.hookEvent : "";
    if (hookEvent) addBadge(`hook:${hookEvent}`);
  }

  if (rawType === "system") {
    const subtype = typeof raw.subtype === "string" ? raw.subtype : "";
    if (subtype) addBadge(`system:${subtype}`);
  }

  return badges.slice(0, 3);
}

function sortTraces(traces: TraceSummary[]): TraceSummary[] {
  return [...traces].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function limitRecentTraces(traces: TraceSummary[]): TraceSummary[] {
  return sortTraces(traces).slice(0, RECENT_TRACE_LIMIT);
}

function summaryNumberStamp(value: number | null | undefined, digits = 6): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "na";
}

function buildTraceSummaryStamp(
  summary: Pick<
    TraceSummary,
    | "eventCount"
    | "mtimeMs"
    | "lastEventTs"
    | "costEstimateUsd"
    | "contextWindowPct"
    | "tokenTotals"
    | "modelTokenSharesTop"
    | "modelTokenSharesEstimated"
  >,
): string {
  const tokenTotals = summary.tokenTotals;
  const tokenStamp = tokenTotals
    ? [
        tokenTotals.inputTokens,
        tokenTotals.cachedReadTokens,
        tokenTotals.cachedCreateTokens,
        tokenTotals.outputTokens,
        tokenTotals.reasoningOutputTokens,
        tokenTotals.totalTokens,
      ]
        .map((value) => summaryNumberStamp(value, 0))
        .join(",")
    : "na";
  const modelStamp =
    (summary.modelTokenSharesTop ?? [])
      .map((row) => `${row.model}:${summaryNumberStamp(row.tokens, 0)}:${summaryNumberStamp(row.percent)}`)
      .join("|") || "na";
  return [
    summary.eventCount,
    summary.mtimeMs,
    summary.lastEventTs ?? 0,
    summaryNumberStamp(summary.costEstimateUsd),
    summaryNumberStamp(summary.contextWindowPct),
    tokenStamp,
    modelStamp,
    summary.modelTokenSharesEstimated ? "estimated" : "exact",
  ].join(":");
}

function buildTracePageCacheKey(traceId: string, includeMeta: boolean): string {
  return `${includeMeta ? "meta" : "default"}:${traceId}`;
}

function upsertTracePageCache(cache: Map<string, TracePageCacheEntry>, key: string, entry: TracePageCacheEntry): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, entry);
  while (cache.size > TRACE_PAGE_CACHE_ENTRY_LIMIT) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function removeTracePageCacheEntries(cache: Map<string, TracePageCacheEntry>, traceId: string): void {
  cache.delete(buildTracePageCacheKey(traceId, false));
  cache.delete(buildTracePageCacheKey(traceId, true));
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function clearAnimationTimers(timerById: Map<string, number>): void {
  for (const timeoutId of timerById.values()) {
    window.clearTimeout(timeoutId);
  }
  timerById.clear();
}

function readTimelineStripViewport(scroller: HTMLElement): { hasOverflow: boolean; atLatest: boolean } {
  const hasOverflow = scroller.scrollWidth > scroller.clientWidth + 1;
  if (!hasOverflow) return { hasOverflow: false, atLatest: true };
  const atLatest = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - TIMELINE_LATEST_EPSILON_PX;
  return { hasOverflow: true, atLatest };
}

export function App(): JSX.Element {
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [page, setPage] = useState<TracePage | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [flashStatus, setFlashStatus] = useState("");
  const [isFlashStatusFading, setIsFlashStatusFading] = useState(false);
  const [lastLiveUpdateMs, setLastLiveUpdateMs] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [includeMeta, setIncludeMeta] = useState(false);
  const [tocQuery, setTocQuery] = useState("");
  const [selectedEventId, setSelectedEventId] = useState("");
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [expandedPathTraceIds, setExpandedPathTraceIds] = useState<Set<string>>(new Set());
  const [autoFollow, setAutoFollow] = useState(true);
  const [timelineSortDirection, setTimelineSortDirection] = useState<TimelineSortDirection>("latest-first");
  const [timelineEventRenderLimit, setTimelineEventRenderLimit] = useState(TIMELINE_EVENT_INITIAL_RENDER_LIMIT);
  const [liveTick, setLiveTick] = useState(0);
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  const [enteringTraceIds, setEnteringTraceIds] = useState<Set<string>>(new Set());
  const [enteringEventIds, setEnteringEventIds] = useState<Set<string>>(new Set());
  const [visibleEventIds, setVisibleEventIds] = useState<Set<string>>(new Set());
  const [pulseSeqByTraceId, setPulseSeqByTraceId] = useState<Record<string, number>>({});
  const [openingTraceIds, setOpeningTraceIds] = useState<Set<string>>(new Set());
  const [openErrorByTraceId, setOpenErrorByTraceId] = useState<Record<string, string>>({});
  const [stoppingTraceIds, setStoppingTraceIds] = useState<Set<string>>(new Set());
  const [stopErrorByTraceId, setStopErrorByTraceId] = useState<Record<string, string>>({});
  const [timelineStripHasOverflow, setTimelineStripHasOverflow] = useState(false);
  const [timelineStripPinnedToLatest, setTimelineStripPinnedToLatest] = useState(true);
  const [timelineOffscreenAppendCount, setTimelineOffscreenAppendCount] = useState(0);
  const selectedIdRef = useRef("");
  const timelineStripRef = useRef<HTMLDivElement | null>(null);
  const timelinePinnedToLatestRef = useRef(true);
  const timelineHasOverflowRef = useRef(false);
  const timelinePinnedStateRef = useRef(true);
  const previousTimelineTraceIdRef = useRef("");
  const previousTimelineEventCountRef = useRef(0);
  const previousTraceFilterRef = useRef("");
  const traceEnterAnimationInitializedRef = useRef(false);
  const previousVisibleTraceIdsRef = useRef<Set<string>>(new Set());
  const previousSelectedTraceIdRef = useRef("");
  const previousAnimatedTraceIdRef = useRef("");
  const previousPageEventIdsRef = useRef<Set<string>>(new Set());
  const queuedEventIdsRef = useRef<string[]>([]);
  const queuedEventTimerRef = useRef<number | null>(null);
  const enterAnimationTimerByTraceIdRef = useRef<Map<string, number>>(new Map());
  const enterAnimationTimerByEventIdRef = useRef<Map<string, number>>(new Map());
  const flashStatusFadeTimerRef = useRef<number | null>(null);
  const flashStatusClearTimerRef = useRef<number | null>(null);
  const manualStopAtByTraceIdRef = useRef<Record<string, number>>({});
  const tracePageCacheRef = useRef<Map<string, TracePageCacheEntry>>(new Map());
  const traceLoadRequestSeqRef = useRef(0);
  const previousTraceLoadInputsRef = useRef<{ selectedId: string; includeMeta: boolean; liveTick: number }>({
    selectedId: "",
    includeMeta: false,
    liveTick: 0,
  });

  const applyManualStopOverride = useCallback((trace: TraceSummary): TraceSummary => {
    const manualStopAtMs = manualStopAtByTraceIdRef.current[trace.id];
    if (!manualStopAtMs) return trace;
    const latestActivityMs = Math.max(trace.lastEventTs ?? 0, trace.mtimeMs);
    if (latestActivityMs > manualStopAtMs) {
      delete manualStopAtByTraceIdRef.current[trace.id];
      return trace;
    }
    if (trace.activityStatus === "idle" && trace.activityReason === "manually_stopped") {
      return trace;
    }
    return {
      ...trace,
      activityStatus: "idle",
      activityReason: "manually_stopped",
    };
  }, []);

  const filteredTraces = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = sortTraces(traces);
    if (!q) return base;
    return base.filter((trace) => {
      const search = `${trace.path}\n${trace.agent}\n${trace.sessionId}\n${trace.id}`.toLowerCase();
      return search.includes(q);
    });
  }, [traces, query]);

  const visibleTimelineEvents = useMemo(() => {
    if (!page || visibleEventIds.size === 0) return [];
    return page.events.filter((event) => visibleEventIds.has(event.eventId));
  }, [page, visibleEventIds]);

  const tocRows = useMemo(() => {
    const rows = sortTimelineItems(
      (page?.toc ?? []).filter((row) => visibleEventIds.has(row.eventId)),
      timelineSortDirection,
    );
    const q = tocQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => {
      const search = `${row.index}\n${row.eventKind}\n${row.toolType}\n${row.label}`.toLowerCase();
      return search.includes(q);
    });
  }, [page, tocQuery, timelineSortDirection, visibleEventIds]);

  const timelineEvents = useMemo(
    () => sortTimelineItems(visibleTimelineEvents, timelineSortDirection),
    [visibleTimelineEvents, timelineSortDirection],
  );
  const renderedTimelineEvents = useMemo(() => {
    const limit = Math.max(1, timelineEventRenderLimit);
    if (timelineEvents.length <= limit) return timelineEvents;
    return timelineEvents.slice(0, limit);
  }, [timelineEventRenderLimit, timelineEvents]);
  const renderedTocRows = useMemo(() => {
    const limit = Math.max(1, timelineEventRenderLimit);
    if (tocRows.length <= limit) return tocRows;
    return tocRows.slice(0, limit);
  }, [timelineEventRenderLimit, tocRows]);
  const timelineStripEvents = useMemo(() => buildTimelineStripSegments(visibleTimelineEvents), [visibleTimelineEvents]);
  const tocRowIds = useMemo(() => renderedTocRows.map((row) => row.eventId), [renderedTocRows]);
  const timelineEventIds = useMemo(() => renderedTimelineEvents.map((event) => event.eventId), [renderedTimelineEvents]);
  const filteredTraceIds = useMemo(() => filteredTraces.map((trace) => trace.id), [filteredTraces]);
  const timelineStripShowsRightGlow =
    timelineStripHasOverflow && timelineOffscreenAppendCount > 0 && !timelineStripPinnedToLatest;
  const selectedTraceSummary = useMemo(() => {
    if (!selectedId) return null;
    return traces.find((trace) => trace.id === selectedId) ?? null;
  }, [selectedId, traces]);
  const selectedTraceSummaryStamp = selectedTraceSummary ? buildTraceSummaryStamp(selectedTraceSummary) : "";
  const selectedTracePulseSeq = selectedTraceSummary ? (pulseSeqByTraceId[selectedTraceSummary.id] ?? 0) : 0;
  const selectedTraceLabel = selectedTraceSummary?.sessionId || selectedTraceSummary?.id || "";
  const selectedTraceEventCount = selectedTraceSummary?.eventCount ?? 0;
  const selectedTraceUpdatedMs = selectedTraceSummary
    ? Math.max(selectedTraceSummary.lastEventTs ?? 0, selectedTraceSummary.mtimeMs)
    : null;
  const selectedTraceMeta = selectedTraceSummary
    ? `${selectedTraceSummary.agent} · ${selectedTraceEventCount} ${selectedTraceEventCount === 1 ? "event" : "events"} · updated ${fmtTimeAgo(selectedTraceUpdatedMs, clockNowMs)}`
    : "Pick a session to inspect.";
  const sessionStatusCounts = useMemo(() => {
    const counts = {
      running: 0,
      waiting_input: 0,
      idle: 0,
    };
    for (const trace of filteredTraces) {
      const activityStatus = trace.activityStatus;
      if (activityStatus === "running") counts.running += 1;
      else if (activityStatus === "waiting_input") counts.waiting_input += 1;
      else counts.idle += 1;
    }
    return counts;
  }, [filteredTraces]);
  const toolCallTypeCounts = useMemo(() => {
    if (!page) return [];
    const countedCallKeys = new Set<string>();
    const counts = new Map<string, number>();
    for (const event of page.events) {
      const normalizedToolType = event.toolType.trim();
      if (!normalizedToolType) continue;
      const normalizedToolCallId = event.toolCallId.trim();
      const callKey = normalizedToolCallId ? `${normalizedToolType}:${normalizedToolCallId}` : event.eventId;
      if (countedCallKeys.has(callKey)) continue;
      countedCallKeys.add(callKey);
      counts.set(normalizedToolType, (counts.get(normalizedToolType) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([toolType, count]) => ({ toolType, count }));
  }, [page]);
  const toolCallTypeCountsPreview = toolCallTypeCounts.slice(0, 4);
  const hiddenToolCallTypeCount = Math.max(0, toolCallTypeCounts.length - toolCallTypeCountsPreview.length);
  const toolCallCountTotal = toolCallTypeCounts.reduce((sum, row) => sum + row.count, 0);
  const newestEventTsMs = useMemo(() => {
    let newest = 0;
    for (const trace of traces) {
      const traceNewest = trace.lastEventTs ?? 0;
      if (traceNewest > newest) newest = traceNewest;
    }
    return newest > 0 ? newest : null;
  }, [traces]);
  const baseHeaderStatus = useMemo(() => {
    if (!status.startsWith("Live:") || !lastLiveUpdateMs) return status;
    if (!newestEventTsMs) return `${status} · updated ${fmtClockTime(lastLiveUpdateMs)}`;
    return `${status} · updated ${fmtClockTime(lastLiveUpdateMs)} · newest event ${fmtClockTime(newestEventTsMs)}`;
  }, [lastLiveUpdateMs, newestEventTsMs, status]);
  const headerStatus = flashStatus || baseHeaderStatus;
  const heroStatusClassName = `hero-status mono${flashStatus ? " flash-active" : ""}${isFlashStatusFading ? " flash-fading" : ""}`;
  const toolCallTypeCountRows = useMemo(() => {
    const rows: Array<Array<{ toolType: string; count: number }>> = [];
    for (let index = 0; index < toolCallTypeCountsPreview.length; index += 2) {
      rows.push(toolCallTypeCountsPreview.slice(index, index + 2));
    }
    return rows;
  }, [toolCallTypeCountsPreview]);
  const { bindTraceRowRef, removeTraceRow } = useTraceRowReorderAnimation(filteredTraceIds);
  const { bindItemRef: bindTocRowRef } = useListReorderAnimation<HTMLButtonElement>(tocRowIds, { resetKey: selectedId });
  const { bindItemRef: bindEventCardRef } = useListReorderAnimation<HTMLElement>(timelineEventIds, {
    resetKey: selectedId,
  });

  const growTimelineRenderWindow = useCallback((): void => {
    setTimelineEventRenderLimit((prev) => {
      if (prev >= timelineEvents.length) return prev;
      return Math.min(prev + TIMELINE_EVENT_RENDER_STEP, timelineEvents.length);
    });
  }, [timelineEvents.length]);

  const maybeGrowTimelineRenderWindow = useCallback(
    (target: HTMLDivElement): void => {
      if (timelineEventRenderLimit >= timelineEvents.length) return;
      const distanceToBottom = target.scrollHeight - (target.scrollTop + target.clientHeight);
      if (distanceToBottom <= TIMELINE_EVENT_RENDER_PREFETCH_PX) {
        growTimelineRenderWindow();
      }
    },
    [growTimelineRenderWindow, timelineEventRenderLimit, timelineEvents.length],
  );

  useEffect(() => {
    setTimelineEventRenderLimit(TIMELINE_EVENT_INITIAL_RENDER_LIMIT);
  }, [selectedId, timelineSortDirection, tocQuery]);

  const applyTimelineStripViewport = useCallback(
    (nextViewport: { hasOverflow: boolean; atLatest: boolean }, clearOffscreenWhenPinned = true): void => {
      if (timelineHasOverflowRef.current !== nextViewport.hasOverflow) {
        timelineHasOverflowRef.current = nextViewport.hasOverflow;
        setTimelineStripHasOverflow(nextViewport.hasOverflow);
      }
      timelinePinnedToLatestRef.current = nextViewport.atLatest;
      if (timelinePinnedStateRef.current !== nextViewport.atLatest) {
        timelinePinnedStateRef.current = nextViewport.atLatest;
        setTimelineStripPinnedToLatest(nextViewport.atLatest);
      }
      if (clearOffscreenWhenPinned && (nextViewport.atLatest || !nextViewport.hasOverflow)) {
        setTimelineOffscreenAppendCount((value) => (value === 0 ? value : 0));
      }
    },
    [],
  );

  const clearFlashStatusTimers = useCallback((): void => {
    if (flashStatusFadeTimerRef.current !== null) {
      window.clearTimeout(flashStatusFadeTimerRef.current);
      flashStatusFadeTimerRef.current = null;
    }
    if (flashStatusClearTimerRef.current !== null) {
      window.clearTimeout(flashStatusClearTimerRef.current);
      flashStatusClearTimerRef.current = null;
    }
  }, []);

  const flashHeaderStatus = useCallback(
    (message: string): void => {
      const normalized = message.trim();
      if (!normalized) return;
      clearFlashStatusTimers();
      setFlashStatus(normalized);
      setIsFlashStatusFading(false);
      flashStatusFadeTimerRef.current = window.setTimeout(() => {
        setIsFlashStatusFading(true);
      }, HEADER_FLASH_VISIBLE_MS);
      flashStatusClearTimerRef.current = window.setTimeout(() => {
        setFlashStatus("");
        setIsFlashStatusFading(false);
        flashStatusFadeTimerRef.current = null;
        flashStatusClearTimerRef.current = null;
      }, HEADER_FLASH_VISIBLE_MS + HEADER_FLASH_FADE_MS);
    },
    [clearFlashStatusTimers],
  );

  const clearEventAppendQueue = useCallback((): void => {
    if (queuedEventTimerRef.current !== null) {
      window.clearTimeout(queuedEventTimerRef.current);
      queuedEventTimerRef.current = null;
    }
    queuedEventIdsRef.current = [];
  }, []);

  const scheduleEventEnterAnimationCleanup = useCallback((eventId: string): void => {
    const existingTimer = enterAnimationTimerByEventIdRef.current.get(eventId);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
      enterAnimationTimerByEventIdRef.current.delete(eventId);
    }
    const timeoutId = window.setTimeout(() => {
      setEnteringEventIds((prev) => {
        if (!prev.has(eventId)) return prev;
        const next = new Set(prev);
        next.delete(eventId);
        return next;
      });
      enterAnimationTimerByEventIdRef.current.delete(eventId);
    }, EVENT_ENTER_ANIMATION_MS);
    enterAnimationTimerByEventIdRef.current.set(eventId, timeoutId);
  }, []);

  const flushQueuedEventBatch = useCallback((): void => {
    if (queuedEventIdsRef.current.length === 0) {
      queuedEventTimerRef.current = null;
      return;
    }

    const batch = queuedEventIdsRef.current.splice(0, EVENT_APPEND_QUEUE_BATCH_SIZE);
    if (batch.length > 0) {
      setVisibleEventIds((prev) => {
        const next = new Set(prev);
        for (const eventId of batch) next.add(eventId);
        return next;
      });
      setEnteringEventIds((prev) => {
        const next = new Set(prev);
        for (const eventId of batch) next.add(eventId);
        return next;
      });
      for (const eventId of batch) {
        scheduleEventEnterAnimationCleanup(eventId);
      }
    }

    if (queuedEventIdsRef.current.length === 0) {
      queuedEventTimerRef.current = null;
      return;
    }

    queuedEventTimerRef.current = window.setTimeout(() => {
      flushQueuedEventBatch();
    }, EVENT_APPEND_QUEUE_DELAY_MS);
  }, [scheduleEventEnterAnimationCleanup]);

  const enqueueEventsForAppendReveal = useCallback(
    (eventIds: string[]): void => {
      if (eventIds.length === 0) return;
      const queuedEventIdSet = new Set(queuedEventIdsRef.current);
      for (const eventId of eventIds) {
        if (queuedEventIdSet.has(eventId)) continue;
        queuedEventIdSet.add(eventId);
        queuedEventIdsRef.current.push(eventId);
      }
      if (queuedEventTimerRef.current !== null) return;
      queuedEventTimerRef.current = window.setTimeout(() => {
        flushQueuedEventBatch();
      }, EVENT_APPEND_QUEUE_DELAY_MS);
    },
    [flushQueuedEventBatch],
  );

  const handleTimelineStripScroll = useCallback((): void => {
    const scroller = timelineStripRef.current;
    if (!scroller) return;
    applyTimelineStripViewport(readTimelineStripViewport(scroller));
  }, [applyTimelineStripViewport]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (selectedId && traces.some((trace) => trace.id === selectedId)) return;
    const fallbackId = traces[0]?.id ?? "";
    if (fallbackId === selectedId) return;
    setSelectedId(fallbackId);
  }, [selectedId, traces]);

  useEffect(
    () => () => {
      clearEventAppendQueue();
      clearFlashStatusTimers();
      clearAnimationTimers(enterAnimationTimerByTraceIdRef.current);
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
    },
    [clearEventAppendQueue, clearFlashStatusTimers],
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setClockNowMs(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    const onResize = (): void => {
      const scroller = timelineStripRef.current;
      if (!scroller) return;
      applyTimelineStripViewport(readTimelineStripViewport(scroller));
    };

    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [applyTimelineStripViewport]);

  useEffect(() => {
    const filter = query.trim().toLowerCase();
    const filterChanged = previousTraceFilterRef.current !== filter;
    previousTraceFilterRef.current = filter;

    const currentTraceIds = new Set(filteredTraceIds);
    if (filterChanged || !traceEnterAnimationInitializedRef.current) {
      traceEnterAnimationInitializedRef.current = true;
      previousVisibleTraceIdsRef.current = currentTraceIds;
      setEnteringTraceIds(new Set());
      clearAnimationTimers(enterAnimationTimerByTraceIdRef.current);
      return;
    }

    const appendedTraceIds = filteredTraceIds.filter((traceId) => !previousVisibleTraceIdsRef.current.has(traceId));
    previousVisibleTraceIdsRef.current = currentTraceIds;
    if (appendedTraceIds.length === 0) return;

    setEnteringTraceIds((prev) => {
      const next = new Set(prev);
      for (const traceId of appendedTraceIds) next.add(traceId);
      return next;
    });

    appendedTraceIds.forEach((traceId, index) => {
      const existingTimer = enterAnimationTimerByTraceIdRef.current.get(traceId);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        enterAnimationTimerByTraceIdRef.current.delete(traceId);
      }
      const timeoutId = window.setTimeout(() => {
        setEnteringTraceIds((prev) => {
          if (!prev.has(traceId)) return prev;
          const next = new Set(prev);
          next.delete(traceId);
          return next;
        });
        enterAnimationTimerByTraceIdRef.current.delete(traceId);
      }, TRACE_ENTER_ANIMATION_MS + index * 45);
      enterAnimationTimerByTraceIdRef.current.set(traceId, timeoutId);
    });
  }, [filteredTraceIds, query]);

  useEffect(() => {
    const bumpPulse = (traceId: string): void => {
      if (!traceId) return;
      setPulseSeqByTraceId((prev) => ({
        ...prev,
        [traceId]: (prev[traceId] ?? 0) + 1,
      }));
    };

    const loadBoot = async (): Promise<void> => {
      try {
        const [overviewResp, tracesResp] = await Promise.all([
          fetchJson<{ overview: OverviewStats }>(`${API}/api/overview`),
          fetchJson<{ traces: TraceSummary[] }>(`${API}/api/traces?limit=${RECENT_TRACE_LIMIT}`),
        ]);
        const sorted = limitRecentTraces(tracesResp.traces.map(applyManualStopOverride));
        setOverview(overviewResp.overview);
        setTraces(sorted);
        setSelectedId((prev) => prev || sorted[0]?.id || "");
        setStatus(`Loaded ${sorted.length} traces`);
      } catch (error) {
        setStatus(`Failed: ${String(error)}`);
      }
    };

    void loadBoot();

    const source = new EventSource(`${API}/api/stream?limit=${RECENT_TRACE_LIMIT}`);

    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as {
          payload?: { traces?: TraceSummary[]; overview?: OverviewStats };
        };
        const nextTraces = limitRecentTraces((data.payload?.traces ?? []).map(applyManualStopOverride));
        if (nextTraces.length > 0) {
          setTraces(nextTraces);
          setSelectedId((prev) => prev || nextTraces[0]?.id || "");
        }
        if (data.payload?.overview) setOverview(data.payload.overview);
        setStatus(`Live: ${nextTraces.length} traces`);
        setLastLiveUpdateMs(Date.now());
      } catch {
        setStatus("Live update parse error");
      }
    });

    const upsert = (summary: TraceSummary): void => {
      const patchedSummary = applyManualStopOverride(summary);
      setTraces((prev) => {
        const next = [...prev];
        const index = next.findIndex((item) => item.id === patchedSummary.id);
        if (index >= 0) {
          next[index] = patchedSummary;
        } else {
          next.push(patchedSummary);
        }
        return limitRecentTraces(next);
      });
      setSelectedId((prev) => prev || patchedSummary.id);
    };

    source.addEventListener("trace_added", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { summary?: TraceSummary } };
      if (data.payload?.summary) {
        upsert(data.payload.summary);
        setLastLiveUpdateMs(Date.now());
        bumpPulse(data.payload.summary.id);
      }
    });

    source.addEventListener("trace_updated", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { summary?: TraceSummary } };
      if (data.payload?.summary) {
        upsert(data.payload.summary);
        setLastLiveUpdateMs(Date.now());
        bumpPulse(data.payload.summary.id);
      }
    });

    source.addEventListener("trace_removed", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { id?: string } };
      const id = data.payload?.id;
      if (!id) return;
      delete manualStopAtByTraceIdRef.current[id];
      removeTracePageCacheEntries(tracePageCacheRef.current, id);
      setTraces((prev) => prev.filter((trace) => trace.id !== id));
      setSelectedId((prev) => (prev === id ? "" : prev));
      removeTraceRow(id);
      setEnteringTraceIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      const traceEnterTimer = enterAnimationTimerByTraceIdRef.current.get(id);
      if (traceEnterTimer !== undefined) {
        window.clearTimeout(traceEnterTimer);
        enterAnimationTimerByTraceIdRef.current.delete(id);
      }
      setPulseSeqByTraceId((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setStoppingTraceIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setOpeningTraceIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setStopErrorByTraceId((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setOpenErrorByTraceId((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLastLiveUpdateMs(Date.now());
    });

    source.addEventListener("overview_updated", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { overview?: OverviewStats } };
      if (data.payload?.overview) {
        setOverview(data.payload.overview);
        setLastLiveUpdateMs(Date.now());
      }
    });

    source.addEventListener("events_appended", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as { payload?: { id?: string; appended?: number } };
      if (data.payload?.id && data.payload.id === selectedIdRef.current) {
        setLastLiveUpdateMs(Date.now());
        if ((data.payload.appended ?? 0) > 0) {
          setLiveTick((value) => value + 1);
        }
      }
    });

    source.onerror = () => {
      setStatus("Live stream disconnected; retrying...");
    };

    return () => {
      source.close();
    };
  }, [applyManualStopOverride, removeTraceRow]);

  useEffect(() => {
    if (!selectedId) {
      traceLoadRequestSeqRef.current += 1;
      previousTraceLoadInputsRef.current = { selectedId: "", includeMeta, liveTick };
      setPage(null);
      setExpandedEventIds(new Set());
      setEnteringEventIds(new Set());
      setVisibleEventIds(new Set());
      timelineHasOverflowRef.current = false;
      timelinePinnedStateRef.current = true;
      setTimelineStripHasOverflow((value) => (value ? false : value));
      setTimelineStripPinnedToLatest((value) => (value ? value : true));
      setTimelineOffscreenAppendCount((value) => (value === 0 ? value : 0));
      timelinePinnedToLatestRef.current = true;
      previousTimelineTraceIdRef.current = "";
      previousTimelineEventCountRef.current = 0;
      previousAnimatedTraceIdRef.current = "";
      previousPageEventIdsRef.current = new Set();
      clearEventAppendQueue();
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
      previousSelectedTraceIdRef.current = "";
      return;
    }

    const isTraceChanged = previousSelectedTraceIdRef.current !== selectedId;
    previousSelectedTraceIdRef.current = selectedId;
    const previousLoadInputs = previousTraceLoadInputsRef.current;
    const sameTraceAsPreviousLoad = previousLoadInputs.selectedId === selectedId;
    const includeMetaChanged = previousLoadInputs.includeMeta !== includeMeta;
    const liveTickChanged = previousLoadInputs.liveTick !== liveTick;
    previousTraceLoadInputsRef.current = { selectedId, includeMeta, liveTick };
    const cacheKey = buildTracePageCacheKey(selectedId, includeMeta);
    const selectedSummaryStamp = selectedTraceSummaryStamp;
    const cachedEntry = tracePageCacheRef.current.get(cacheKey);

    const applyTraceDetail = (detail: TracePage): void => {
      const eventIds = new Set(detail.events.map((event) => event.eventId));
      setPage(detail);
      setExpandedEventIds((prev) => {
        if (isTraceChanged) return new Set();
        const next = new Set<string>();
        for (const eventId of prev) {
          if (eventIds.has(eventId)) next.add(eventId);
        }
        return next;
      });
      setSelectedEventId((prev) => {
        if (prev && detail.events.some((event) => event.eventId === prev)) {
          return prev;
        }
        return sortTimelineItems(detail.events, timelineSortDirection)[0]?.eventId ?? "";
      });
    };

    if (cachedEntry) {
      applyTraceDetail(cachedEntry.page);
    }

    const shouldFetch =
      !cachedEntry ||
      !selectedSummaryStamp ||
      cachedEntry.summaryStamp !== selectedSummaryStamp ||
      (sameTraceAsPreviousLoad && (includeMetaChanged || liveTickChanged));
    if (!shouldFetch) {
      return;
    }

    traceLoadRequestSeqRef.current += 1;
    const requestSeq = traceLoadRequestSeqRef.current;
    const abortController = new AbortController();

    const loadTrace = async (): Promise<void> => {
      try {
        const detail = await fetchJson<TracePage>(
          `${API}/api/trace/${encodeURIComponent(selectedId)}?limit=1200&include_meta=${includeMeta ? "1" : "0"}`,
          { signal: abortController.signal },
        );
        if (abortController.signal.aborted) return;
        if (traceLoadRequestSeqRef.current !== requestSeq) return;
        upsertTracePageCache(tracePageCacheRef.current, cacheKey, {
          page: detail,
          summaryStamp: buildTraceSummaryStamp(detail.summary),
        });
        applyTraceDetail(detail);
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (error instanceof Error && error.name === "AbortError") return;
        setStatus(`Trace load failed: ${String(error)}`);
      }
    };

    void loadTrace();
    return () => {
      abortController.abort();
    };
  }, [clearEventAppendQueue, selectedId, selectedTraceSummaryStamp, includeMeta, liveTick]);

  useEffect(() => {
    if (!autoFollow) return;
    if (timelineStripEvents.length === 0) return;
    const last = timelineStripEvents[timelineStripEvents.length - 1];
    if (!last) return;
    setSelectedEventId(last.eventId);
  }, [autoFollow, timelineStripEvents]);

  useEffect(() => {
    const scroller = timelineStripRef.current;
    const currentCount = visibleTimelineEvents.length;
    const hiddenCount = Math.max(0, (page?.events.length ?? 0) - currentCount);
    if (!selectedId || !page || !scroller) {
      previousTimelineTraceIdRef.current = selectedId;
      previousTimelineEventCountRef.current = currentCount;
      timelineHasOverflowRef.current = false;
      timelinePinnedStateRef.current = true;
      setTimelineStripHasOverflow((value) => (value ? false : value));
      setTimelineStripPinnedToLatest((value) => (value ? value : true));
      setTimelineOffscreenAppendCount((value) => (value === 0 ? value : 0));
      timelinePinnedToLatestRef.current = true;
      return;
    }

    const isTraceChanged = previousTimelineTraceIdRef.current !== selectedId;
    const previousCount = isTraceChanged ? currentCount : previousTimelineEventCountRef.current;
    const appendedCount = isTraceChanged ? 0 : Math.max(0, currentCount - previousCount);
    const shouldAutoFollowToLatest = timelinePinnedToLatestRef.current;
    const nextViewport = readTimelineStripViewport(scroller);

    previousTimelineTraceIdRef.current = selectedId;
    previousTimelineEventCountRef.current = currentCount;

    if (isTraceChanged) {
      applyTimelineStripViewport(nextViewport);
      setTimelineOffscreenAppendCount(0);
      return;
    }

    if (appendedCount === 0) {
      if (hiddenCount > 0 || queuedEventIdsRef.current.length > 0) return;
      applyTimelineStripViewport(nextViewport);
      return;
    }

    if (shouldAutoFollowToLatest) {
      if (typeof scroller.scrollTo === "function") {
        scroller.scrollTo({ left: scroller.scrollWidth, behavior: "smooth" });
      } else {
        scroller.scrollLeft = scroller.scrollWidth;
      }
      applyTimelineStripViewport(
        {
          hasOverflow: scroller.scrollWidth > scroller.clientWidth + 1,
          atLatest: true,
        },
        true,
      );
      return;
    }

    applyTimelineStripViewport(nextViewport, false);
    if (nextViewport.hasOverflow && !nextViewport.atLatest) {
      setTimelineOffscreenAppendCount((value) => value + appendedCount);
    } else {
      setTimelineOffscreenAppendCount(0);
    }
  }, [applyTimelineStripViewport, page, selectedId, visibleTimelineEvents.length]);

  useEffect(() => {
    if (!selectedId || !page) {
      previousAnimatedTraceIdRef.current = "";
      previousPageEventIdsRef.current = new Set();
      clearEventAppendQueue();
      setVisibleEventIds(new Set());
      setEnteringEventIds(new Set());
      return;
    }

    const currentEventIds = page.events.map((event) => event.eventId);
    const currentEventIdSet = new Set(currentEventIds);
    const isTraceChanged = previousAnimatedTraceIdRef.current !== selectedId;
    previousAnimatedTraceIdRef.current = selectedId;

    if (isTraceChanged) {
      previousPageEventIdsRef.current = currentEventIdSet;
      clearEventAppendQueue();
      setVisibleEventIds(currentEventIdSet);
      setEnteringEventIds(new Set());
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
      return;
    }

    const previousEventIds = previousPageEventIdsRef.current;
    let removedEventDetected = previousEventIds.size > currentEventIdSet.size;
    if (!removedEventDetected) {
      for (const eventId of previousEventIds) {
        if (!currentEventIdSet.has(eventId)) {
          removedEventDetected = true;
          break;
        }
      }
    }

    if (removedEventDetected) {
      previousPageEventIdsRef.current = currentEventIdSet;
      clearEventAppendQueue();
      setVisibleEventIds(currentEventIdSet);
      setEnteringEventIds(new Set());
      clearAnimationTimers(enterAnimationTimerByEventIdRef.current);
      return;
    }

    const appendedEventIds = currentEventIds.filter((eventId) => !previousEventIds.has(eventId));
    previousPageEventIdsRef.current = currentEventIdSet;

    setVisibleEventIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const eventId of prev) {
        if (currentEventIdSet.has(eventId)) {
          next.add(eventId);
          continue;
        }
        changed = true;
      }
      if (!changed && next.size === prev.size) return prev;
      return next;
    });

    queuedEventIdsRef.current = queuedEventIdsRef.current.filter((eventId) => currentEventIdSet.has(eventId));
    if (appendedEventIds.length > 0) {
      enqueueEventsForAppendReveal(appendedEventIds);
    }
  }, [clearEventAppendQueue, enqueueEventsForAppendReveal, page, selectedId]);

  const centerEventInView = (target: HTMLElement): void => {
    const scroller = target.closest(".events-scroll");
    if (!(scroller instanceof HTMLElement)) return;
    const targetRect = target.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const relativeTop = targetRect.top - scrollerRect.top;
    const centeredOffset = (scroller.clientHeight - targetRect.height) / 2;
    const top = scroller.scrollTop + relativeTop - centeredOffset;
    scroller.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  const jumpToEvent = (eventId: string): void => {
    setSelectedEventId(eventId);
    const target = document.getElementById(domIdForEvent(eventId));
    if (target) {
      centerEventInView(target);
      return;
    }

    const eventIndex = timelineEvents.findIndex((event) => event.eventId === eventId);
    if (eventIndex < 0) return;
    setTimelineEventRenderLimit((prev) => {
      const needed = eventIndex + TIMELINE_EVENT_RENDER_STEP;
      return Math.min(Math.max(prev, needed), timelineEvents.length);
    });
    window.setTimeout(() => {
      const delayedTarget = document.getElementById(domIdForEvent(eventId));
      if (!delayedTarget) return;
      centerEventInView(delayedTarget);
    }, 0);
  };

  const toggleExpanded = (eventId: string): void => {
    setExpandedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const toggleTracePathExpanded = (traceId: string): void => {
    setExpandedPathTraceIds((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });
  };

  const openTraceSession = useCallback(async (traceId: string): Promise<void> => {
    setOpeningTraceIds((prev) => {
      if (prev.has(traceId)) return prev;
      const next = new Set(prev);
      next.add(traceId);
      return next;
    });
    setOpenErrorByTraceId((prev) => {
      if (!(traceId in prev)) return prev;
      const next = { ...prev };
      delete next[traceId];
      return next;
    });

    try {
      const response = await fetch(`${API}/api/trace/${encodeURIComponent(traceId)}/open`, {
        method: "POST",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as OpenTraceResponse;
      if (!response.ok || payload.ok !== true) {
        const errorMessage = payload.error?.trim() ? payload.error : `HTTP ${response.status}`;
        setOpenErrorByTraceId((prev) => ({ ...prev, [traceId]: errorMessage }));
        flashHeaderStatus(`Open failed: ${errorMessage}`);
        return;
      }
      const openedAtMs = Date.now();
      const openStatus = payload.status?.trim() ?? "";
      const openMessage = payload.message?.trim() ?? "";
      const targetLabel =
        payload.target &&
        typeof payload.target.tmuxSession === "string" &&
        typeof payload.target.windowIndex === "number" &&
        typeof payload.target.paneIndex === "number"
          ? `${payload.target.tmuxSession}:${payload.target.windowIndex}.${payload.target.paneIndex}`
          : "";
      const pidLabel = typeof payload.pid === "number" ? ` pid ${payload.pid}` : "";
      const ttyLabel = payload.tty?.trim() ? ` tty ${payload.tty.trim()}` : "";
      const detailBits = [targetLabel, pidLabel.trim(), ttyLabel.trim()].filter(Boolean).join(" · ");
      const detailSuffix = detailBits ? ` (${detailBits})` : "";
      if (openStatus === "focused_pane") {
        flashHeaderStatus(`Open focused_pane: ${openMessage || `session ${traceId}`}${detailSuffix}`);
      } else if (openStatus === "ghostty_activated") {
        flashHeaderStatus(`Open ghostty_activated: ${openMessage || `session ${traceId}`}${detailSuffix}`);
      } else {
        flashHeaderStatus(`Open ${openStatus || "unknown"}: ${openMessage || `session ${traceId}`}${detailSuffix}`);
      }
      setLastLiveUpdateMs(openedAtMs);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setOpenErrorByTraceId((prev) => ({ ...prev, [traceId]: errorMessage }));
      flashHeaderStatus(`Open failed: ${errorMessage}`);
    } finally {
      setOpeningTraceIds((prev) => {
        if (!prev.has(traceId)) return prev;
        const next = new Set(prev);
        next.delete(traceId);
        return next;
      });
    }
  }, [flashHeaderStatus]);

  const stopTraceSession = useCallback(async (traceId: string): Promise<void> => {
    setStoppingTraceIds((prev) => {
      if (prev.has(traceId)) return prev;
      const next = new Set(prev);
      next.add(traceId);
      return next;
    });
    setStopErrorByTraceId((prev) => {
      if (!(traceId in prev)) return prev;
      const next = { ...prev };
      delete next[traceId];
      return next;
    });

    try {
      const response = await fetch(`${API}/api/trace/${encodeURIComponent(traceId)}/stop`, {
        method: "POST",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as StopTraceResponse;
      if (!response.ok || payload.ok !== true) {
        const errorMessage = payload.error?.trim() ? payload.error : `HTTP ${response.status}`;
        setStopErrorByTraceId((prev) => ({ ...prev, [traceId]: errorMessage }));
        flashHeaderStatus(`Stop failed: ${errorMessage}`);
        return;
      }
      const stoppedAtMs = Date.now();
      manualStopAtByTraceIdRef.current[traceId] = stoppedAtMs;
      setTraces((prev) => {
        const index = prev.findIndex((trace) => trace.id === traceId);
        if (index < 0) return prev;
        const current = prev[index];
        if (!current) return prev;
        const next = [...prev];
        next[index] = {
          ...current,
          activityStatus: "idle",
          activityReason: "manually_stopped",
        };
        return sortTraces(next);
      });
      const signalLabel = payload.signal?.trim() ? payload.signal : "signal";
      flashHeaderStatus(`Stop requested (${signalLabel}) for ${traceId}`);
      setLastLiveUpdateMs(stoppedAtMs);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setStopErrorByTraceId((prev) => ({ ...prev, [traceId]: errorMessage }));
      flashHeaderStatus(`Stop failed: ${errorMessage}`);
    } finally {
      setStoppingTraceIds((prev) => {
        if (!prev.has(traceId)) return prev;
        const next = new Set(prev);
        next.delete(traceId);
        return next;
      });
    }
  }, [flashHeaderStatus]);

  return (
    <main className="shell">
      <header className="hero">
        <div className="hero-main">
          <div className="hero-title-line">
            <h1>🔍 AgentLens</h1>
            <div className={heroStatusClassName} title={headerStatus}>
              {headerStatus}
            </div>
          </div>
          <p>Live observability for your Codex, Claude, Cursor, Gemini and OpenCode agent sessions.</p>
        </div>
        <div className="hero-metrics">
          <span>{`sessions ${overview?.sessionCount ?? overview?.traceCount ?? 0}`}</span>
          <span>{`events ${overview?.eventCount ?? 0}`}</span>
          <span>{`errors ${overview?.errorCount ?? 0}`}</span>
          <span>{`tool io ${(overview?.toolUseCount ?? 0) + (overview?.toolResultCount ?? 0)}`}</span>
          <a className="hero-github-tag mono" href="https://github.com/RobertTLange/agentlens" title="AgentLens on GitHub">
            <svg className="hero-github-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49C4 14.09 3.48 13.22 3.32 12.77c-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.7 7.7 0 0 1 8 4.84c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
            <span>agentlens</span>
          </a>
        </div>
      </header>

      <section
        className={`timeline-strip-panel ${timelineStripShowsRightGlow ? "timeline-strip-has-right-glow" : ""}`}
        aria-label={
          timelineStripShowsRightGlow
            ? `Session timeline summary, ${timelineOffscreenAppendCount} new events off-screen to the right`
            : "Session timeline summary"
        }
      >
        {timelineStripEvents.length > 0 ? (
          <div
            className="timeline-strip-scroll"
            ref={timelineStripRef}
            onScroll={handleTimelineStripScroll}
            data-at-latest={timelineStripPinnedToLatest ? "true" : "false"}
            data-has-overflow={timelineStripHasOverflow ? "true" : "false"}
          >
            <div className="timeline-strip-track" aria-label="Chronological timeline events">
              {timelineStripEvents.map((event) => {
                const isActive = event.eventId === selectedEventId;
                const eventTime = fmtTime(event.timestampMs);
                const eventLabel = event.label || event.eventKind;
                return (
                  <button
                    key={event.eventId}
                    type="button"
                    className={`timeline-segment kind-${kindClassSuffix(event.colorKey)} ${isActive ? "active" : ""} ${enteringEventIds.has(event.eventId) ? "timeline-segment-enter" : ""}`}
                    onClick={() => jumpToEvent(event.eventId)}
                    title={`${eventLabel} (${event.eventKind}) #${event.index} ${eventTime}`}
                    aria-label={`Jump to event #${event.index} ${event.eventKind}: ${eventLabel}`}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="timeline-strip-empty">No timeline events</div>
        )}
      </section>

      <div className="grid">
        <section className="panel list-panel">
          <div className="panel-head">
            <div className="session-head-top">
              <h2>Sessions</h2>
              <div className="session-head-counters mono">
                <span className="session-head-counter status-running">{`running ${sessionStatusCounts.running}`}</span>
                <span className="session-head-counter status-waiting">{`waiting ${sessionStatusCounts.waiting_input}`}</span>
              </div>
            </div>
            <input
              className="search"
              placeholder="Search session/path"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="list-scroll">
            {filteredTraces.map((trace) => {
              const isActive = trace.id === selectedId;
              const isPathExpanded = expandedPathTraceIds.has(trace.id);
              const pulseSeq = pulseSeqByTraceId[trace.id] ?? 0;
              const activityStatus = trace.activityStatus;
              return (
                <SessionTraceRow
                  key={trace.id}
                  trace={trace}
                  activityStatus={activityStatus}
                  isActive={isActive}
                  isPathExpanded={isPathExpanded}
                  isEntering={enteringTraceIds.has(trace.id)}
                  isOpening={openingTraceIds.has(trace.id)}
                  isStopping={stoppingTraceIds.has(trace.id)}
                  openError={openErrorByTraceId[trace.id] ?? ""}
                  stopError={stopErrorByTraceId[trace.id] ?? ""}
                  pulseSeq={pulseSeq}
                  nowMs={clockNowMs}
                  onSelect={setSelectedId}
                  onOpen={openTraceSession}
                  onTogglePath={toggleTracePathExpanded}
                  onStop={stopTraceSession}
                  rowRef={bindTraceRowRef(trace.id)}
                  fmtTime={fmtTime}
                />
              );
            })}
            {filteredTraces.length === 0 && <div className="empty">No sessions</div>}
          </div>
        </section>

        <section className="panel toc-panel">
          <div className="panel-head toc-head">
            <div className="toc-head-top">
              <h2>Timeline TOC</h2>
              <button
                type="button"
                className="sort-toggle mono"
                title="Toggle timeline sort direction"
                onClick={() =>
                  setTimelineSortDirection((prev) => (prev === "latest-first" ? "first-latest" : "latest-first"))
                }
              >
                {timelineSortDirection === "latest-first" ? "latest->first" : "first->latest"}
              </button>
            </div>
            <input
              className="search"
              placeholder="Filter by kind/text"
              value={tocQuery}
              onChange={(event) => setTocQuery(event.target.value)}
            />
          </div>
          <div
            className="toc-scroll"
            onScroll={(event: UIEvent<HTMLDivElement>) => maybeGrowTimelineRenderWindow(event.currentTarget)}
          >
            {renderedTocRows.map((row) => {
              const isActive = row.eventId === selectedEventId;
              return (
                <button
                  key={row.eventId}
                  className={`toc-row ${isActive ? "active" : ""} ${enteringEventIds.has(row.eventId) ? "toc-row-enter" : ""}`}
                  onClick={() => jumpToEvent(row.eventId)}
                  ref={bindTocRowRef(row.eventId)}
                >
                  <span className={`toc-dot kind-${kindClassSuffix(row.colorKey)}`} />
                  <span className="mono toc-index">{`#${row.index}`}</span>
                  <span className={classForKind(row.eventKind)}>{row.eventKind}</span>
                  {row.toolType && <span className="kind kind-tool-type">{row.toolType}</span>}
                  <span className="mono toc-timestamp">{fmtTimeAgo(row.timestampMs, clockNowMs)}</span>
                </button>
              );
            })}
            {renderedTocRows.length < tocRows.length && (
              <button type="button" className="load-more mono" onClick={growTimelineRenderWindow}>
                {`Load ${Math.min(TIMELINE_EVENT_RENDER_STEP, tocRows.length - renderedTocRows.length)} more`}
              </button>
            )}
            {tocRows.length === 0 && <div className="empty">No timeline rows</div>}
          </div>
        </section>

        <section className="panel detail-panel">
            <div className="panel-head detail-head">
              <div
                key={`detail-head-pulse-${selectedTraceSummary?.id ?? "none"}-${selectedTracePulseSeq}`}
                className={`detail-head-title-block ${selectedTracePulseSeq > 0 ? "pulse" : ""}`}
              >
                <h2>Trace Inspector</h2>
                <div className="detail-head-meta mono" title={selectedTraceLabel || undefined}>
                  {selectedTraceSummary ? `${selectedTraceLabel} · ${selectedTraceMeta}` : selectedTraceMeta}
                </div>
              </div>
              <div className="detail-controls">
                <label className="mono checkbox">
                  <input
                    type="checkbox"
                    checked={includeMeta}
                    onChange={(event) => setIncludeMeta(event.target.checked)}
                  />
                  include meta
                </label>
                <label className="mono checkbox">
                  <input type="checkbox" checked={autoFollow} onChange={(event) => setAutoFollow(event.target.checked)} />
                  auto follow
                </label>
              </div>
            </div>

            {page ? (
              <>
                <section className="detail-summary-cards" aria-label="trace inspector summary cards">
                  <article className="detail-summary-card">
                    <div className="detail-summary-head mono">
                      <div className="detail-summary-title">tokens</div>
                      <div className="detail-summary-value">
                        {formatCompactNumber(page.summary.tokenTotals?.totalTokens ?? null)}
                      </div>
                    </div>
                    <div className="detail-summary-sub mono">
                      {`in ${formatCompactNumber(page.summary.tokenTotals?.inputTokens ?? null)} · out ${formatCompactNumber(page.summary.tokenTotals?.outputTokens ?? null)}`}
                    </div>
                    <div className="detail-summary-sub mono">
                      {`cr ${formatCompactNumber(page.summary.tokenTotals?.cachedReadTokens ?? null)} · cc ${formatCompactNumber(page.summary.tokenTotals?.cachedCreateTokens ?? null)}`}
                    </div>
                    <div className="detail-summary-sub mono">
                      {`ctx ${formatPercent(page.summary.contextWindowPct ?? null)} · cost ${formatUsd(page.summary.costEstimateUsd ?? null)}`}
                    </div>
                  </article>
                  <article className="detail-summary-card">
                    <div className="detail-summary-head mono">
                      <div className="detail-summary-title">models</div>
                      <div className="detail-summary-value">{`${page.summary.modelTokenSharesTop?.length ?? 0} shown`}</div>
                    </div>
                    {(page.summary.modelTokenSharesTop ?? []).slice(0, 3).map((row) => (
                      <div key={`${row.model}-${row.tokens}`} className="detail-summary-sub mono" title={row.model}>
                        {`${row.model} ${formatPercent(row.percent, 1)}`}
                      </div>
                    ))}
                    {page.summary.modelTokenSharesEstimated && <div className="detail-summary-note mono">estimated</div>}
                  </article>
                  <article className="detail-summary-card">
                    <div className="detail-summary-head mono">
                      <div className="detail-summary-title">tool calls</div>
                      <div className="detail-summary-value">{formatCompactNumber(toolCallCountTotal)}</div>
                    </div>
                    {toolCallTypeCountRows.length > 0 ? (
                      toolCallTypeCountRows.map((row, rowIndex) => (
                        <div
                          key={`tool-count-row-${rowIndex}`}
                          className="detail-summary-sub mono"
                          title={row.map((entry) => entry.toolType).join(", ")}
                        >
                          {row.map((entry) => `${entry.toolType} ${formatCompactNumber(entry.count)}`).join(" · ")}
                        </div>
                      ))
                    ) : (
                      <div className="detail-summary-sub mono">types -</div>
                    )}
                    {hiddenToolCallTypeCount > 0 && (
                      <div className="detail-summary-note mono">{`+${hiddenToolCallTypeCount} more types`}</div>
                    )}
                  </article>
                </section>

                <div
                  className="events-scroll"
                  onScroll={(event: UIEvent<HTMLDivElement>) => maybeGrowTimelineRenderWindow(event.currentTarget)}
                >
                  {renderedTimelineEvents.map((event) => {
                    const agentBadges = buildAgentBadges(event);
                    return (
                      <article
                        key={event.eventId}
                        id={domIdForEvent(event.eventId)}
                        className={`${eventCardClass(event.eventKind)} ${selectedEventId === event.eventId ? "selected" : ""} ${enteringEventIds.has(event.eventId) ? "event-card-enter" : ""}`}
                        ref={bindEventCardRef(event.eventId)}
                      >
                        <button className="expand-btn mono" onClick={() => toggleExpanded(event.eventId)}>
                          {expandedEventIds.has(event.eventId) ? "collapse" : "expand"}
                        </button>
                        <div className="event-top mono">
                          <span>{`#${event.index}`}</span>
                          <span className={classForKind(event.eventKind)}>{event.eventKind}</span>
                          {event.toolType && <span className="kind kind-tool-type">{event.toolType}</span>}
                          <span>{fmtTime(event.timestampMs)}</span>
                        </div>
                        <h3>{event.preview}</h3>
                        {(event.toolName || event.functionName) && (
                          <div className="mono subtle">
                            {`tool ${event.toolName || event.functionName}${event.toolCallId ? ` (${event.toolCallId})` : ""}`}
                          </div>
                        )}
                        {agentBadges.length > 0 && (
                          <div className="event-agent-badges mono">
                            {agentBadges.map((badge) => (
                              <span key={`${event.eventId}-${badge}`} className="event-agent-badge">
                                {badge}
                              </span>
                            ))}
                          </div>
                        )}
                        {expandedEventIds.has(event.eventId) && (
                          <pre className="event-raw-json">{JSON.stringify(event.raw, null, 2)}</pre>
                        )}
                      </article>
                    );
                  })}
                  {renderedTimelineEvents.length < timelineEvents.length && (
                    <button type="button" className="load-more mono" onClick={growTimelineRenderWindow}>
                      {`Load ${Math.min(TIMELINE_EVENT_RENDER_STEP, timelineEvents.length - renderedTimelineEvents.length)} more`}
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="empty">Pick a session to inspect.</div>
            )}
        </section>
      </div>
    </main>
  );
}
