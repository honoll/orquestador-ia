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

### Plan System (F2: DAG, Parallelism, Budget, Opus Synthesis)

**Core design:** Plans are DAGs where each step has `step_key`, `depends_on` (JSON array of step keys), `writes` (0=read, 1=write), and `estimated_tokens`. Plans track `estimated_tokens`, `budget_tokens` (default `ceil(1.5 × estimated)`), `used_tokens`, `max_parallel` (default **3**, configurable 1–5), `pause_reason` (quota|budget), and final `synthesis` result. Old plans without step keys run as a linear write-once chain.

**Step execution model:**
- `src/server/plan-dag.ts` — pure logic: `validateDag` (unique keys, no invalid/self/circular deps), `toDagSteps` (compute levels), `pickRunnable` (steps whose `depends_on` are `succeeded`/`skipped`), budget helpers, and prompt builders. Dependency results are framed as data (not instructions) and clipped to **4000 chars**; synthesis output clipped to **6000**.
- `src/server/plan-scheduler.ts` — **sole owner of plan state:** launches ready steps (readers in parallel up to `max_parallel`, one writer at a time), passes only direct-dependency results to each step, checks active agy account quota (pre-dispatch: if only agy is ready and account is blocked, pause without issuing a call), checks budget before each launch round, pauses on budget exhaustion (`pause_reason: budget`), cancels in-flight processes on failure/cancel (Windows: `taskkill /T /F`, kills entire subtree including synthesis), marks cancelled, then runs Opus synthesis (read-only adapter, cwd = `os.tmpdir()`).
- `runPlanStep(step)` returns `{ status: succeeded | failed | paused_quota, tokensUsed }`. Plan `failed` if any non-agy step fails; plan stops launching on any failure but waits for in-flight tasks.

**Parallelism rule A:** Readers run in parallel; **never two writers simultaneously.** A writer can run alongside readers.

**Budget rule A:** Default limit = `ceil(1.5 × Opus estimate)`, editable per plan. Counts all step attempts + synthesis. On budget exhaustion: terminates in-flight, marks paused, shows "continuar" banner. POST `/api/plans/:id/continue` raises limit by `ceil(1.5 × max(previous_limit, used_tokens))`.

**Quota handling:** Before launching an agy step, check if active account is quota-blocked. If the only ready step is agy and it is blocked, pause plan (no API call). If agy step runs and returns `quota_exhausted`, revert step to `pending` ("Pausado por cuota…"), do not retry, plan becomes `pending`.

**Final synthesis:** After all steps `succeeded`/`skipped`, Opus 5.5 (via claude adapter in **read-only mode**, cwd = `os.tmpdir()`) receives original request + all results (each clipped to 6000 chars, marked untrusted), outputs final Spanish answer. Stored in plan as `synthesis` with `synthesis_status` (succeeded|failed) and optional `synthesis_error`. If synthesis fails, plan is `completed` with `synthesis_status: failed` and a "retry synthesis" button.

**Routes (new in F2):**
- `POST /api/plans/:id/run-all` — launch all-in-parallel mode
- `POST /api/plans/:id/run-next` — mode next: one step per request
- `POST /api/plans/:id/resume` — resume after pause
- `POST /api/plans/:id/steps/:stepId/retry` — retry a failed step
- `PATCH /api/plans/:id/settings` — `{ budgetTokens, maxParallel }`
- `POST /api/plans/:id/continue` — budget pause → raise limit +50%
- `POST /api/plans/:id/synthesis/retry` — re-run synthesis on failure
- `DELETE /api/plans/:id` → `cancel` kill in-flight + mark cancelled + clear running synthesis

**WebSocket events (new in F2):**
- `plan:budget` — `{ planId, usedTokens, budgetTokens, estimatedTokens }`
- `plan:synthesis` — `{ planId, synthesisStatus, synthesisError? }`
- `plan:synthesis:log` — text chunks from synthesis streaming
- `plan:done` — `{ planId, status, paused?: boolean }`

**UI (F2):**
- PlanView diagram by levels (parallel steps stacked vertically)
- Read/write badges and token count per step
- Budget bar with editable limit and parallel slider
- Pause banner (quota or budget) with "continuar" button
- Final-answer card with markdown synthesis
- Cancel kills in-flight processes

**Known issues (deferred to F3):**
1. **Codex token spike:** Loads user's global skills and AGENTS.md (walks up from cwd under `C:\Users\sidel`) → inflates estimate (Codex used 168k on a 12k step). Candidate fix: isolate worker config.
2. **PlanView header:** Shows "✓ completado" while paused before synthesis (cosmetic; fixed in final review wave).

### WebSocket

