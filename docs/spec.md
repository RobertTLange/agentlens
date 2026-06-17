# AgentLens Analysis Tab Spec

## Goal

Add an `Analysis` tab beside `Inspector`, `Activity`, and `Summaries` that reports how agent sessions use skills and subagents across the AgentLens trace corpus. Add matching CLI support through a top-level `agentlens analysis` command.

The feature should answer:

- Which skills are actually used?
- Which configured skills appear unused?
- Which unknown/unconfigured skills are observed in traces?
- Which subagent roles are spawned?
- Which source agents (`codex`, `claude`, etc.) are using each skill or subagent?
- Which sessions contributed most to each category, with links back to Inspector?

## Decisions

- Source of truth: AgentLens parsed traces, not a separate raw-log scanner.
- Scope: skills and subagents only. Do not include CLI tool adoption in v1.
- Skill confidence: count explicit and inferred skill usage separately.
- Default window: the full AgentLens indexed corpus.
- Filters: support optional recency and source-agent filters in API, CLI, and Web UI.
- Inventory: include configured/known skills plus observed unconfigured skills.
- Breakdown: group stats by trace source agent (`TraceSummary.agent`).
- Parser support: reliable detectors for Codex and Claude in v1; all other parsers are scanned but may report unsupported/unclassified detector status.
- Subagent metric: count observed spawn events and label them as `spawns`.
- Computation: derive on request from existing trace details; no persistent database/index in v1.
- API: add dedicated `/api/analysis`.
- CLI: add top-level `agentlens analysis [--json|--llm] [--since <window>] [--agent <name>]`.
- UI: aggregate-first tab with top contributing sessions and Inspector links.

## Existing Anchors

AgentLens already has the right extension points:

- Shared contracts: `packages/contracts/src/index.ts`
- Trace parsing/indexing: `packages/core/src/traceIndex.ts`
- Core exports: `packages/core/src/index.ts`
- Server routes: `apps/server/src/app.ts`
- CLI commands: `apps/cli/src/main.ts`
- Primary Web tabs: `apps/web/src/App.tsx`
- Existing feature view examples: `apps/web/src/ActivityView.tsx`, `apps/web/src/SummariesView.tsx`

Agentic Garden reference implementation:

- `/Users/rob/Dropbox/projects/agentic-aquarium/agentic-garden/scripts/analyze-agent-usage.py`
- `/Users/rob/Dropbox/projects/agentic-aquarium/agentic-garden/scripts/agent_usage_render.py`
- `/Users/rob/Dropbox/projects/agentic-aquarium/agentic-garden/docs/agent-usage-analysis.md`
- `/Users/rob/Dropbox/projects/agentic-aquarium/agentic-garden/tests/analyze-agent-usage_test.sh`

Reusable Garden ideas:

- Inventory skills from `*/SKILL.md`.
- Detect explicit skill use from `.../skills/<name>/SKILL.md` paths.
- Detect inferred skill use from `$skill-name` and nearby text like `skill ... skill-name`.
- Detect Codex subagents from `spawn_agent` tool calls and `collab_agent_spawn_end`.
- Detect Claude subagents from `Task` tool usage.
- Render configured used/unused rows plus JSON output.

Do not reuse Garden's raw log discovery or CLI tool counting in AgentLens v1.

## Product Behavior

### Analysis Tab

Add a fourth primary tab named `Analysis`.

The tab should show:

- Summary counters: total sessions scanned, supported sessions, skill uses, explicit skill uses, inferred skill uses, subagent spawns, configured skills, unused configured skills, observed unconfigured skills.
- Source-agent breakdown: rows by `TraceSummary.agent` with sessions, explicit skill uses, inferred skill uses, total skill uses, and subagent spawns.
- Skills table: skill name, inventory status (`configured` or `unconfigured`), explicit count, inferred count, total count, sessions, and counts by source agent.
- Subagents table: role/name, spawn count, sessions, and counts by source agent.
- Unused configured skills table: configured skills with zero explicit/inferred usage.
- Top sessions table: sessions contributing the most skill/subagent events, with `Inspect` actions that switch to Inspector and select that trace.
- Detector coverage note: show which source agents had reliable detectors (`codex`, `claude`) and which were scanned without v1-specific detection rules.

Keep this as a utilitarian analysis surface, not a marketing page. Use dense tables, compact summary cards, and predictable controls.

### Filters

Initial filters:

- Source agent: all, `codex`, `claude`, `cursor`, `gemini`, `antigravity`, `opencode`, `pi`, `unknown`
- Since window: all, `24h`, `7d`, `30d`, custom text matching CLI `toMsWindow`

Default filter is all agents and all indexed traces.

### Empty States

- No traces: show `No sessions indexed`.
- No supported traces: show `No Codex or Claude sessions available for v1 analysis`.
- No skills/subagents observed: still show configured skill inventory and unused configured skills.
- Skill roots missing: show a non-fatal inventory warning and continue with observed usage.

## Data Model

Add contract types in `packages/contracts/src/index.ts`.

