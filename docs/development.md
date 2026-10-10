# Development

## Local Dev Loop

Use Node.js 24+ and pnpm 11.21.0 (pinned in `package.json`).

```bash
pnpm install
pnpm run dev:server
pnpm run dev:web
```

Frontend URL: `http://127.0.0.1:5173` (Vite proxies `/api` to `http://127.0.0.1:8787`).

`pnpm run dev:server` builds the CLI, starts (or reuses) the background RAG worker, then starts the API. Summary generation uses your configured AI agent and consumes tokens. The worker stays running when the server stops; stop it with `node apps/cli/dist/main.js rag stop`.

## Build + Test Gate

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

## Workspace Commands

```bash
pnpm --filter ./apps/server dev
pnpm --filter ./apps/web dev
pnpm --filter ./apps/cli dev summary --json
```

## Local CLI Link Workflow

```bash
./build.sh
```

`build.sh` handles workspace build + local `agentlens` link + browser launch.

## Useful Debug Commands

```bash
agentlens summary --json
agentlens sessions list --json --limit 10
agentlens session latest --show-tools
agentlens sessions events latest --follow --jsonl
```

## Repo Layout

```text
apps/cli          CLI entrypoint and command handlers
apps/server       Fastify API + static serving
apps/web          React + Vite frontend
packages/core     ingestion, parser registry, index lifecycle
packages/contracts shared TS contracts
```

## Contribution Notes

- keep changes focused and reviewable
- add regression tests for bug fixes
- run full gate before opening PR
- use Conventional Commits (`feat:`, `fix:`, `docs:`, ...)