`src/server/ws.ts` tracks all connected clients. `broadcast(event, data)` fans out to every client — this is intentional for the single-user design. Frontend `WebSocketProvider` listens and invalidates React Query caches on relevant events.

### Key Design Constraints

- **Single-user, local-only**: backend binds `127.0.0.1:3100`, no auth.
- **Session resume is adapter-scoped**: a conversation's `sessionId` is only passed as `--resume` if the new task uses the same adapter. Cross-adapter turns fall back to text prefix injection.
- **Windows spawn**: `process-runner.ts` uses `shell: true` on Windows to avoid `ENOENT`, except agy (`agy.exe`, `shell:false`). Codex requires prompt via stdin (using `-` flag) because its args don't survive cmd.exe quoting.
- **No prompts as cmd.exe arguments (F1 rule)**: `quoteWindowsArg` cannot make `&` or `%VAR%` safe under cmd.exe (see `it.fails` in `test/lib/quote-windows-arg.test.ts`). Send prompts via stdin or spawn with `shell:false`.
- **`agy` is spawned directly (`agy.exe`, `shell:false`) with the prompt as NDJSON on stdin.** It is resolved via `AGY_PATH` or `%LOCALAPPDATA%\agy\bin\agy.exe` (not PATH).
- **Attachments pipeline**: attached files are pre-analyzed by agy via `POST /api/analyze` before reaching the main adapter. The analysis runs agy in read-only mode (no `--dangerously-skip-permissions`).
- **Headless flags**: Claude uses `--dangerously-skip-permissions`, Codex uses `--json`. These are required — interactive prompts break the runner.

### Database Schema (`src/db/schema.ts`)

Tables: `projects`, `tasks`, `runs`, `plans`, `plan_steps`, `agy_accounts`, `agy_usage`. Tasks belong to a project and a `conversation_id` (UUID grouping multi-turn exchanges). Runs belong to tasks and store raw output, parsed result, session IDs, cost, and tokens.

### Frontend State

- `AppStateContext` — selected adapter, model, project, and active `conversationId`
- `WebSocketProvider` — single WS connection, event routing, log accumulation
- 3-column layout: `AdapterPanel` | `Chat` | `ProjectPanel`
- `PlanView` renders inside `Chat` when a plan is active

## Antigravity Accounts

Introduced in F1 (2026-10-06). Support for multiple agy accounts with usage tracking and quota management.

### Tables
- **`agy_accounts`** — `label` (free text), `active` (single active account globally), `manual_limit_5h`, `manual_limit_7d`, `calibrated_limit_5h`, `quota_blocked_until` (ISO timestamp), `quota_blocked_at` (ISO timestamp of the quota error), `notes`
- **`agy_usage`** — `account_id`, `at` (ISO timestamp), `input_tokens`, `output_tokens`, `source` (enum: chat | plan | analysis)

### Routes
- `GET /api/accounts` — list all accounts with usage summary
- `GET /api/accounts/active` — fetch active account + usage in 5h/7d windows
- `POST /api/accounts` — create account (sets `active: true` if first)
- `POST /api/accounts/:id/activate` — mark as active, deactivate others
- `PATCH /api/accounts/:id` — edit label, manual limits, notes
- `DELETE /api/accounts/:id` — delete account and its usage records
- `POST /api/accounts/switch-terminal` — open visible terminal with interactive `agy` to log in / switch accounts
- `GET /api/usage/session` — sum of `runs` rows since the server started + `agy_usage` rows with source `analysis`

### Meter (Estimated)
Tracks tokens per account in 5-hour and 7-day rolling windows. Effective limit = manual (if set), else calibrated (5h only).
- **Calibration:** redone on EVERY quota error: tokens spent in the 5h window become the calibrated limit (7d window only has manual limit since we cannot determine which window was exhausted).
- **Block until:** if error message includes reset time, store it; else estimate now + 5h. Only a success whose call started after the block (`quota_blocked_at`) clears it.
- **Known underestimate:** agy runs that time out or are cancelled record 0 tokens.
- **UI warning:** at 85% usage or while blocked. Orchestrator never auto-switches accounts; user must open "cambiar cuenta" terminal to interact with `agy` and mark the new active account in the orchestrator panel.

### Plans & Quota
If an `agy` step returns `quota_exhausted`, the step does not retry and does not fail. Instead: step reverts to `pending` with message "Pausado por cuota…", plan status becomes `pending`, and UI shows a banner offering to retry after account switch. No SQLite CHECK changes.

### UI Components
- **HUD bar** (`ui/src/components/HudBar.tsx`) — shows active account label, 5h usage "~N % · estimated · resets in Xh", warning/block indicator, session token count
- **Accounts panel** (`ui/src/components/AccountsPanel.tsx`) in left sidebar — list accounts, usage per window, add / use this / delete / edit limits / switch-terminal buttons
