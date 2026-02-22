# Development

## Local Dev Loop

```bash
npm install
npm run dev:server
npm run dev:web
```

Frontend URL: `http://127.0.0.1:5173` (Vite proxies `/api` to `http://127.0.0.1:8787`).

## Build + Test Gate

```bash
npm run typecheck
npm test
npm run build
```

## Workspace Commands

```bash
npm -w apps/server run dev
npm -w apps/web run dev
npm -w apps/cli run dev -- summary --json
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
