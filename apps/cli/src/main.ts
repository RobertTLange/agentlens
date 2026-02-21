#!/usr/bin/env node
import { Command } from "commander";
import type { AppConfig, NamedCount, TraceSummary } from "@agentlens/contracts";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  loadSnapshot,
  mergeConfig,
  saveConfig,
  toMsWindow,
  TraceIndex,
} from "@agentlens/core";
import { launchBrowser } from "./browser.js";

const LATEST_KEYWORD = "latest";
const DEFAULT_HISTORY_LIMIT = 50;
const STATUS_ORDER: TraceSummary["activityStatus"][] = ["running", "waiting_input", "idle"];

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;
  const header = rows[0];
  if (!header) return;
  const widths = header.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length)));
  for (const [idx, row] of rows.entries()) {
    const line = row
      .map((cell, col) => (cell ?? "").padEnd(widths[col] ?? 0))
      .join(idx === 0 ? " | " : "   ");
    console.log(line);
    if (idx === 0) {
      console.log(widths.map((width) => "-".repeat(width)).join("-+-"));
    }
  }
}

function fmtTime(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toISOString();
}

function fmtTimeCompact(ms: number | null): string {
  if (!ms) return "-";
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function fmtAgeShort(ms: number | null): string {
  if (!ms) return "-";
  const deltaSeconds = Math.floor(Math.max(0, Date.now() - ms) / 1000);
  if (deltaSeconds < 10) return "now";
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h`;
  return `${Math.floor(deltaSeconds / 86400)}d`;
}

function pathTail(inputPath: string): string {
  const trimmed = inputPath.replace(/[\\/]+$/g, "");
  if (!trimmed) return inputPath;
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fmtPct(count: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((count / total) * 100).toFixed(1)}%`;
}

function printNamedTable(section: string, rows: string[][], opts: { llm?: boolean } = {}): void {
  if (rows.length === 0) return;
  if (opts.llm) {
    console.log(`\n## ${section}`);
  } else {
    console.log(`\n${section}:`);
  }
  printTable(rows);
}

function parseValue(input: string): unknown {
  if (input === "true") return true;
  if (input === "false") return false;
  const numeric = Number(input);
  if (!Number.isNaN(numeric) && input.trim() !== "") return numeric;
  return input;
}

function setPath(target: Record<string, unknown>, dottedKey: string, value: unknown): void {
  const parts = dottedKey.split(".").filter(Boolean);
  if (parts.length === 0) return;

  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!key) continue;
    const next = cursor[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1];
  if (!lastKey) return;
  cursor[lastKey] = value;
}

async function summaries(configPath: string, agent?: string): Promise<TraceSummary[]> {
  const snapshot = await loadSnapshot(configPath);
  const list = snapshot.getSummaries();
  if (!agent) return list;
  return list.filter((summary) => summary.agent === agent.toLowerCase());
}

function sortByRecent(items: TraceSummary[]): TraceSummary[] {
  return [...items].sort(
    (a, b) =>
      (b.lastEventTs ?? b.mtimeMs) - (a.lastEventTs ?? a.mtimeMs) ||
      a.path.localeCompare(b.path) ||
      a.id.localeCompare(b.id),
  );
}

function aggregateTopTools(items: TraceSummary[], limit: number): NamedCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const row of item.topTools ?? []) {
      counts.set(row.name, (counts.get(row.name) ?? 0) + row.count);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(1, limit))
    .map(([name, count]) => ({ name, count }));
}

function buildStatusCounts(items: TraceSummary[]): Record<TraceSummary["activityStatus"], number> {
  const counts: Record<TraceSummary["activityStatus"], number> = {
    running: 0,
    waiting_input: 0,
    idle: 0,
  };
  for (const item of items) {
    counts[item.activityStatus] += 1;
  }
  return counts;
}

function assertValidGroupBy(groupBy: string | undefined): void {
  if (!groupBy) return;
  if (groupBy === "recency") return;
  throw new Error(`unsupported group-by mode: ${groupBy}`);
}

function bucketByRecency(items: TraceSummary[]): Record<"today" | "last_7d" | "older", TraceSummary[]> {
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  const sevenDayMs = 7 * oneDayMs;
  const buckets: Record<"today" | "last_7d" | "older", TraceSummary[]> = {
    today: [],
    last_7d: [],
    older: [],
  };
  for (const item of items) {
    const updatedMs = item.lastEventTs ?? item.mtimeMs;
    const ageMs = Math.max(0, now - updatedMs);
    if (ageMs < oneDayMs) buckets.today.push(item);
    else if (ageMs < sevenDayMs) buckets.last_7d.push(item);
    else buckets.older.push(item);
  }
  return buckets;
}

