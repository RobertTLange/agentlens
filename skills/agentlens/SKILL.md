---
name: agentlens
description: Use the AgentLens CLI to inspect local coding-agent traces, drill into sessions/events, and extract structured evidence fast.
---

# What the skill is about
Get reliable trace intelligence from local Codex/Claude logs via `agentlens` CLI.

# When to use the skill
- User asks for trace analysis, session debugging, tool-call inspection, or event timeline evidence.
- Need quick aggregate stats before deep dive.
- Need deterministic table outputs (`--llm`) for LLM chaining.
- Need machine-readable outputs (`--json`, `--jsonl`) for downstream reasoning.

# What to do
1. Confirm CLI availability and command surface:
- `agentlens --help`
- If local dev needed: `npm -w apps/cli run dev -- --help`
- If `agentlens` is missing or conflicting on PATH, use local entrypoint:
- `npm -w apps/cli run dev -- <command...>`

2. Start with high-signal summary:
- LLM-first:
- `agentlens summary --llm`
- Structured JSON alternative:
- `agentlens summary --json`
- Optional filters:
- `agentlens summary --json --agent codex`
- `agentlens summary --json --since 24h`

3. Find candidate sessions:
- Read `candidate_sessions` from `summary --llm` first.
- Or list history directly:
- `agentlens sessions list --llm --limit 50`
- `agentlens sessions list --llm --group-by recency --limit 50`
- `agentlens sessions list --json --limit 50`
- Agent filter:
- `agentlens sessions list --json --agent claude --limit 50`
- Pick `id` (or `sessionId`; both resolve) with relevant time/error/tool profile.

4. Inspect a specific session:
- LLM-first:
- `agentlens session <id_or_latest> --llm`
- `agentlens session <id> --json --events 120`
- Include tool details:
- `agentlens session <id> --show-tools --events 120`
- Include meta/system records when needed:
- `agentlens session <id> --json --include-meta --events 200`

5. Page raw events for deeper forensics:
- LLM table timeline:
- `agentlens sessions events <id_or_latest> --llm --limit 100`
- `agentlens sessions events <id> --jsonl --limit 200`
- Backward pagination:
- `agentlens sessions events <id> --jsonl --limit 200 --before <next_before>`
- Live tail:
- `agentlens sessions events <id> --jsonl --follow`

6. Report findings with evidence:
- Cite command used.
- Include concrete IDs/kinds/timestamps/tool names.
- Separate facts from inference.

# Output and interpretation notes
- Prefer `--llm` when chaining overview -> session -> events in prompts/tools.
- Prefer `--json`/`--jsonl` when strict machine parsing is required.
- `summary` gives counts and distributions; use for triage only.
- `summary --llm` includes `candidate_sessions` for immediate drill-down.
- `session`/`sessions show` gives event previews; add `--show-tools` for tool args/results.
- `session --llm` includes a `next_calls` hint with the follow-up events command.
- `sessions events` is best for full timeline extraction and pagination.

# Guardrails
- Read-only default; do not run `agentlens config set` unless user asks.
- Do not fabricate missing events; if data absent, say so.
- If trace IDs are ambiguous, list candidates and disambiguate by updated time/path.
