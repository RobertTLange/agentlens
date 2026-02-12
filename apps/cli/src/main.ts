#!/usr/bin/env node
import { Command } from "commander";
import type { AppConfig, TraceSummary } from "@agentlens/contracts";
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
  $ agentlens sessions list --limit 20
  $ agentlens session latest --show-tools
  $ agentlens sessions events latest --follow
`,
);

program
  .command("summary")
  .option("--json", "JSON output")
  .option("--agent <name>", "Filter by agent")
  .option("--since <window>", "Filter by recency window (e.g. 24h, 30m, 7d)")
  .action(async (opts: { json?: boolean; agent?: string; since?: string }) => {
    const configPath = program.opts<{ config: string }>().config;
    const snapshot = await loadSnapshot(configPath);
    const all = opts.agent
      ? snapshot.getSummaries().filter((summary) => summary.agent === opts.agent?.toLowerCase())
      : snapshot.getSummaries();
    const now = Date.now();
    const cutoff = opts.since ? now - toMsWindow(opts.since) : 0;

    const items = cutoff > 0 ? all.filter((summary) => (summary.lastEventTs ?? summary.mtimeMs) >= cutoff) : all;
    const topTools = new Map<string, number>();

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
      topTools: [] as Array<{ name: string; count: number }>,
    };

    for (const item of items) {
      const detail = snapshot.getSessionDetail(item.id);
      for (const event of detail.events) {
        if (event.eventKind !== "tool_use") continue;
        const key = event.toolName || event.functionName;
        if (!key) continue;
        topTools.set(key, (topTools.get(key) ?? 0) + 1);
      }
    }
    data.topTools = Array.from(topTools.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, count]) => ({ name, count }));

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    printTable([
      ["traces", "sessions", "events", "errors", "tool_uses", "tool_results"],
      [
        String(data.traces),
        String(data.sessions),
        String(data.events),
        String(data.errors),
        String(data.toolUses),
        String(data.toolResults),
      ],
    ]);
    console.log("\nby_agent:");
    printTable([
      ["agent", "count"],
      ...Object.entries(data.byAgent)
        .sort((a, b) => b[1] - a[1])
        .map(([agent, count]) => [agent, String(count)]),
    ]);

    console.log("\nby_event_kind:");
    printTable([
      ["kind", "count"],
      ...Object.entries(data.byEventKind)
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => [kind, String(count)]),
    ]);

    console.log("\ntop_tools:");
    printTable([
      ["tool", "calls"],
      ...data.topTools.map((row) => [row.name, String(row.count)]),
    ]);
  });

async function renderSessionsList(opts: { limit: string; agent?: string; json?: boolean }): Promise<void> {
  const configPath = program.opts<{ config: string }>().config;
  const all = await summaries(configPath, opts.agent);
  const limit = Math.max(1, Number(opts.limit) || 20);
  const rows = sortByRecent(all).slice(0, limit);

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  printTable([
    ["id", "agent", "updated", "events", "errors", "path"],
    ...rows.map((row) => [
      row.id,
      row.agent,
      fmtTime(row.lastEventTs ?? row.mtimeMs),
      String(row.eventCount),
      String(row.errorCount),
      row.path,
    ]),
  ]);
}

async function renderSessionDetail(
  id: string,
  opts: { events: string; includeMeta?: boolean; json?: boolean; showTools?: boolean },
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
  printTable([
    ["id", "session_id", "agent", "parser", "events", "errors", "path"],
    [
      summary.id,
      summary.sessionId || "-",
      summary.agent,
      summary.parser,
      String(summary.eventCount),
      String(summary.errorCount),
      summary.path,
    ],
  ]);

  console.log("\nlatest_events:");
  if (opts.showTools) {
    printTable([
      ["idx", "kind", "time", "tool", "call", "args/result", "preview"],
      ...page.events.map((event) => [
        String(event.index),
        event.eventKind,
        fmtTime(event.timestampMs),
        event.toolName || event.functionName || "-",
        event.toolCallId || "-",
        event.toolArgsText || event.toolResultText || "-",
        event.preview,
      ]),
    ]);
    return;
  }

  printTable([
    ["idx", "kind", "time", "preview"],
    ...page.events.map((event) => [String(event.index), event.eventKind, fmtTime(event.timestampMs), event.preview]),
  ]);
}

const sessions = program.command("sessions").description("Session-level operations");

sessions
  .command("list")
  .option("--limit <n>", "Rows to show", "20")
  .option("--agent <name>", "Filter by agent")
  .option("--json", "JSON output")
  .action(async (opts: { limit: string; agent?: string; json?: boolean }) => {
    await renderSessionsList(opts);
  });

program
  .command("session <id_or_latest>")
  .description("Show session-specific info by id/session_id/latest")
  .option("--events <n>", "Include latest N events", "20")
  .option("--include-meta", "Include meta events")
  .option("--show-tools", "Show tool/function details")
  .option("--json", "JSON output")
  .action(async (id: string, opts: { events: string; includeMeta?: boolean; json?: boolean; showTools?: boolean }) => {
    await renderSessionDetail(id, opts);
  });

sessions
  .command("show <id_or_latest>")
  .option("--events <n>", "Include latest N events", "20")
  .option("--include-meta", "Include meta events")
  .option("--show-tools", "Show tool/function details")
  .option("--json", "JSON output")
  .action(async (id: string, opts: { events: string; includeMeta?: boolean; json?: boolean; showTools?: boolean }) => {
    await renderSessionDetail(id, opts);
  });

sessions
  .command("events <id_or_latest>")
  .option("--limit <n>", "Number of events", "50")
  .option("--before <cursor>", "Pagination cursor")
  .option("--include-meta", "Include meta events")
  .option("--jsonl", "Emit one event JSON per line")
  .option("--follow", "Follow live updates")
  .action(
    async (
      id: string,
      opts: { limit: string; before?: string; includeMeta?: boolean; jsonl?: boolean; follow?: boolean },
    ) => {
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

        for (const event of initial.events) {
          if (opts.jsonl) {
            console.log(JSON.stringify(event));
          } else {
            console.log(`${event.index}\t${event.eventKind}\t${event.preview}`);
          }
        }

        index.on("stream", ({ envelope }: { envelope: { type: string; payload: Record<string, unknown> } }) => {
          if (envelope.type !== "events_appended") return;
          if (String(envelope.payload.id ?? "") !== resolved) return;

          const latestEvents = Array.isArray(envelope.payload.latestEvents)
            ? (envelope.payload.latestEvents as unknown[])
            : [];

          for (const event of latestEvents) {
            if (opts.jsonl) {
              console.log(JSON.stringify(event));
            } else if (event && typeof event === "object") {
              const typed = event as { index?: number; eventKind?: string; preview?: string };
              console.log(`${typed.index ?? "?"}\t${typed.eventKind ?? "?"}\t${typed.preview ?? ""}`);
            }
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
        printTable([
          ["idx", "kind", "time", "preview"],
          ...page.events.map((event) => [String(event.index), event.eventKind, fmtTime(event.timestampMs), event.preview]),
        ]);
        if (page.nextBefore) {
          console.log(`\nnext_before=${page.nextBefore}`);
        }
      }
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