interface SessionHistoryRow {
  rank: number;
  sessionId: string;
  traceId: string;
  agent: string;
  updatedAge: string;
  updatedAt: string;
  events: string;
  errors: string;
  tools: string;
  status: string;
  pathTail: string;
}

function toSessionHistoryRows(items: TraceSummary[], startRank = 1): SessionHistoryRow[] {
  return items.map((item, index) => {
    const updatedMs = item.lastEventTs ?? item.mtimeMs;
    return {
      rank: startRank + index,
      sessionId: item.sessionId || "-",
      traceId: item.id,
      agent: item.agent,
      updatedAge: fmtAgeShort(updatedMs),
      updatedAt: fmtTimeCompact(updatedMs),
      events: String(item.eventCount),
      errors: String(item.errorCount),
      tools: String(item.toolUseCount),
      status: item.activityStatus,
      pathTail: pathTail(item.path),
    };
  });
}

function isLatestToken(input: string): boolean {
  return input.trim().toLowerCase() === LATEST_KEYWORD;
}

function resolveLatestTraceId(items: TraceSummary[]): string {
  const latest = sortByRecent(items)[0];
  if (!latest) {
    throw new Error('no sessions found (cannot resolve "latest")');
  }
  return latest.id;
}

function resolveTraceIdOrLatest(
  source: {
    getSummaries(): TraceSummary[];
    resolveId(candidate: string): string;
  },
  candidate: string,
): string {
  if (isLatestToken(candidate)) {
    return resolveLatestTraceId(source.getSummaries());
  }
  return source.resolveId(candidate);
}

const program = new Command();
program.name("agentlens").description("Inspect local agent interaction traces");
program.option("--config <path>", "Config path", DEFAULT_CONFIG_PATH);
program.option("--browser", "Launch AgentLens in the background and open the web app");
program.option("--host <host>", "Server host", process.env.AGENTLENS_HOST ?? "127.0.0.1");
program.option("--port <port>", "Server port", process.env.AGENTLENS_PORT ?? "8787");
program.addHelpText(
  "after",
  `
Examples:
  $ agentlens --browser
  $ agentlens summary --json
  $ agentlens summary --llm
  $ agentlens sessions list --limit 50
  $ agentlens session latest --show-tools
  $ agentlens session latest --llm
  $ agentlens sessions events latest --follow
`,
);

program
  .command("summary")
  .option("--json", "JSON output")
  .option("--llm", "Deterministic table output for LLM agents")
  .option("--agent <name>", "Filter by agent")
  .option("--since <window>", "Filter by recency window (e.g. 24h, 30m, 7d)")
  .action(async (opts: { json?: boolean; llm?: boolean; agent?: string; since?: string }) => {
    const configPath = program.opts<{ config: string }>().config;
    const snapshot = await loadSnapshot(configPath);
    const all = opts.agent
      ? snapshot.getSummaries().filter((summary) => summary.agent === opts.agent?.toLowerCase())
      : snapshot.getSummaries();
    const now = Date.now();
    const cutoff = opts.since ? now - toMsWindow(opts.since) : 0;

    const items = cutoff > 0 ? all.filter((summary) => (summary.lastEventTs ?? summary.mtimeMs) >= cutoff) : all;
    const data = {
      traces: items.length,
      sessions: items.filter((item) => Boolean(item.sessionId)).length,
      events: items.reduce((acc, item) => acc + item.eventCount, 0),
      errors: items.reduce((acc, item) => acc + item.errorCount, 0),
      toolUses: items.reduce((acc, item) => acc + item.toolUseCount, 0),
      toolResults: items.reduce((acc, item) => acc + item.toolResultCount, 0),
      byAgent: items.reduce<Record<string, number>>((acc, item) => {
        acc[item.agent] = (acc[item.agent] ?? 0) + 1;
        return acc;
      }, {}),
      byEventKind: items.reduce<Record<string, number>>((acc, item) => {
        for (const [kind, count] of Object.entries(item.eventKindCounts)) {
          acc[kind] = (acc[kind] ?? 0) + count;
        }
        return acc;
      }, {}),
      byStatus: buildStatusCounts(items),
      topTools: aggregateTopTools(items, 12),
    };

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const llmMode = opts.llm === true;
    printNamedTable(
      "overview",
      [
        ["traces", "sessions", "events", "errors", "tool_uses", "tool_results"],
        [
          String(data.traces),
          String(data.sessions),
          String(data.events),
          String(data.errors),
          String(data.toolUses),
          String(data.toolResults),
        ],
      ],
      { llm: llmMode },
    );

    printNamedTable(
      "by_agent",
      [
        ["agent", "count", "pct"],
        ...Object.entries(data.byAgent)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([agent, count]) => [agent, String(count), fmtPct(count, data.traces)]),
      ],
      { llm: llmMode },
    );

    printNamedTable(
      "by_status",
      [
        ["status", "count", "pct"],
        ...STATUS_ORDER.map((status) => [status, String(data.byStatus[status]), fmtPct(data.byStatus[status], data.traces)]),
      ],
      { llm: llmMode },
    );

    printNamedTable(
      "top_tools",
      [["tool", "calls"], ...data.topTools.map((row) => [row.name, String(row.count)])],
      { llm: llmMode },
    );

    if (llmMode) {
      const candidateRows = toSessionHistoryRows(sortByRecent(items).slice(0, 20));
      printNamedTable(
        "candidate_sessions",
        [
          ["rank", "session_id", "trace_id", "agent", "updated_age", "updated_at", "events", "errors", "status", "path_tail"],
          ...candidateRows.map((row) => [
            String(row.rank),
            row.sessionId,
            row.traceId,
            row.agent,
            row.updatedAge,
            row.updatedAt,
            row.events,
            row.errors,
            row.status,
            row.pathTail,
          ]),
        ],
        { llm: true },
      );
    }
  });

