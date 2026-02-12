import { EventEmitter } from "node:events";
import type {
  AppConfig,
  EventKind,
  NormalizedEvent,
  OverviewStats,
  SessionActivityStatus,
  SessionDetail,
  StreamEnvelope,
  TracePage,
  TraceTocItem,
  TraceSummary,
} from "@agentlens/contracts";
import { discoverTraceFiles, type DiscoveredTraceFile } from "./discovery.js";
import { ParserRegistry } from "./parsers/index.js";
import { loadConfig } from "./config.js";
import { nowMs } from "./utils.js";

const EVENT_KIND_KEYS: EventKind[] = [
  "system",
  "assistant",
  "user",
  "tool_use",
  "tool_result",
  "reasoning",
  "meta",
];

const WAITING_INPUT_PATTERN =
  /\b(?:await(?:ing)?\s+(?:user|input)|waiting\s+for\s+(?:user|input|approval)|user\s+input\s+required|needs?\s+user\s+input|permission\s+required|approval\s+required|confirm(?:ation)?\s+(?:required|needed)|press\s+enter\s+to\s+continue)\b/i;

interface TraceEntry {
  file: DiscoveredTraceFile;
  detail: SessionDetail;
}

export interface TracePageOptions {
  limit?: number;
  before?: string;
  includeMeta?: boolean;
}

export interface TraceIndexEvent {
  envelope: StreamEnvelope;
}

interface ActivityStatus {
  status: SessionActivityStatus;
  reason: string;
}

function emptyEventKindCounts(): Record<EventKind, number> {
  return {
    system: 0,
    assistant: 0,
    user: 0,
    tool_use: 0,
    tool_result: 0,
    reasoning: 0,
    meta: 0,
  };
}

function deriveActivityStatus(events: NormalizedEvent[], unmatchedToolUses: number): ActivityStatus {
  const latestEvent = events[events.length - 1];
  if (latestEvent) {
    const latestText = [latestEvent.rawType, latestEvent.preview, ...latestEvent.textBlocks].join(" ");
    if (WAITING_INPUT_PATTERN.test(latestText)) {
      return { status: "waiting_input", reason: "explicit_wait_marker" };
    }
  }

  if (unmatchedToolUses > 0) {
    return { status: "running", reason: "pending_tool_use" };
  }

  return { status: "idle", reason: "no_active_signal" };
}

function summarize(
  file: DiscoveredTraceFile,
  agent: TraceSummary["agent"],
  parser: string,
  sessionId: string,
  events: NormalizedEvent[],
  parseError: string,
): TraceSummary {
  const eventKindCounts = emptyEventKindCounts();
  let errorCount = 0;
  let toolUseCount = 0;
  let toolResultCount = 0;
  let firstEventTs: number | null = null;
  let lastEventTs: number | null = null;

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const event of events) {
    eventKindCounts[event.eventKind] += 1;
    if (event.hasError) errorCount += 1;
    if (event.eventKind === "tool_use") {
      toolUseCount += 1;
      if (event.toolUseId) toolUseIds.add(event.toolUseId);
    }
    if (event.eventKind === "tool_result") {
      toolResultCount += 1;
      if (event.toolUseId) toolResultIds.add(event.toolUseId);
    }
    if (event.timestampMs !== null) {
      // Preserve file order semantics: start = first timestamped event in file, updated = last.
      firstEventTs ??= event.timestampMs;
      lastEventTs = event.timestampMs;
    }
  }

  let unmatchedToolUses = 0;
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) unmatchedToolUses += 1;
  }

  let unmatchedToolResults = 0;
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) unmatchedToolResults += 1;
  }

  const activityStatus = deriveActivityStatus(events, unmatchedToolUses);

  return {
    id: file.id,
    sourceProfile: file.sourceProfile,
    path: file.path,
    agent,
    parser,
    sessionId,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
    firstEventTs,
    lastEventTs,
    eventCount: events.length,
    parseable: parseError.length === 0,
    parseError,
    errorCount,
    toolUseCount,
    toolResultCount,
    unmatchedToolUses,
    unmatchedToolResults,
    activityStatus: activityStatus.status,
    activityReason: activityStatus.reason,
    eventKindCounts,
  };
}

function sortSummaries(items: TraceSummary[]): TraceSummary[] {
  return [...items].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
}

function buildToc(events: NormalizedEvent[]): TraceTocItem[] {
  return events.map((event) => ({
    eventId: event.eventId,
    index: event.index,
    timestampMs: event.timestampMs,
    eventKind: event.eventKind,
    label: event.tocLabel || event.preview,
    colorKey: event.eventKind,
  }));
}

export class TraceIndex extends EventEmitter {
  private readonly parserRegistry = new ParserRegistry();
  private config: AppConfig;
  private entries = new Map<string, TraceEntry>();
  private timer: NodeJS.Timeout | null = null;
  private streamVersion = 0;

  constructor(config: AppConfig) {
    super();
    this.config = config;
  }

