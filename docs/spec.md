# AgentLens RAG Summaries and Hybrid Search Spec

## Goal

Add a local RAG layer that summarizes quiet agent traces, stores one structured summary per trace/session, indexes summaries plus redacted trace text, and exposes hybrid retrieval through CLI, HTTP API, and a new Web UI tab beside `Inspector` and `Activity`.

Primary use cases:

- Find prior traces relevant to a current coding task.
- Let coding agents discover previous debugging work before acting.
- Search summaries and full redacted trace content from the CLI.
- Surface workflow-level patterns such as repeated blockers, tool failures, and followups.

## Existing Anchors

AgentLens already has the pieces this feature should extend:

- `TraceIndex` in `packages/core` discovers, parses, redacts, and serves normalized events.
- `apps/cli/src/main.ts` owns the Commander CLI.
- `apps/server/src/app.ts` owns Fastify API routes.
- `apps/web/src/App.tsx` owns the primary `Inspector` / `Activity` tab switch.
- Shared public shapes live in `packages/contracts/src/index.ts`.

Do not replace the live in-memory trace index. The RAG layer is a persistent, derived index.

## Product Behavior

### Quiet Trace Rule

`agentlens rag watch` and `agentlens rag index --once` must summarize only traces that have not been updated for at least 4 hours.

Eligibility:

- `max(summary.lastEventTs ?? 0, summary.mtimeMs) <= Date.now() - rag.quietPeriodMs`
- default `rag.quietPeriodMs = 14_400_000`
- parseable trace
- at least one non-meta event
- new or stale in the RAG DB

This quiet-period rule is required. Active traces should remain searchable only through existing live Inspector APIs until they become quiet.

### Staleness

A RAG summary is stale when any fingerprint input changes:

- trace id, path, agent, parser, source profile, session id
- file size and mtime
- event count
- hash of the redacted normalized event payload used for summarization

If a stale trace is still inside the 4-hour quiet period, keep the previous complete summary visible and mark refresh state as stale/pending.

### Summarization Input

Send full redacted normalized events to Headless. Do not send raw trace files and do not ask Headless to read trace paths.

Prompt payload includes:

- trace metadata and current `TraceSummary`
- every redacted normalized event with index, timestamp, event kind, role, preview, text blocks, tool name/type/call id, tool args/result text, and error flag

If the prompt would exceed `rag.summaryMaxPromptBytes`, mark the job `skipped` with `input_too_large`. Manual indexing may override with `--force-large`.

### Structured Summary

Store one JSON object per trace/session:

```ts
interface RagTraceSummaryContent {
  title: string;
  userGoal: string;
  outcome: string;
  keySteps: string[];
  filesOrProjects: string[];
  toolsUsed: string[];
  errorsOrBlockers: string[];
  decisions: string[];
  workflowObservations: string[];
  followups: string[];
  searchKeywords: string[];
}
```

Validation:

- fields are required
- strings are trimmed
- arrays may default to `[]`
- invalid JSON or invalid shape marks the refresh `failed`
- a failed refresh must not delete the previous complete summary

### Retrieval Corpus

Index two document classes:

| Kind | Content | Notes |
| --- | --- | --- |
| `summary` | flattened structured summary | one per trace, highest signal |
| `trace` | chunks of full redacted normalized event text | chunked by event order |

Trace chunks target about 8,000 characters and must not split an individual event. Search results collapse chunk hits to trace-level results while preserving representative snippets.

## Configuration

Add `[rag]` to `AppConfig`, defaults, merge logic, `example.config.toml`, and configuration docs.

```toml
[rag]
enabled = true
dbPath = "~/.agentlens/rag.db"
quietPeriodMs = 14400000
workerIntervalMs = 300000
daemonPidPath = "~/.agentlens/rag-worker.pid"
daemonLogPath = "~/.agentlens/logs/rag-worker.log"

headlessExecutable = "headless"
summaryAgent = "codex"
summaryModel = ""
summaryReasoningEffort = "medium"
summaryPermissionMode = "read-only"
summaryTimeoutMs = 600000
summaryMaxPromptBytes = 1500000

embeddingBackend = "local"
embeddingModel = "sentence-transformers/all-MiniLM-L6-v2"
modelCacheDir = "~/.agentlens/models"
embeddingBatchSize = 32
searchCandidateMultiplier = 8
rrfK = 60
```

## Storage

Use SQLite at `rag.dbPath`. Use explicit schema metadata and idempotent migrations.

