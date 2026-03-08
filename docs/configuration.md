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
- `[cost]`: model pricing tables + estimation policy
- `[models]`: context window defaults/overrides

## Pricing Defaults

Vendor pricing defaults are checked in under `packages/core/src/generatedPricing.ts`.

Refresh them from the official Anthropic/OpenAI docs with:

```bash
npm run sync:pricing
```

Tiered defaults include long-context thresholds and Anthropic split cache-write rates when available.

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
