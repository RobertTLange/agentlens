<p align="center">
  <img src="apps/web/public/favicon.png" alt="AgentLens logo" width="180" />
</p>

<h1 align="center">AgentLens</h1>

<p align="center">
  <strong>Local observability for Codex, Claude, Cursor, Gemini, and OpenCode sessions.</strong><br />
  Inspect Codex, Claude, Cursor, Gemini, and OpenCode traces in a live web UI, CLI, and HTTP API.
</p>

<p align="center">
  <img alt="Node.js 18+" src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white" />
  <img alt="Runtime" src="https://img.shields.io/badge/Runtime-Local--first-111827" />
</p>

![AgentLens web UI](docs/demo-2026-02-15-141523.png)

## Overview

AgentLens watches local session logs, normalizes events into a shared schema, and serves live inspection tools for debugging multi-agent workflows.

It is designed for local analysis: no hosted backend required.

## Key Capabilities

- Unified ingestion for Codex, Claude, Cursor, Gemini, and OpenCode logs.
- Cursor agent-transcript ingestion from `~/.cursor/projects/**/agent-transcripts/*.txt`.
- Gemini chat ingestion from `~/.gemini/tmp/**/chats/session-*.json` and `~/.gemini/tmp/**/*.jsonl`.
- OpenCode integration for `storage/session`, `storage/session_diff`, and `opencode.db` fallback data.
- Normalized event model across agents (`user`, `assistant`, `reasoning`, `tool_use`, `tool_result`, `meta`, `system`).
- Real-time stream updates for newly discovered traces and appended events.
- Deep tool-call visibility with argument/result text and unmatched tool I/O detection.
- Stop active Codex/Claude/Cursor/Gemini/OpenCode session processes from the web UI session row control.
- Triage metrics out of the box: traces, sessions, events, errors, event-kind distribution, and top tools.
- Three interfaces over one core index: browser UI, CLI, and HTTP API.

Default log + ingestion paths:

| Agent | Default session log root (`sessionLogDirectories`) | Default AgentLens source(s) | Default ingestion path(s) |
| --- | --- | --- | --- |
| Codex | `~/.codex` | `sources.codex_home` (enabled) | `~/.codex/sessions/**/*.jsonl` |
| Claude | `~/.claude` | `sources.claude_projects` (enabled), `sources.claude_history` (disabled) | `~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl` |
| Cursor | `~/.cursor` | `sources.cursor_agent_transcripts` (disabled) | `~/.cursor/projects/**/agent-transcripts/*.txt` |
| Gemini | `~/.gemini` | `sources.gemini_tmp` (disabled) | `~/.gemini/tmp/**/chats/session-*.json`, `~/.gemini/tmp/**/*.jsonl` |
| OpenCode | `~/.local/share/opencode` | `sources.opencode_storage_session` (disabled) + OpenCode discovery fallbacks | `~/.local/share/opencode/storage/session/**/*.json`, `~/.local/share/opencode/storage/session_diff/**/*.json`, `~/.local/share/opencode/storage/opencode.db` |

## Activity Status Semantics

- Session `activityStatus` is computed in `@agentlens/core` and passed through unchanged to CLI/API/web.
- `waiting_input` is detected from structured markers first (status/type/phase-style fields), with text-pattern fallback.
- `running` is detected from unmatched `tool_use` events or very recent trace activity.
- `running` and `waiting_input` auto-degrade to `idle` after freshness TTL expiration.
- Successful stop actions in the web UI immediately set that trace status to `idle` (`activityReason: manually_stopped`) while live updates continue.
- Session sparkline `activityBins` now represent full session-lifetime activity shape (first timestamped event -> latest timestamped event), not just a trailing recent window.
- `activityBinsMode` indicates how bins were derived: `time` (timestamp span) or `event_index` (fallback when timestamp span is unavailable).

TTL settings live in config under `scan`:

```toml
[scan]
mode = "adaptive" # or "fixed"
intervalMinMs = 200
intervalMaxMs = 3000
fullRescanIntervalMs = 900000
batchDebounceMs = 120
statusRunningTtlMs = 300000
statusWaitingTtlMs = 900000
```

Retention controls are under `retention`:

```toml
[retention]
strategy = "aggressive_recency" # or "full_memory"
hotTraceCount = 60
warmTraceCount = 240
maxResidentEventsPerHotTrace = 1200
maxResidentEventsPerWarmTrace = 120
detailLoadMode = "lazy_from_disk"
```

## Architecture

```text
Local agent logs (~/.codex, ~/.claude, ~/.cursor, ~/.gemini, ~/.local/share/opencode)
  -> @agentlens/core (discovery + parsing + indexing)
  -> @agentlens/server (Fastify API + SSE + static web hosting)
  -> apps/web (React UI) and apps/cli (terminal workflows)
```

## Quick Start

### Prerequisites

