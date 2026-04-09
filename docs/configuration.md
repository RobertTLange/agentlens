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
