<p align="center">
  <img src="apps/web/public/favicon.png" alt="AgentLens logo" width="220" />
</p>

# AgentLens

AgentLens is local observability for coding-agent traces. It watches Codex, Claude, Cursor, and OpenCode logs, normalizes events, and gives you live inspection in browser, CLI, and API.

![AgentLens web UI](docs/demo.png)

## What AgentLens Provides

- Multi-agent trace ingestion from common local paths (`~/.codex`, `~/.claude`, `~/.cursor`, `~/.opencode`) with configurable source profiles.
- A unified event model across agents (`user`, `assistant`, `reasoning`, `tool_use`, `tool_result`, `meta`, `system`).
- Live session observability with streaming updates (new traces, appended events, overview refreshes).
- Tool-call visibility, including args/results and unmatched `tool_use`/`tool_result` detection.
- Aggregate stats for fast triage: trace/session counts, errors, event-kind distributions, and top tools.
- Local-first operation: no external service required; reads local files and serves a local web app/API.

## Interfaces

- Web app (`agentlens --browser`): searchable sessions, timeline TOC, trace inspector, raw event expansion, auto-follow for live updates.
- CLI: summaries, session listing/detail, event paging, and follow mode for real-time terminal streams.
- HTTP API: `/api/overview`, `/api/traces`, `/api/trace/:id`, `/api/stream` (SSE), `/api/config`.

## Install

```bash
npm install
./build.sh
```

`npm install -g agentlens` currently installs an unrelated registry package.

`build.sh` will:
- remove conflicting global `agentlens` package
- build and link the local CLI globally
- launch `agentlens --browser`

Optional args pass through:

```bash
./build.sh --host 127.0.0.1 --port 8787
```

## Quick Usage

```bash
agentlens --browser
agentlens summary
agentlens summary --json --since 24h
agentlens sessions list --limit 20
agentlens session latest --show-tools
agentlens session <trace_id_or_session_id> --show-tools
agentlens sessions events latest --follow
agentlens sessions events <trace_id_or_session_id> --follow
```

## Agent Skill

- LLM-agent workflow guide: `skills/agentlens/SKILL.md`
- Includes recommended trace triage flow (`summary` -> `sessions list` -> `session`/`sessions events`) and JSON/JSONL-first patterns.

## Local Build (Monorepo)

```bash
npm install
npm run build
node apps/cli/dist/main.js --browser
```

## Dev

```bash
npm -w apps/server run dev
npm -w apps/web run dev
```

Open `http://127.0.0.1:5173` for live UI.  
Web dev server proxies `/api` to `http://127.0.0.1:8787`.

## Config

Default path: `~/.agentlens/config.toml`

```bash
agentlens config get
agentlens config set scan.intervalSeconds 1.5
```

Session log roots with explicit types:

```toml
sessionLogDirectories = [
  { directory = "~/.codex", logType = "codex" },
  { directory = "~/.claude", logType = "claude" },
  { directory = "~/.opencode", logType = "opencode" },
  { directory = "~/.cursor", logType = "cursor" }
]
```

Source profiles are also configurable under `[sources.*]` to tune roots, globs, excludes, and depth.

## Background Runtime

- Server log: `~/.agentlens/logs/server.log`
- PID file: `~/.agentlens/server.pid`
