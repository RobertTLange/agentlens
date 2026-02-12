# Repository Guidelines

## Project Structure & Module Organization
- `apps/cli`: published npm CLI (`agentlens`) and command handlers.
- `apps/server`: Fastify API + static hosting; server build copies web assets into `dist/web`.
- `apps/web`: React + Vite frontend.
- `packages/core`: trace discovery, parsing, snapshot/index logic.
- `packages/contracts`: shared TypeScript contracts used across apps/packages.
- Tests are colocated with source as `*.test.ts` (for example, `apps/cli/src/main.test.ts`).

## Build, Test, and Development Commands
- `npm install`: install workspace dependencies.
- `npm run build`: build all workspaces in dependency order (contracts/core/web/server/cli).
- `npm run typecheck`: strict TS type-check across all workspaces.
- `npm test`: run all Vitest suites.
- `npm -w apps/server run dev`: backend watch mode.
- `npm -w apps/web run dev`: frontend dev server.
- `npm -w apps/cli run dev -- <args>`: run CLI from source (example: `summary --json`).
- Installed CLI examples: `agentlens --help`, `agentlens --browser`.

## Coding Style & Naming Conventions
- Language/runtime: TypeScript + Node ESM.
- Follow existing style: 2-space indentation, concise functions, explicit types at boundaries.
- Naming: `camelCase` for variables/functions, `PascalCase` for types/classes, `UPPER_SNAKE_CASE` for constants.
- Keep files modular and reviewable; prefer small targeted edits over broad rewrites.

## Testing Guidelines
- Framework: Vitest (`vitest run`) in each workspace.
- Naming: use `*.test.ts`; keep tests near the behavior they verify.
- Add regression tests for bug fixes (especially CLI and server startup behavior).
- For quick iteration, run workspace tests first: `npm -w apps/cli test`, then full `npm test`.

## Commit & Pull Request Guidelines
- Use Conventional Commit prefixes: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, etc.
- PRs should state: what changed, why it changed, and how to verify (exact commands).
- Link related issues/tasks when applicable.
- UI changes should include screenshots and affected flows/routes.
- Before review, ensure `npm run build`, `npm run typecheck`, and `npm test` all pass.

## Security & Configuration Tips
- Default config location: `~/.agentlens/config.toml`.
- Background runtime files: `~/.agentlens/server.pid`, `~/.agentlens/logs/server.log`.
- Do not commit secrets, tokens, or machine-specific override files.
