# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend
npm run dev          # Backend with hot-reload (tsx watch), port 3100
npm start            # Backend production

# Frontend
npm run dev:ui       # Vite dev server, port 5173
npm run build:ui     # Build frontend to ui/dist/

# Database
npm run db:migrate   # Apply schema migrations manually

# Quality
npm test             # vitest
npm run lint         # eslint src test scripts
npm run typecheck    # tsc (src+test+scripts) + ui tsc
npm run smoke:models # smoke test of the model catalog against the real CLIs
```

Notes:
- Gemini CLI was retired in F1 (Google: UNSUPPORTED_CLIENT); `agy` replaces it.
- `claude-opus-5-5` requires Claude Code >= 2.1.280 (verified with 2.1.292 on 2026-10-06).

Two separate `node_modules` exist: root (backend) and `ui/` (frontend). Run `npm install` in both when adding dependencies.

## Architecture

Three-tier local app: **Hono backend** (`:3100`) + **React 19 frontend** (`:5173` dev, or served from backend in prod) + **SQLite** (`~/.orquestador-ia/data/orquestador.db`).

### Adapter System

Each AI CLI (Claude Code, Codex, agy/Antigravity) lives in `src/adapters/{claude,codex,agy}/` and has four files:
- `index.ts` — metadata: command name, available models, defaults
- `detect.ts` — checks if CLI binary exists in PATH
- `execute.ts` — spawns the CLI, pipes the prompt via stdin or args
- `parse.ts` — extracts session IDs, cost, tokens from adapter-specific output format

Models live in `src/config/models.ts`. Adding a new adapter means creating these four files and registering it in the adapter registry.

### Execution Flow

```
POST /api/tasks → POST /api/tasks/:id/run
  → runner.ts: creates run record, resolves sessionId from prior runs in same conversation
  → If same adapter as prior turn: passes --resume flag
  → If no session: buildHistoryPrefix() injects last 20 turns as text prefix
  → process-runner.ts: spawns CLI via child_process.spawn (shell:true on Windows)
  → stdout/stderr chunks broadcast over WebSocket → UI streams logs in real time
  → parse() extracts metadata → run saved to DB → final status broadcast
```

### Plan System

`POST /api/plans` → `planner.ts` calls Claude (`PLANNER_MODEL` from `src/config/models.ts`, Opus 5.5) with a routing system prompt generated from `ROUTABLE_ADAPTERS` + `MODEL_CATALOG` (`claude`, `codex`, `agy` are routable); `normalizeSteps` validates each step against the catalog (disallowed adapter throws, unknown model falls back to the adapter default) → Claude outputs JSON with steps `{ description, adapter, model, reason, prompt }` → stored as `plan_steps` → `plan-runner.ts` executes steps sequentially with up to 2 retries per step.

Retry logic: transient errors (429, 503, rate limit text) → retry; unknown session error → retry without `--resume`; other errors → fail step and stop plan.

### WebSocket

`src/server/ws.ts` tracks all connected clients. `broadcast(event, data)` fans out to every client — this is intentional for the single-user design. Frontend `WebSocketProvider` listens and invalidates React Query caches on relevant events.

### Key Design Constraints

- **Single-user, local-only**: backend binds `127.0.0.1:3100`, no auth.
- **Session resume is adapter-scoped**: a conversation's `sessionId` is only passed as `--resume` if the new task uses the same adapter. Cross-adapter turns fall back to text prefix injection.
- **Windows spawn**: `process-runner.ts` always uses `shell: true` on Windows to avoid `ENOENT`. Codex requires prompt via stdin (using `-` flag) because its args don't survive cmd.exe quoting.
- **No prompts as cmd.exe arguments (F1 rule)**: `quoteWindowsArg` cannot make `&` or `%VAR%` safe under cmd.exe (see `it.fails` in `test/lib/quote-windows-arg.test.ts`). Send prompts via stdin or spawn with `shell:false`.
- **`agy` is spawned directly (`agy.exe`, `shell:false`) with the prompt as NDJSON on stdin.**
- **Attachments pipeline**: attached files are pre-analyzed by agy via `POST /api/analyze` before reaching the main adapter.
- **Headless flags**: Claude uses `--dangerously-skip-permissions`, Codex uses `--json`. These are required — interactive prompts break the runner.

### Database Schema (`src/db/schema.ts`)

Tables: `projects`, `tasks`, `runs`, `plans`, `plan_steps`. Tasks belong to a project and a `conversation_id` (UUID grouping multi-turn exchanges). Runs belong to tasks and store raw output, parsed result, session IDs, cost, and tokens.

### Frontend State

- `AppStateContext` — selected adapter, model, project, and active `conversationId`
- `WebSocketProvider` — single WS connection, event routing, log accumulation
- 3-column layout: `AdapterPanel` | `Chat` | `ProjectPanel`
- `PlanView` renders inside `Chat` when a plan is active