  static async fromConfigPath(configPath?: string): Promise<TraceIndex> {
    const config = await loadConfig(configPath);
    return new TraceIndex(config);
  }

  getConfig(): AppConfig {
    return this.config;
  }

  setConfig(config: AppConfig): void {
    this.config = config;
  }

  async start(): Promise<void> {
    await this.refresh();
    const intervalMs = Math.max(500, Math.round(this.config.scan.intervalSeconds * 1000));
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    const files = await discoverTraceFiles(this.config);
    const nextIds = new Set(files.map((file) => file.id));

    for (const existingId of this.entries.keys()) {
      if (!nextIds.has(existingId)) {
        this.entries.delete(existingId);
        this.emitStream("trace_removed", { id: existingId });
      }
    }

    for (const file of files) {
      const current = this.entries.get(file.id);
      const changed = !current || current.file.mtimeMs !== file.mtimeMs || current.file.sizeBytes !== file.sizeBytes;
      if (!changed) continue;

      try {
        const parsed = await this.parserRegistry.parseFile(file);
        const summary = summarize(file, parsed.agent, parsed.parser, parsed.sessionId, parsed.events, parsed.parseError);
        const detail: SessionDetail = { summary, events: parsed.events };

        const previousCount = current?.detail.events.length ?? 0;
        this.entries.set(file.id, { file, detail });
        const eventType = current ? "trace_updated" : "trace_added";
        this.emitStream(eventType, { summary });

        const appended = Math.max(0, parsed.events.length - previousCount);
        if (appended > 0) {
          this.emitStream("events_appended", {
            id: file.id,
            appended,
            latestEvents: parsed.events.slice(-Math.min(40, appended)),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const summary = summarize(file, file.agentHint, "unknown", "", [], message);
        this.entries.set(file.id, { file, detail: { summary, events: [] } });
        this.emitStream(current ? "trace_updated" : "trace_added", { summary });
      }
    }

    this.emitStream("overview_updated", { overview: this.getOverview() });
  }

  private emitStream(type: StreamEnvelope["type"], payload: Record<string, unknown>): void {
    this.streamVersion += 1;
    const envelope: StreamEnvelope = {
      id: String(this.streamVersion),
      type,
      version: this.streamVersion,
      payload,
    };
    this.emit("stream", { envelope } as TraceIndexEvent);
  }

  getSummaries(): TraceSummary[] {
    return sortSummaries(Array.from(this.entries.values(), (entry) => entry.detail.summary));
  }

  getOverview(): OverviewStats {
    const byAgent: Record<string, number> = {};
    const byEventKind = emptyEventKindCounts();

    let traceCount = 0;
    let sessionCount = 0;
    let eventCount = 0;
    let errorCount = 0;
    let toolUseCount = 0;
    let toolResultCount = 0;

    for (const summary of this.getSummaries()) {
      traceCount += 1;
      if (summary.sessionId) sessionCount += 1;
      eventCount += summary.eventCount;
      errorCount += summary.errorCount;
      toolUseCount += summary.toolUseCount;
      toolResultCount += summary.toolResultCount;
      byAgent[summary.agent] = (byAgent[summary.agent] ?? 0) + 1;
      for (const key of EVENT_KIND_KEYS) {
        byEventKind[key] += summary.eventKindCounts[key] ?? 0;
      }
    }

    return {
      traceCount,
      sessionCount,
      eventCount,
      errorCount,
      toolUseCount,
      toolResultCount,
      byAgent,
      byEventKind,
      updatedAtMs: nowMs(),
    };
  }

  getSessionDetail(id: string): SessionDetail {
    const found = this.entries.get(id);
    if (!found) {
      throw new Error(`unknown trace id: ${id}`);
    }
    return found.detail;
  }

  getTracePage(id: string, options: TracePageOptions = {}): TracePage {
    const detail = this.getSessionDetail(id);
    const includeMeta = options.includeMeta ?? this.config.scan.includeMetaDefault;
    const filtered = includeMeta ? detail.events : detail.events.filter((event) => event.eventKind !== "meta");

    const limit = Math.max(1, Math.min(5000, options.limit ?? this.config.scan.recentEventWindow));
    const end = options.before ? Math.max(0, Math.min(filtered.length, Number(options.before))) : filtered.length;
    const start = Math.max(0, end - limit);
    const pageEvents = filtered.slice(start, end);

    return {
      summary: detail.summary,
      events: pageEvents,
      toc: buildToc(pageEvents),
      nextBefore: start > 0 ? String(start) : "",
      liveCursor: String(filtered.length),
    };
  }

  resolveId(candidate: string): string {
    if (this.entries.has(candidate)) {
      return candidate;
    }
    const bySession = this.getSummaries().find((summary) => summary.sessionId === candidate);
    if (bySession) {
      return bySession.id;
    }
    throw new Error(`unknown trace/session: ${candidate}`);
  }
}