```ts
export type AnalysisDetectorSupport = "supported" | "unsupported";
export type AnalysisSkillConfidence = "explicit" | "inferred";
export type AnalysisInventoryStatus = "configured" | "unconfigured";

export interface AnalysisCountByAgent {
  agent: AgentKind;
  count: number;
}

export interface AnalysisSkillUsageRow {
  name: string;
  inventoryStatus: AnalysisInventoryStatus;
  explicitCount: number;
  inferredCount: number;
  totalCount: number;
  sessionCount: number;
  byAgent: AnalysisCountByAgent[];
}

export interface AnalysisSubagentUsageRow {
  name: string;
  spawnCount: number;
  sessionCount: number;
  byAgent: AnalysisCountByAgent[];
}

export interface AnalysisSourceAgentRow {
  agent: AgentKind;
  detectorSupport: AnalysisDetectorSupport;
  sessionCount: number;
  explicitSkillCount: number;
  inferredSkillCount: number;
  totalSkillCount: number;
  subagentSpawnCount: number;
}

export interface AnalysisTopSessionRow {
  traceId: string;
  sessionId: string;
  agent: AgentKind;
  path: string;
  lastEventTs: number | null;
  mtimeMs: number;
  explicitSkillCount: number;
  inferredSkillCount: number;
  subagentSpawnCount: number;
  topSkills: NamedCount[];
  topSubagents: NamedCount[];
}

export interface AnalysisInventorySummary {
  configuredSkills: string[];
  unusedConfiguredSkills: string[];
  observedUnconfiguredSkills: string[];
  skillRoots: string[];
  warnings: string[];
}

export interface AnalysisSummary {
  generatedAtMs: number;
  traceCount: number;
  supportedTraceCount: number;
  explicitSkillCount: number;
  inferredSkillCount: number;
  totalSkillCount: number;
  subagentSpawnCount: number;
}

export interface AnalysisResponse {
  summary: AnalysisSummary;
  inventory: AnalysisInventorySummary;
  byAgent: AnalysisSourceAgentRow[];
  skills: AnalysisSkillUsageRow[];
  subagents: AnalysisSubagentUsageRow[];
  topSessions: AnalysisTopSessionRow[];
}
```

Keep response rows sorted deterministically:

- Usage rows: descending total/spawn count, then name ascending.
- Source-agent rows: configured `AgentKind` order.
- Top sessions: descending total analysis activity, then most recent, then trace id.

## Configuration

Add an `[analysis]` config block.

```toml
[analysis]
skillRoots = ["~/.codex/skills", "~/.claude/skills"]
topSessionLimit = 20
```

Contract:

```ts
export interface AnalysisConfig {
  skillRoots: string[];
  topSessionLimit: number;
}
```

Implementation tasks:

- Add `AnalysisConfig` to `AppConfig`.
- Add defaults in `packages/core/src/sourceProfiles.ts`.
- Merge config in `packages/core/src/config.ts`.
- Document config in `example.config.toml` and `docs/configuration.md`.

Inventory rules:

- Expand `~`.
- Ignore missing roots with warnings.
- A configured skill is any directory containing `SKILL.md`.
- Use the directory basename as the skill name.
- Deduplicate names across roots.
- Do not read arbitrary large skill contents; only existence/path is needed.

## Core Implementation

Add `packages/core/src/analysis.ts`.

Public API:

```ts
export interface BuildAnalysisOptions {
  agent?: AgentKind;
  since?: number;
  topSessionLimit?: number;
}

export function buildAnalysis(traceIndex: TraceIndex, options?: BuildAnalysisOptions): AnalysisResponse;
```

Filtering:

- Start from `traceIndex.getSummaries()`.
- Apply `agent` if provided.
- Apply `since` against `summary.lastEventTs ?? summary.mtimeMs`.
- For each included trace, call `traceIndex.getSessionDetail(summary.id)` to use existing parsed/redacted normalized events.

This is intentionally on-request. Do not add new persistent state in v1.

### Detection Rules

#### Explicit Skills

Count occurrences of paths matching:

```text
/skills/<skill-name>/SKILL.md
```

Sources to inspect:

- `event.toolArgsText`
- `event.toolResultText`
- `event.textBlocks`
- `event.preview`
- stringified shallow values from `event.raw` only when needed for Codex/Claude gaps

Normalize names case-sensitively by path segment. Do not count names with path traversal segments.

#### Inferred Skills

For each configured skill name, inspect user/assistant text for:

- `$<skill-name>`
- `<skill-name>` within 60 characters before `skill`
- `skill` within 60 characters before `<skill-name>`

Sources:

- `event.textBlocks`
- `event.preview`
- `event.toolArgsText` only for user-provided prompt-like tool inputs if tests show this is needed

Do not infer unknown skill names from arbitrary text in v1. Unknown/unconfigured skills are surfaced only from explicit `SKILL.md` paths.

#### Codex Subagents

Detect:

- `tool_use` with `toolName` or `functionName` equal to `spawn_agent`; parse `event.toolArgsText` JSON when possible and count `agent_type || "default"`.
- raw `response_item` function/custom tool calls named `spawn_agent` if the normalized event does not expose enough arguments.
- raw event payload `type === "collab_agent_spawn_end"` and count `new_agent_role || "unknown"`.