async function renderSessionsList(opts: {
  limit: string;
  agent?: string;
  json?: boolean;
  llm?: boolean;
  groupBy?: string;
}): Promise<void> {
  const configPath = program.opts<{ config: string }>().config;
  const all = await summaries(configPath, opts.agent);
  assertValidGroupBy(opts.groupBy);
  const limit = Math.max(1, Number(opts.limit) || DEFAULT_HISTORY_LIMIT);
  const rows = sortByRecent(all).slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const llmMode = opts.llm === true;
  const renderRows = (sectionName: string, source: TraceSummary[], rankStart: number): number => {
    if (source.length === 0) return rankStart;
    const rowViews = toSessionHistoryRows(source, rankStart);
    printNamedTable(
      sectionName,
      [
        ["rank", "session", "trace_id", "agent", "updated_age", "updated_at", "events", "errors", "tools", "status", "path_tail"],
        ...rowViews.map((row) => [
          String(row.rank),
          row.sessionId,
          row.traceId,
          row.agent,
          row.updatedAge,
          row.updatedAt,
          row.events,
          row.errors,
          row.tools,
          row.status,
          row.pathTail,
        ]),
      ],
      { llm: llmMode },
    );
    return rankStart + source.length;
  };

  if (opts.groupBy === "recency") {
    const buckets = bucketByRecency(rows);
    let rank = 1;
    rank = renderRows("today", buckets.today, rank);
    rank = renderRows("last_7d", buckets.last_7d, rank);
    renderRows("older", buckets.older, rank);
    return;
  }

  renderRows("sessions", rows, 1);
}