Required tables:

| Table | Purpose |
| --- | --- |
| `rag_meta` | schema version, embedding metadata, last run metadata |
| `rag_sessions` | one row per trace/session summary and refresh status |
| `rag_documents` | searchable summary and trace chunk documents |
| `rag_embeddings` | Float32 vector blobs keyed by document id |
| `rag_document_fts` | FTS5 virtual table for lexical retrieval |

Important `rag_sessions` columns:

- `trace_id primary key`, `session_id`, `agent`, `parser`, `source_profile`, `path`
- `first_event_ts`, `last_event_ts`, `mtime_ms`, `size_bytes`, `event_count`
- `fingerprint`, `status`, `skip_reason`, `error`
- `summary_json`, `summary_text`, `summary_model`, `summary_generated_at_ms`
- `created_at_ms`, `updated_at_ms`

Statuses:

- `pending`: queued but not processed
- `running`: worker owns the row
- `complete`: usable summary and documents exist
- `stale`: previous summary exists but trace changed
- `failed`: latest refresh failed
- `skipped`: intentionally skipped, for example oversized input

All SQL must use parameters. No string-built SQL from user input.

## Embeddings

Use local Hugging Face loading with model id `sentence-transformers/all-MiniLM-L6-v2`, matching Archivist's configured model. AgentLens is TypeScript/Node, so implement an embedding provider abstraction and a concrete local HF provider.

Requirements:

- cache model files under `rag.modelCacheDir`
- normalize vectors before storage
- store Float32 vector blobs with model and dimension metadata
- do not require model downloads in normal CI
- lexical search must keep working if embedding dependencies/model files are unavailable

Vector search can start as in-process cosine ranking over stored vectors. Keep the storage layout compatible with future sqlite-vec/sqlite-vss acceleration.

## Headless Summarization

Invoke Headless using argument arrays, never shell strings.

Command shape:

```text
headless <summaryAgent> --prompt-file <prompt.md> --work-dir <tmp-work-dir> --allow read-only --timeout <seconds> --json
```

Add `--model` and `--reasoning-effort` only when configured. Always use `read-only` unless config explicitly changes later; v1 default and tests should enforce read-only.

Environment allowlist:

- runtime: `HOME`, `PATH`, `LANG`, `LC_ALL`, `TMPDIR`, `TEMP`, `TMP`
- provider auth needed by Headless: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, plus existing Headless auth envs as needed

Prompt rules:

- describe the payload as redacted local trace data
- require strict JSON matching `RagTraceSummaryContent`
- forbid invented files, outcomes, and followups
- require uncertainty to be represented plainly

Failure handling:

- timeout kills the child and marks the refresh failed
- non-zero exit marks failed
- malformed output marks failed
- no failed refresh may delete the last complete summary
- logs must not contain full prompt text or full event text

## Worker and Daemon

### CLI

Add:

```bash
agentlens rag index --once [--limit n] [--force] [--force-large] [--lexical-only] [--json]
agentlens rag watch [--interval <window>] [--limit n] [--foreground] [--json]
agentlens rag status [--json]
agentlens rag stop
agentlens search <query> [--mode hybrid|lexical|semantic] [--limit n] [--agent name] [--since window] [--json] [--llm]
```

`agentlens rag watch` starts a background daemon by default.

Daemon behavior:

- if no live daemon exists, spawn a detached worker and return immediately
- if a live daemon PID exists, print reuse status and return
- write PID to `rag.daemonPidPath`
- write logs to `rag.daemonLogPath`
- `--foreground` runs the loop inline for debugging and tests
- `rag stop` terminates the PID from the PID file and tolerates stale/missing PID files

Internal worker:

```bash
agentlens rag worker --foreground
```

The worker loop:

1. load config
2. initialize/migrate SQLite
3. refresh `TraceIndex`
4. find quiet eligible stale/new traces
5. summarize up to `--limit`
6. replace lexical documents
7. embed changed documents unless `--lexical-only`
8. update run status
9. sleep `workerIntervalMs`
10. repeat until signaled

Do not use Headless cron. AgentLens owns scheduling and invokes Headless only for summarization.

### One-Shot Indexing

`agentlens rag index --once` runs the same pipeline once in the foreground. JSON output should include DB path, discovered traces, quiet eligible traces, summarized/skipped/failed counts, lexical document count, embedding status, and last error.

## Search

Modes:

- `lexical`: FTS5 only
- `semantic`: local embeddings only
- `hybrid`: reciprocal rank fusion over lexical and semantic candidates

Default: `hybrid`.

Hybrid score:

```text
score = 1 / (rrfK + lexicalRank) + 1 / (rrfK + semanticRank)
```

Result contract:

```ts
interface RagSearchResult {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  path: string;
  title: string;
  userGoal: string;
  outcome: string;
  updatedAtMs: number;
  summaryGeneratedAtMs: number | null;
  score: number;
  lexicalRank?: number;
  semanticRank?: number;
  matchedKinds: Array<"summary" | "trace">;
  snippets: string[];
}
```

CLI `--llm` output must be deterministic and include next calls:

- `agentlens session <trace_id> --llm`
- `agentlens sessions events <trace_id> --llm --limit 200`
- `agentlens rag summary <trace_id> --json`

If `agentlens rag summary` is not added, replace that next call with the implemented equivalent.

## HTTP API

Add read-only endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/rag/status` | DB/index/daemon status |
| `GET /api/rag/search?q=...&mode=hybrid&limit=20&agent=codex&since=7d` | search summaries and trace chunks |
| `GET /api/rag/summaries?status=complete&agent=codex&since=7d` | list summaries |
| `GET /api/rag/summaries/:traceId` | fetch one structured summary |

Status shape:

```ts
interface RagIndexStatus {
  enabled: boolean;
  dbPath: string;
  daemon: { running: boolean; pid: number | null; pidPath: string; logPath: string };
  sessions: { total: number; complete: number; pending: number; stale: number; failed: number; skipped: number };
  documents: number;
  embeddings: {
    status: "ready" | "missing" | "dirty" | "unavailable" | "disabled";
    model: string;
    dimension: number | null;
    count: number;
    error?: string;
  };
  lastRunAtMs: number | null;
  lastRunError: string;
}
```

HTTP rules:

- disabled RAG returns `200` with `enabled: false`
- missing DB returns empty status, not `500`
- invalid params return `400`
- unknown `traceId` returns `404`

## Web UI

Add a third primary tab:

```text
Inspector | Activity | Summaries
```

The `Summaries` tab should be an operational search/browser view, not a landing page.

Layout:

- toolbar with search input, mode segmented control, agent/status filters, refresh button
- result list with ranked rows, agent badge, title, outcome, score/status, snippets
- detail panel with structured summary sections: key steps, files/projects, errors/blockers, workflow observations, followups
- status strip with daemon state, complete/stale/failed counts, embedding status, last run time

Interactions:

- opening the tab fetches `/api/rag/status` and `/api/rag/summaries`
- empty query shows recent complete summaries, newest first
- typing a query debounces `/api/rag/search`
- selecting a row opens detail in the tab
- `Inspect trace` switches to Inspector and selects the trace
- semantic unavailable state keeps lexical results usable

Design constraints:

- match existing dense AgentLens style
- avoid marketing copy
- do not nest cards inside cards
- no text/button overlap on mobile
- use existing agent badge conventions

## Shared Contracts

Add to `packages/contracts`:

- `RagConfig`
- `RagTraceSummaryContent`
- `RagSummaryRecord`
- `RagDocumentKind`
- `RagSearchMode`
- `RagSearchResult`
- `RagIndexStatus`
- `RagSearchResponse`
- `RagSummaryListResponse`

All API shapes must be JSON-serializable and stable enough for agent consumption.

## Security and Privacy

Requirements:

- summarize only AgentLens-redacted normalized events
- never pass raw trace files for Headless to read
- never build shell command strings
- validate all CLI and HTTP inputs
- parameterize all SQL
- keep DB local
- do not log prompt payloads, raw event text, secrets, or full tool outputs
- document that summaries and embeddings are local but may still contain sensitive workflow context

## Implementation Plan

1. Contracts/config: add RAG config/types, defaults, TOML merge, example config, and config docs.
2. Store: add SQLite migrations, session/document/embedding upserts, status, stale detection, and deletion cleanup.
3. Corpus: build summarizer payloads and deterministic summary/trace documents from redacted `TraceIndex` details.
4. Headless: add subprocess runner, prompt builder, timeout handling, JSON validation, and failure preservation.
5. Embeddings: add provider abstraction, local HF provider, vector storage, fake provider test hooks, and semantic fallback.
6. Indexer/daemon: add one-shot sync, worker loop, detached PID/log lifecycle, foreground mode, and stop/status helpers.
7. Search: add lexical, semantic, hybrid RRF ranking, result collapse, snippets, `agentlens search`, and LLM output.
8. Server: add RAG service wiring and `/api/rag/*` routes.
9. Web: add `SummariesView`, tab wiring, data fetches, result/detail UI, inspect navigation, and responsive styling.

## Verification and Testing Guidelines

### Required Gate

Run before handoff:

```bash
npm -w packages/contracts run build
npm -w packages/core run test
npm -w apps/cli run test
npm -w apps/server run test
npm -w apps/web run test
npm run typecheck
npm run build
npm test
```

For Web UI work, also run dev servers and verify with Playwright screenshots on desktop and mobile.

```bash
npm -w apps/server run dev
npm -w apps/web run dev
```

Browser checks: app loads; `Inspector`, `Activity`, and `Summaries` tabs are visible; `Summaries` opens without layout overlap; search returns mocked or real results; result detail opens; `Inspect trace` navigates to Inspector; mobile controls remain readable.

### Unit Test Matrix

- Store: empty DB migration creates all tables; migration is idempotent; cascade delete removes documents/embeddings; status counts are correct; stale fingerprint detection works; previous complete summary survives failed refresh.
- Corpus: prompt uses redacted normalized fields only; all normalized events are included; chunks do not split events; content hashes are deterministic; oversized prompt marks `input_too_large`.
- Headless: executable is invoked with an argument array; `--allow read-only` is passed by default; prompt is written to a temp file; timeout kills child process; strict JSON is accepted; malformed JSON is rejected; prompt text is not logged.
- Embeddings: fake provider stores Float32 vector blobs; changed documents refresh vectors; unchanged documents reuse vectors; missing provider reports `unavailable`; lexical indexing works without embeddings.
- Search: FTS returns expected traces; fake semantic vectors rank expected traces; hybrid RRF order is deterministic; `agent` and `since` filters work; chunk hits collapse to trace hits; empty query returns recent summaries.
- CLI: `rag index --once --json` prints stable counts; `rag watch --foreground` runs inline in tests; `rag watch` writes/reuses PID file; `rag stop` handles missing/stale PID files; `rag status --json` handles missing DB; `search --llm` prints deterministic next-call tables.
- Server: `/api/rag/status` works before DB exists; `/api/rag/search` validates query/mode/limit; `/api/rag/summaries` filters by status/agent/since; `/api/rag/summaries/:traceId` returns `404` for unknown ids.
- Web: tablist includes `Summaries`; opening tab fetches status/summaries; query debounce calls search; semantic unavailable status still allows lexical results; selecting a result renders detail; inspect action switches to Inspector; responsive CSS prevents overlapping controls.

### Manual Verification

First run:

```bash
npm run build
agentlens rag status --json
agentlens rag index --once --limit 2 --json
agentlens search "failed test" --llm --limit 5
agentlens rag watch
agentlens rag status --json
agentlens --browser
```

Daemon:

```bash
agentlens rag watch
agentlens rag watch
agentlens rag status --json
tail -n 100 ~/.agentlens/logs/rag-worker.log
agentlens rag stop
agentlens rag status --json
```

Additional manual checks:

- Quiet period: touch/create a trace and verify it is not summarized within 4 hours; use an older fixture and verify it becomes complete; mutate the fixture and verify stale then complete after quiet again.
- Failure: configure invalid `headlessExecutable`, run one-shot index, verify failed status, restore executable, rerun with `--force`, verify complete status.
- Semantic fallback: run without local model/dependencies, verify semantic status `unavailable`, verify `--mode lexical` works, then add model cache and verify hybrid results include semantic ranks.
- CI: normal CI must not require real Headless or Hugging Face downloads; use fake headless executables, fake embedding providers, temporary SQLite DBs, and synthetic traces; put real model/headless smoke tests behind `AGENTLENS_RAG_SMOKE=1`.

## Acceptance Criteria

- `agentlens rag watch` starts/reuses a background daemon and returns quickly.
- The worker summarizes only traces quiet for at least 4 hours.
- One structured summary is stored per trace/session.
- Lexical search works without embeddings.
- Hybrid search works when the local HF model is available.
- CLI, HTTP, and Web UI expose summaries/search.
- `Summaries` appears next to `Inspector` and `Activity`.
- Existing Inspector and Activity flows remain unchanged.
- Full build/typecheck/test gate passes.