Avoid double-counting the same spawn event. Use `event.eventId` plus detected role as the per-session dedupe key.

#### Claude Subagents

Detect:

- `tool_use` with `toolName === "Task"`; parse args from `event.toolArgsText` or raw content and count `subagent_type || agent_type || "task"`.
- Claude sidechain files are currently excluded by the default `claude_projects` source profile, so do not rely on sidechain trace files in v1.

Avoid double-counting the same event.

#### Other Agents

For `cursor`, `gemini`, `antigravity`, `opencode`, `pi`, and `unknown`:

- Include sessions in `traceCount`.
- Mark source-agent row `detectorSupport: "unsupported"`.
- Do not invent skill/subagent usage.
- Future parser-specific detectors can be added behind the same analysis API.

## Server API

Add:

```http
GET /api/analysis?agent=<agent>&since=<window>
```

Behavior:

- Return `503` warming response only if Inspector is not ready, matching other trace-derived endpoints.
- Parse `agent` with existing `parseAgentKind`.
- Parse `since` with existing `parseSinceWindow` / `toMsWindow` pattern.
- Return `AnalysisResponse`.
- Return `400` for invalid filters.

Add tests in `apps/server/src/app.test.ts` for:

- Basic `/api/analysis` response.
- `agent` filter.
- `since` filter.
- Warming/not-ready behavior if applicable to existing test harness.

## CLI

Add a top-level command:

```bash
agentlens analysis [--json] [--llm] [--agent <name>] [--since <window>]
```

Default human output:

- `overview`
- `by_agent`
- `skills`
- `subagents`
- `unused_configured_skills`
- `top_sessions`

`--llm` output:

- Deterministic Markdown-ish section headings like existing `summary --llm`.
- Stable table columns and no ANSI color.

`--json` output:

- Print the exact `AnalysisResponse` shape.

Add CLI tests in `apps/cli/src/main.test.ts`:

- `analysis --json` includes explicit/inferred skill counts and subagent spawns.
- default output includes skills/subagents/unused sections.
- `--agent codex` filters out Claude rows.
- `--since` excludes old sessions.
- `--llm` has deterministic section headers.

## Web UI

Add `apps/web/src/AnalysisView.tsx`.

Responsibilities:

- Fetch `/api/analysis`.
- Render loading, error, empty, and data states.
- Provide source-agent and since filters.
- Render summary counters and tables.
- Call `onInspectTrace(traceId)` for top session links.

Integrate in `apps/web/src/App.tsx`:

- Extend active view state union with `"analysis"`.
- Add `Analysis` button in the primary tablist.
- Render `AnalysisView` with the same Inspector navigation callback pattern used by `ActivityView` and `SummariesView`.

Styling:

- Add scoped classes in `apps/web/src/styles.css`.
- Reuse existing panel/table visual language.
- Keep compact, work-focused layout.
- Avoid nested cards.
- Ensure mobile tables either scroll horizontally or collapse cleanly.

Add Web tests:

- `apps/web/src/App.test.tsx`: tab button appears and switches views.
- `apps/web/src/AnalysisView.test.tsx`: renders summary, tables, filters, errors, and Inspect callback.
- CSS/responsive test only if new layout introduces fixed-width risk.

## Verification Plan

Run targeted tests while implementing:

```bash
npm -w packages/contracts run build
npm -w packages/core test
npm -w apps/server test
npm -w apps/cli test
npm -w apps/web test
```

Run full gate before handoff:

```bash
npm run build
npm run typecheck
npm test
```

For browser-visible behavior, run the app and verify with Playwright:

```bash
npm -w apps/server run dev
```

Then check:

- Analysis tab appears beside `Inspector`, `Activity`, `Summaries`.
- Loading state resolves.
- Filters update the request and visible rows.
- `Inspect` opens the selected trace in Inspector.
- Desktop and mobile layouts do not overlap.

## Implementation Order

1. Add contracts and config defaults/merge logic.
2. Implement `packages/core/src/analysis.ts` with fixture-focused unit tests.
3. Export analysis builder from `packages/core/src/index.ts`.
4. Add `/api/analysis` route and server tests.
5. Add `agentlens analysis` CLI command and tests.
6. Add `AnalysisView` and wire the Web tab.
7. Add Web tests and CSS.
8. Run full verification gate and browser check.

## Non-Goals For V1

- CLI tool adoption.
- Persistent analysis database.
- Cross-session subagent lifecycle tracking.
- Completion/success/failure status for subagents.
- Parser-specific detection for Cursor, Gemini, OpenCode, or Pi.
- Editing or importing Agentic Garden Python code.
- LLM-generated analysis summaries.

## Open Follow-Ups

- Add parser-specific detectors for OpenCode/Pi/Gemini if their traces expose subagent concepts.
- Add trend charts by day/week once the aggregate tables are stable.
- Add project/repo path filtering if users want per-repository skill adoption.
- Add configurable inferred-skill matching if false positives appear.