async function renderSessionDetail(
  id: string,
  opts: { events: string; includeMeta?: boolean; json?: boolean; llm?: boolean; showTools?: boolean },
): Promise<void> {
  const configPath = program.opts<{ config: string }>().config;
  const snapshot = await loadSnapshot(configPath);
  const resolved = resolveTraceIdOrLatest(snapshot, id);
  const pageOptions: { limit: number; includeMeta?: boolean } = {
    limit: Math.max(1, Number(opts.events) || 20),
  };
  if (opts.includeMeta !== undefined) {
    pageOptions.includeMeta = opts.includeMeta;
  }
  const page = snapshot.getTracePage(resolved, pageOptions);

  if (opts.json) {
    console.log(JSON.stringify(page, null, 2));
    return;
  }

  const summary = page.summary;
  const updatedMs = summary.lastEventTs ?? summary.mtimeMs;
  if (opts.llm) {
    printNamedTable(
      "session_summary",
      [
        [
          "trace_id",
          "session_id",
          "agent",
          "parser",
          "updated_age",
          "updated_at",
          "events",
          "errors",
          "tool_uses",
          "tool_results",
          "status",
          "path",
        ],
        [
          summary.id,
          summary.sessionId || "-",
          summary.agent,
          summary.parser,
          fmtAgeShort(updatedMs),
          fmtTimeCompact(updatedMs),
          String(summary.eventCount),
          String(summary.errorCount),
          String(summary.toolUseCount),
          String(summary.toolResultCount),
          summary.activityStatus,
          summary.path,
        ],
      ],
      { llm: true },
    );
    printNamedTable(
      "next_calls",
      [
        ["call", "purpose"],
        [`agentlens sessions events ${summary.id} --llm --limit 100`, "chronological event inspection"],
      ],
      { llm: true },
    );
    return;
  }

  printNamedTable(
    "session",
    [
      ["trace_id", "session_id", "agent", "parser", "updated_age", "updated_at", "events", "errors", "status", "path"],
      [
        summary.id,
        summary.sessionId || "-",
        summary.agent,
        summary.parser,
        fmtAgeShort(updatedMs),
        fmtTimeCompact(updatedMs),
        String(summary.eventCount),
        String(summary.errorCount),
        summary.activityStatus,
        summary.path,
      ],
    ],
  );

  if (opts.showTools) {
    printNamedTable("latest_events", [
      ["idx", "kind", "time", "tool", "call", "args_result", "preview"],
      ...page.events.map((event) => [
        String(event.index),
        event.eventKind,
        fmtTime(event.timestampMs),
        event.toolName || event.functionName || "-",
        event.toolCallId || "-",
        normalizeInlineText(event.toolArgsText || event.toolResultText || "-"),
        normalizeInlineText(event.preview),
      ]),
    ]);
    return;
  }

  printNamedTable("latest_events", [
    ["idx", "kind", "time", "preview"],
    ...page.events.map((event) => [String(event.index), event.eventKind, fmtTime(event.timestampMs), normalizeInlineText(event.preview)]),
  ]);
}

function renderEventsTable(
  events: Array<{
    index: number;
    eventKind: string;
    timestampMs: number | null;
    preview: string;
    toolName?: string;
    functionName?: string;
    toolCallId?: string;
  }>,
  opts: { llm?: boolean },
): void {
  if (opts.llm) {
    printNamedTable(
      "events",
      [
        ["idx", "kind", "time", "tool", "call_id", "preview"],
        ...events.map((event) => [
          String(event.index),
          event.eventKind,
          fmtTimeCompact(event.timestampMs),
          event.toolName || event.functionName || "-",
          event.toolCallId || "-",
          normalizeInlineText(event.preview),
        ]),
      ],
      { llm: true },
    );
    return;
  }
  printTable([
    ["idx", "kind", "time", "preview"],
    ...events.map((event) => [String(event.index), event.eventKind, fmtTime(event.timestampMs), normalizeInlineText(event.preview)]),
  ]);
}

async function renderSessionEvents(
  id: string,
  opts: { limit: string; before?: string; includeMeta?: boolean; jsonl?: boolean; llm?: boolean; follow?: boolean },
): Promise<void> {
  const configPath = program.opts<{ config: string }>().config;

  if (opts.follow) {
    const index = await TraceIndex.fromConfigPath(configPath);
    await index.start();
    const resolved = resolveTraceIdOrLatest(index, id);

    const initialOptions: { limit: number; includeMeta?: boolean } = {
      limit: Math.max(1, Number(opts.limit) || 50),
    };
    if (opts.includeMeta !== undefined) {
      initialOptions.includeMeta = opts.includeMeta;
    }
    const initial = index.getTracePage(resolved, initialOptions);

    if (opts.jsonl) {
      for (const event of initial.events) console.log(JSON.stringify(event));
    } else {
      renderEventsTable(initial.events, opts.llm ? { llm: true } : {});
    }

    index.on("stream", ({ envelope }: { envelope: { type: string; payload: Record<string, unknown> } }) => {
      if (envelope.type !== "events_appended") return;
      if (String(envelope.payload.id ?? "") !== resolved) return;
      const latestEvents = Array.isArray(envelope.payload.latestEvents) ? (envelope.payload.latestEvents as unknown[]) : [];
      const typedEvents = latestEvents.filter((event): event is (typeof initial.events)[number] =>
        Boolean(event && typeof event === "object"),
      );
      if (opts.jsonl) {
        for (const event of typedEvents) console.log(JSON.stringify(event));
      } else {
        renderEventsTable(typedEvents, opts.llm ? { llm: true } : {});
      }
    });
    return;
  }

  const snapshot = await loadSnapshot(configPath);
  const resolved = resolveTraceIdOrLatest(snapshot, id);
  const pageOptions: { limit?: number; before?: string; includeMeta?: boolean } = {};
  if (opts.includeMeta !== undefined) {
    pageOptions.includeMeta = opts.includeMeta;
  }
  pageOptions.limit = Math.max(1, Number(opts.limit) || 50);
  if (opts.before) {
    pageOptions.before = opts.before;
  }
  const page = snapshot.getTracePage(resolved, pageOptions);

  if (opts.jsonl) {
    for (const event of page.events) {
      console.log(JSON.stringify(event));
    }
  } else {
    renderEventsTable(page.events, opts.llm ? { llm: true } : {});
    if (page.nextBefore) {
      console.log(`\nnext_before=${page.nextBefore}`);
    }
  }
}