- Node.js 18+.
- npm (workspace-aware install/build/test flow).

### Option A: Run from source (no global install)

```bash
npm install
npm run build
node apps/cli/dist/main.js --browser
```

### Option B: Link `agentlens` globally from this repo

```bash
npm install
./build.sh
```

`build.sh` will:

- remove a conflicting global `agentlens` package (if installed),
- stop any existing AgentLens background server,
- build the full workspace (contracts/core/web/server/cli),
- `npm link` the local CLI,
- start `agentlens --browser`,
- open with a cache-busting URL (`/?reload=<timestamp>`).

Optional args are forwarded:

```bash
./build.sh --host 127.0.0.1 --port 8787
```

Note: `npm install -g agentlens` currently resolves to an unrelated registry package.

## CLI Reference

Common commands:

```bash
agentlens --browser
agentlens summary
agentlens summary --json --since 24h
agentlens sessions list --limit 20
agentlens session latest --show-tools
agentlens session <trace_id_or_session_id> --show-tools
agentlens sessions events latest --follow --jsonl
agentlens config get
agentlens config set scan.intervalSeconds 1.5
```

Useful patterns:

- Use `latest` for the most recently updated trace/session.
- Use `sessions events ... --follow` for live terminal streaming.
- Use JSON/JSONL flags (`--json`, `--jsonl`) for scripting pipelines.

## HTTP API

| Endpoint | Description |
| --- | --- |
| `GET /api/healthz` | Health check. |
| `GET /api/overview` | Aggregate counters and distributions. |
| `GET /api/perf` | Index refresh timings, watcher stats, and retention/materialization counters. |
| `GET /api/traces?agent=<name>` | List indexed trace summaries, optionally filtered by agent. |
| `GET /api/trace/:id` | Paginated trace detail by trace id or session id. Supports `limit`, `before`, `include_meta`. |
| `POST /api/trace/:id/stop` | Stop session process for trace/session id. Sends `SIGINT`, escalates to `SIGTERM`, and optionally `SIGKILL` with `?force=true`. |
| `POST /api/trace/:id/open` | Open/focus the terminal target for trace/session id. Attempts exact tmux pane focus first, then Ghostty app activation fallback. |
| `GET /api/config` | Current merged runtime config. |
| `POST /api/config` | Update config, persist to disk, refresh index. |
| `GET /api/stream` | SSE feed (`snapshot`, `trace_*`, `events_appended`, `overview_updated`, `heartbeat`). |

Stopping sessions from UI/API:

- In the web UI, click the stop icon button on a session row.
- API equivalent:

```bash
curl -X POST "http://127.0.0.1:8787/api/trace/<trace_or_session_id>/stop"
```

- Success response includes termination signal and matched process ids.
- Typical non-running response is HTTP `409` with `status: "not_running"`.

Opening sessions from UI/API:

- In the web UI, click the open icon button on a session row.
- API equivalent:

```bash
curl -X POST "http://127.0.0.1:8787/api/trace/<trace_or_session_id>/open"
```

- Open flow (`POST /open`):
  - Resolve the active process for the trace/session id.
  - Read that process TTY and look for a matching tmux pane (across detected tmux sockets).
  - If a pane is found:
    - Choose a tmux client (prefer focused client flags, then recent activity heuristics).
    - Switch client(s) to the pane's tmux session/window/pane target.
    - Activate Ghostty so the terminal app is brought to front.
    - Return `status: "focused_pane"` with `target`, `pid`, and `tty`.
  - If pane/process targeting is not possible:
    - Fall back to Ghostty activation only.
    - Return `status: "ghostty_activated"` with diagnostic `message`.

- UI behavior:
  - The top header status shows the open debug/result message briefly, then fades back to the base live status line.

## Configuration

Default config path:

```text
~/.agentlens/config.toml
```

Use the repo example config as a starting point:

```bash
cp example.config.toml ~/.agentlens/config.toml
```

The example includes `sessionLogDirectories`, `[sources.*]`, `[scan]`, `[traceInspector]`, `[redaction]`, `[cost]`, and `[models]`.

## Development

Run services in watch mode:

```bash
npm run dev:server
npm run dev:web
```

Open `http://127.0.0.1:5173` for frontend development (the Vite dev server proxies `/api` to `http://127.0.0.1:8787`).

Before review/merge, run full checks:

```bash
npm run build
npm run typecheck
npm test
```

## Monorepo Layout

```text
apps/cli        Published CLI (`agentlens`) and command handlers
apps/server     Fastify API + static web host
apps/web        React + Vite frontend
packages/core   Discovery, parsing, indexing, snapshots
packages/contracts Shared TypeScript contracts
```

## Runtime Files

- Server log: `~/.agentlens/logs/server.log`
- PID file: `~/.agentlens/server.pid`

## Agent Workflow Skill

If you use agentic workflows, see:

`skills/agentlens/SKILL.md`
