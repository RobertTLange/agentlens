# Configuration

Default config path:

```text
~/.agentlens/config.toml
```

Bootstrap:

```bash
cp example.config.toml ~/.agentlens/config.toml
```

Read/update through CLI:

```bash
agentlens config get
agentlens config set scan.intervalSeconds 1.5
agentlens config set scan.includeMetaDefault true
```

## Key Sections

- `[scan]`: refresh cadence + status freshness semantics
- `[retention]`: hot/warm/cold in-memory policy
- `[sources.*]`: discovery roots + include/exclude globs
- `[traceInspector]`: UI defaults for trace inspector behavior
- `[redaction]`: key/value redaction rules
- `[pricingSync]`: live pricing refresh behavior for `agentlens --browser`
- `[rag]`: local quiet-trace summaries, SQLite storage, Headless summarization, and hybrid search
- `[analysis]`: skill inventory roots and analysis display limits
- `[cost]`: model pricing tables + estimation policy
- `[models]`: context window defaults/overrides

## Pricing Defaults

Default pricing and context-window metadata are checked in under `packages/core/src/generatedPricing.ts`.

Refresh them from `models.dev/api.json` with:

```bash
npm run sync:pricing
```

`models.dev` is the primary source of truth for default rates and context windows across a curated first-party provider set.
AgentLens applies a small local Anthropic override layer after import so split cache-write tiers (`5m` vs `1h`) and long-context premiums stay accurate where `models.dev` only exposes generic cache-write pricing.
User-configured `[cost]` and `[models]` overrides still take precedence over the generated defaults.

## Browser Pricing Sync

At `agentlens --browser` launch, AgentLens can refresh pricing from `models.dev`, cache the result under `~/.agentlens/`, and start the browser server with an effective config that uses the fresh or cached pricing data.

```toml
[pricingSync]
enabled = true
ttlMs = 86400000
timeoutMs = 5000
```

- `enabled`: turn launch-time pricing refresh on or off
- `ttlMs`: how long a fetched pricing cache stays fresh
- `timeoutMs`: maximum time to wait for `models.dev` before falling back to cached or bundled defaults

## RAG Summaries

AgentLens can derive a persistent local RAG index from redacted normalized traces. The worker only summarizes traces that have been quiet for at least `quietPeriodMs`; active traces remain available through the live Inspector APIs until they age out.

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
summaryReasoningEffort = "medium"
summaryPermissionMode = "read-only"
summaryTimeoutMs = 600000
summaryMaxPromptBytes = 1500000
embeddingBackend = "local"
embeddingModel = "sentence-transformers/all-MiniLM-L6-v2"
modelCacheDir = "~/.agentlens/models"
```

Summaries, trace chunks, and embeddings are stored locally. They are built from AgentLens-redacted normalized events, but may still contain sensitive workflow context such as filenames, decisions, errors, and followups. Lexical search works without the local embedding model; semantic and hybrid ranking become available when the model can be loaded from cache or downloaded by the Hugging Face runtime.

## Analysis

The Analysis tab and `agentlens analysis` command derive skill and subagent usage from the indexed trace corpus on request. No additional persistent index is written.

```toml
[analysis]
skillRoots = ["~/.codex/skills", "~/.claude/skills"]
topSessionLimit = 20
```

- `skillRoots`: directories scanned for configured skills; each immediate child directory with a `SKILL.md` is treated as one configured skill
- `topSessionLimit`: maximum top-contributing sessions returned by analysis responses and CLI output

## Practical Scan Settings

```toml
[scan]
mode = "adaptive" # or "fixed"
intervalMinMs = 200
intervalMaxMs = 3000
fullRescanIntervalMs = 900000
batchDebounceMs = 120
statusRunningTtlMs = 300000
statusWaitingTtlMs = 900000
includeMetaDefault = false
```

## Practical Retention Settings

```toml
[retention]
strategy = "aggressive_recency" # or "full_memory"
hotTraceCount = 60
warmTraceCount = 240
maxResidentEventsPerHotTrace = 1200
maxResidentEventsPerWarmTrace = 120
detailLoadMode = "lazy_from_disk"
```

## Source Tuning Tips

- keep `roots` narrow to reduce discovery cost
- use `includeGlobs` for known log patterns
- use `excludeGlobs` for noisy/archive dirs
- disable unused source profiles to speed refresh

## Validation Loop

After config edits:

```bash
agentlens summary
agentlens sessions list --limit 20
```

If trace count looks wrong, verify source paths and globs first.
