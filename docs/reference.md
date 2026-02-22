# AgentLens Reference

## Overview

AgentLens watches local session logs, normalizes events across agent runtimes, and exposes one local observability surface through:

- Web UI (`agentlens --browser`)
- CLI (`agentlens ...`)
- HTTP API (`/api/*`)

Design goals:

- local-first (no hosted backend)
- cross-agent event schema
- live updates with low setup friction

## Supported Agents

- Codex
- Claude
- Cursor
- Gemini
- Pi
- OpenCode

## Default Log Sources

| Agent | Default source(s) | Default ingestion path(s) |
| --- | --- | --- |
| Codex | `sources.codex_home` | `~/.codex/sessions/**/*.jsonl` |
| Claude | `sources.claude_projects`, `sources.claude_history` | `~/.claude/projects/**/*.jsonl`, `~/.claude/history.jsonl` |
| Cursor | `sources.cursor_agent_transcripts` | `~/.cursor/projects/**/agent-transcripts/*.txt` |
| Gemini | `sources.gemini_tmp` | `~/.gemini/tmp/**/chats/session-*.json`, `~/.gemini/tmp/**/*.jsonl` |
| Pi | `sources.pi_agent_sessions` | `~/.pi/agent/sessions/**/*.jsonl` |
| OpenCode | `sources.opencode_storage_session` + fallback discovery | `~/.local/share/opencode/storage/session/**/*.json`, `~/.local/share/opencode/storage/session_diff/**/*.json`, `~/.local/share/opencode/storage/opencode.db` |

## Event Model (Normalized)

Key kinds:

- `user`
- `assistant`
- `reasoning`
- `tool_use`
- `tool_result`
- `meta`
- `system`

Every normalized event includes searchable text, preview text, tool metadata, and linkage ids (`toolUseId`, `toolCallId`, parent ids).

## Activity Status Semantics

Computed in `@agentlens/core`; reused by UI/CLI/API.

- `waiting_input`: explicit structured markers first, text-pattern fallback second
- `running`: unmatched tool calls or very recent activity
- `idle`: no active signal or freshness TTL timeout

Related config (`[scan]`):

- `statusRunningTtlMs`
- `statusWaitingTtlMs`

Manual stop from UI/API sets `activityReason: manually_stopped` immediately while live stream remains active.

## Trace Lifecycle

- discovery: source roots + globs
- parse: parser registry picks parser by hint/score
- normalize: event schema + redaction
- index: summary + toc + metrics + activity status
- stream: SSE emits `trace_added`, `trace_updated`, `events_appended`, `trace_removed`, `overview_updated`

## Deep-Linking Arbitrary Files

Open one local trace file directly:

- URL format: `http://localhost:8787/trace-file/<base64url-absolute-path>`
- API backend: `GET /api/tracefile?path=<base64url>`
- behavior: ephemeral load only (no config mutation)
- on missing file: fallback to latest indexed trace + warning banner

Generate URL:

```bash
node -e 'const p=process.argv[1]; console.log(`http://localhost:8787/trace-file/${Buffer.from(p,"utf8").toString("base64url")}`)' "/absolute/path/to/log"
```

## Runtime Files

- config: `~/.agentlens/config.toml`
- server pid: `~/.agentlens/server.pid`
- server log: `~/.agentlens/logs/server.log`