const sessions = program.command("sessions").description("Session-level operations");

sessions
  .command("list")
  .option("--limit <n>", "Rows to show", String(DEFAULT_HISTORY_LIMIT))
  .option("--agent <name>", "Filter by agent")
  .option("--group-by <mode>", "Group output (supported: recency)")
  .option("--json", "JSON output")
  .option("--llm", "Deterministic table output for LLM agents")
  .action(async (opts: { limit: string; agent?: string; groupBy?: string; json?: boolean; llm?: boolean }) => {
    await renderSessionsList(opts);
  });

program
  .command("session <id_or_latest>")
  .description("Show session-specific info by id/session_id/latest")
  .option("--events <n>", "Include latest N events", "20")
  .option("--include-meta", "Include meta events")
  .option("--show-tools", "Show tool/function details")
  .option("--json", "JSON output")
  .option("--llm", "Deterministic table output for LLM agents")
  .action(
    async (id: string, opts: { events: string; includeMeta?: boolean; json?: boolean; llm?: boolean; showTools?: boolean }) => {
    await renderSessionDetail(id, opts);
    },
  );

sessions
  .command("show <id_or_latest>")
  .option("--events <n>", "Include latest N events", "20")
  .option("--include-meta", "Include meta events")
  .option("--show-tools", "Show tool/function details")
  .option("--json", "JSON output")
  .option("--llm", "Deterministic table output for LLM agents")
  .action(
    async (id: string, opts: { events: string; includeMeta?: boolean; json?: boolean; llm?: boolean; showTools?: boolean }) => {
    await renderSessionDetail(id, opts);
    },
  );

sessions
  .command("events <id_or_latest>")
  .option("--limit <n>", "Number of events", "50")
  .option("--before <cursor>", "Pagination cursor")
  .option("--include-meta", "Include meta events")
  .option("--jsonl", "Emit one event JSON per line")
  .option("--llm", "Deterministic table output for LLM agents")
  .option("--follow", "Follow live updates")
  .action(
    async (
      id: string,
      opts: { limit: string; before?: string; includeMeta?: boolean; jsonl?: boolean; llm?: boolean; follow?: boolean },
    ) => {
      await renderSessionEvents(id, opts);
    },
  );

const configCmd = program.command("config").description("Configuration");

configCmd.command("get").option("--json", "JSON output").action(async (opts: { json?: boolean }) => {
  const configPath = program.opts<{ config: string }>().config;
  const config = await loadConfig(configPath);
  if (opts.json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  console.log(JSON.stringify(config, null, 2));
});

configCmd.command("set <key> <value>").action(async (key: string, value: string) => {
  const configPath = program.opts<{ config: string }>().config;
  const config = await loadConfig(configPath);
  const mutable = structuredClone(config) as unknown as Record<string, unknown>;
  setPath(mutable, key, parseValue(value));
  const merged = mergeConfig(mutable as Partial<AppConfig>);
  await saveConfig(merged, configPath);
  console.log(`updated ${key}`);
});

program.action(async () => {
  const opts = program.opts<{ browser?: boolean; config: string; host: string; port: string }>();
  if (!opts.browser) {
    program.outputHelp();
    return;
  }

  const launched = await launchBrowser({
    host: opts.host,
    port: opts.port,
    configPath: opts.config,
  });

  if (launched.status === "reused") {
    console.log(`AgentLens already running: ${launched.url}`);
  } else {
    console.log(`AgentLens started in background: ${launched.url}`);
  }
  if (launched.pid) {
    console.log(`PID: ${launched.pid}`);
  }
  if (launched.pidPath) {
    console.log(`PID file: ${launched.pidPath}`);
  }
  if (launched.logPath) {
    console.log(`Log file: ${launched.logPath}`);
  }
  if (!launched.openedBrowser) {
    console.log("Browser open skipped (AGENTLENS_SKIP_OPEN=1).");
  }
});

void program.parseAsync(process.argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
