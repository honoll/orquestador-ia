# F1 — Antigravity, cuentas y medidor · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar Antigravity (`agy` oficial) como trabajador del orquestador, retirar Gemini CLI, y dar al usuario un panel de cuentas con cambio de cuenta manual y un medidor de uso estimado con aviso.

**Architecture:** Nuevo adapter `src/adapters/agy/` que lanza `agy.exe` sin shell y con el prompt por stdin (NDJSON). El consumo de cada llamada a `agy` (chat, plan, análisis de adjuntos) se registra en una tabla `agy_usage` ligada a la cuenta activa de `agy_accounts`. El medidor son funciones puras (`src/lib/usage-meter.ts`) sobre esos puntos. La UI suma una barra superior (HUD) y un panel de cuentas. Un error de cuota en un plan pausa el paso en vez de fallarlo.

**Tech Stack:** Node 24 · TypeScript 5.7 ESM · Hono · Drizzle + libsql (SQLite) · vitest · React 19 + TanStack Query + Tailwind 4.

## Global Constraints

- Diseño aprobado: `docs/superpowers/specs/2026-10-06-f1-antigravity-cuentas-design.md`. Hallazgos de `agy`: `docs/superpowers/specs/2026-10-06-spike-agy.md`.
- Idioma de docs, mensajes de commit y textos de UI: español de México. `CLAUDE.md` sigue en inglés.
- Rama: `f1-antigravity-cuentas` (NO `main`). Commit + push al terminar cada tarea. Commits terminan con línea en blanco + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Antes de cada commit: `npm test`, `npm run lint` (0 errores), `npm run typecheck` (raíz con tests/scripts + `ui/`).
- Antigravity: solo el binario oficial `agy`, sin modificar, como proceso hijo. **Nunca** leer, copiar ni reenviar credenciales/tokens; nunca llamar endpoints de Google; nunca leer `~/.gemini/oauth_creds.json` ni el Administrador de credenciales. **Nunca cambiar de cuenta automáticamente.**
- `agy` se lanza con `shell: false` y el prompt por stdin. Ningún prompt viaja como argumento por cmd.exe.
- Ruta de `agy`: `AGY_PATH` si existe, si no `%LOCALAPPDATA%\agy\bin\agy.exe`.
- Umbral de aviso: **85 %**. Ventanas: **5 h** y **168 h (7 d)**. Si un error de cuota no trae hora de reinicio, se estima **ahora + 5 h**.
- Modelo del análisis de adjuntos: `gemini-3.8-flash-low` (vía `agy`).
- Tiempos en la base: los nuevos campos guardan ISO 8601 desde JS (`new Date().toISOString()`); para leer `runs.started_at` (formato SQLite `YYYY-MM-DD HH:MM:SS`, UTC) usar `parseDbTime` o `datetime()` de SQLite, nunca comparación de strings mezclando formatos.
- No se agregan dependencias nuevas.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `.gitattributes` | Crear | forzar LF |
| `scripts/smoke-models.ts` | Modificar | regex `^ok\.?$` |
| `src/lib/process-runner.ts` | Modificar | opción `shell` |
| `src/lib/agy-path.ts` | Crear | `resolveAgyPath()` |
| `src/adapters/agy/{index,detect,execute,parse}.ts` | Crear | adapter agy |
| `src/config/models.ts` | Modificar | catálogo agy, `AGY_ANALYSIS_MODEL`, sin gemini, ruteo |
| `src/adapters/registry.ts` | Modificar | registrar agy, quitar gemini |
| `src/adapters/gemini/`, `test/adapters/gemini-parse.test.ts` | Borrar | retiro de Gemini CLI |
| `src/server/routes/gemini-analyze.ts` → `src/server/routes/analyze.ts` | Renombrar | análisis de adjuntos con agy |
| `src/server/planner.ts`, `src/server/runner.ts`, `src/server/index.ts` | Modificar | ruteo, timeouts, rutas |
| `src/lib/usage-meter.ts` | Crear | medidor puro |
| `src/db/schema.ts`, `src/db/migrate.ts` | Modificar | `agy_accounts`, `agy_usage` |
| `src/server/agy-accounts.ts` | Crear | repositorio + registro de consumo |
| `src/lib/agy-terminal.ts` | Crear | abrir terminal visible con agy |
| `src/server/routes/accounts.ts` | Crear | API de cuentas |
| `src/server/plan-runner.ts` | Modificar | consumo + pausa por cuota |
| `src/server/routes/usage.ts` | Modificar | `GET /api/usage/session` |
| `test/setup-env.ts`, `vitest.config.ts` | Crear/Modificar | base temporal por archivo de test |
| `ui/src/lib/format.ts`, `ui/src/lib/accounts-api.ts` | Crear | formato y API de cuentas |
| `ui/src/components/HudBar.tsx`, `ui/src/components/AccountsPanel.tsx` | Crear | HUD y panel |
| `ui/src/App.tsx`, `ui/src/context/WebSocketProvider.tsx`, `ui/src/components/{Chat,PlanView,AdapterPanel}.tsx`, `ui/src/lib/parse-stream.ts` | Modificar | integración UI |

---

### Task 1: Pendientes de F0 (regex del smoke y finales de línea)

**Files:**
- Create: `.gitattributes`
- Modify: `scripts/smoke-models.ts` (check de ok), `src/server/planner.ts` (CRLF → LF)

- [ ] **Step 1: Crear `.gitattributes`**

```
* text=auto eol=lf
*.png binary
*.ico binary
```

- [ ] **Step 2: Normalizar finales de línea**

Run: `git add --renormalize . && git status --short`
Expected: aparece `src/server/planner.ts` (y quizá otros con CRLF). Verificar con `git ls-files --eol src/server/planner.ts` que el índice queda `i/lf`.

- [ ] **Step 3: Corregir el check del smoke**

En `scripts/smoke-models.ts` reemplazar `/^ok.?$/i` por `/^ok\.?$/i` (el punto escapado).

- [ ] **Step 4: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "chore: LF en todo el repo y regex exacto en el smoke"
git push -u origin f1-antigravity-cuentas
```

---

### Task 2: Adapter `agy` (ruta, ejecución sin shell, parser, catálogo, smoke)

**Files:**
- Create: `src/lib/agy-path.ts`, `src/adapters/agy/index.ts`, `src/adapters/agy/detect.ts`, `src/adapters/agy/execute.ts`, `src/adapters/agy/parse.ts`
- Modify: `src/lib/process-runner.ts`, `src/config/models.ts`, `src/adapters/registry.ts`, `src/server/planner.ts` (`ADAPTER_STRENGTHS`), `src/server/runner.ts` (`DEFAULT_TIMEOUT`)
- Test: `test/adapters/agy-parse.test.ts`, `test/adapters/agy-execute.test.ts`, `test/lib/agy-path.test.ts`
- Fixtures existentes: `test/fixtures/agy/print-ok.json`, `test/fixtures/agy/stream-stdin-ok.jsonl`

**Interfaces:**
- Consumes: `runProcess(options)` y `RunProcessResult` de `src/lib/process-runner.ts`; `AdapterExecutionResult`, `AdapterExecutionContext`, `Adapter` de `src/lib/types.ts`.
- Produces:
  ```ts
  // src/lib/agy-path.ts
  export function resolveAgyPath(env?: NodeJS.ProcessEnv): string | null;
  // src/lib/process-runner.ts
  interface RunProcessOptions { shell?: boolean /* default: process.platform === "win32" */ }
  // src/adapters/agy/parse.ts
  export function extractResetAt(text: string, now: number): string | null;
  export function parse(proc: RunProcessResult, now?: number): AdapterExecutionResult; // errorFamily "quota_exhausted" en cuota
  // src/adapters/agy/execute.ts
  export function buildAgyArgs(model?: string, conversationId?: string): string[];
  export function buildAgyStdin(prompt: string): string;
  export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  // src/config/models.ts
  export type AdapterType = "claude" | "codex" | "gemini" | "agy"; // gemini se quita en Task 3
  export const AGY_ANALYSIS_MODEL: string; // "gemini-3.8-flash-low"
  ```

- [ ] **Step 1: Tests de `resolveAgyPath`** — `test/lib/agy-path.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgyPath } from "../../src/lib/agy-path.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "agyp-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveAgyPath", () => {
  it("usa AGY_PATH si existe", () => {
    const f = path.join(dir, "agy.exe");
    fs.writeFileSync(f, "");
    expect(resolveAgyPath({ AGY_PATH: f })).toBe(f);
  });
  it("cae a LOCALAPPDATA\\agy\\bin\\agy.exe", () => {
    const f = path.join(dir, "agy", "bin", "agy.exe");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "");
    expect(resolveAgyPath({ LOCALAPPDATA: dir })).toBe(f);
  });
  it("null si no existe ninguno", () => {
    expect(resolveAgyPath({ AGY_PATH: path.join(dir, "no.exe"), LOCALAPPDATA: dir })).toBeNull();
  });
});
```

- [ ] **Step 2: Tests del parser** — `test/adapters/agy-parse.test.ts`

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse, extractResetAt } from "../../src/adapters/agy/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

const fx = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "agy", f), "utf8");
const NOW = Date.parse("2026-10-06T12:00:00Z");

describe("agy parse", () => {
  it("lee el JSON de print mode (fixture real)", () => {
    const r = parse(makeProc({ stdout: fx("print-ok.json") }));
    expect(r.summary).toBe("ok");
    expect(r.sessionId).toBe("a07d71af-c976-4a5a-b562-5d1e032faa07");
    expect(r.inputTokens).toBe(11632);
    expect(r.outputTokens).toBe(78);
    expect(r.errorMessage).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it("lee stream-json (fixture real): modelo, sesión, texto y tokens", () => {
    const r = parse(makeProc({ stdout: fx("stream-stdin-ok.jsonl") }));
    expect(r.summary).toBe("ok");
    expect(r.model).toBe("gemini-3.8-flash-low");
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.inputTokens).toBeGreaterThan(10000);
  });

  it("result ERROR con exit 0 se reporta como fallo (exitCode 1)", () => {
    const r = parse(makeProc({ stdout: jsonl({ event: "result", result: { status: "ERROR", response: "", error: "algo falló", usage: { input_tokens: 0, output_tokens: 0 } } }) }));
    expect(r.exitCode).toBe(1);
    expect(r.errorMessage).toBe("algo falló");
    expect(r.errorFamily).toBe("unknown");
  });

  it("error de cuota → quota_exhausted con hora de reinicio ISO", () => {
    const r = parse(makeProc({
      exitCode: 1,
      stdout: jsonl({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED: quota exceeded, resets at 2026-10-06T15:30:00Z", usage: { input_tokens: 0, output_tokens: 0 } } }),
    }), NOW);
    expect(r.errorFamily).toBe("quota_exhausted");
    expect(r.retryNotBefore).toBe("2026-10-06T15:30:00.000Z");
  });

  it("sin evento result y exit distinto de 0 usa stderr sin el prefijo 'error:'", () => {
    const r = parse(makeProc({ exitCode: 2, stderr: "error: stream input message is missing the \"event\" field\n" }));
    expect(r.errorMessage).toBe('stream input message is missing the "event" field');
  });

  it("timeout gana", () => {
    const r = parse(makeProc({ exitCode: 1, timedOut: true }));
    expect(r.errorFamily).toBe("timeout");
  });
});

describe("extractResetAt", () => {
  it("ISO", () => expect(extractResetAt("retry after 2026-10-06T13:00:00Z", NOW)).toBe("2026-10-06T13:00:00.000Z"));
  it("relativo en horas", () => expect(extractResetAt("try again in 2 hours", NOW)).toBe("2026-10-06T14:00:00.000Z"));
  it("relativo en minutos", () => expect(extractResetAt("vuelve a intentar en 30 minutos", NOW)).toBe("2026-10-06T12:30:00.000Z"));
  it("null si no hay pista", () => expect(extractResetAt("quota exceeded", NOW)).toBeNull());
});
```

- [ ] **Step 3: Tests de args/stdin** — `test/adapters/agy-execute.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildAgyArgs, buildAgyStdin } from "../../src/adapters/agy/execute.js";

describe("agy execute helpers", () => {
  it("args base: stream-json por stdin, --print= pegado y sin -p", () => {
    const a = buildAgyArgs();
    expect(a).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--print=", "--dangerously-skip-permissions"]);
    expect(a).not.toContain("-p");
  });
  it("agrega modelo y conversación", () => {
    expect(buildAgyArgs("gemini-3.8-flash-low", "c-1")).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json", "--print=", "--dangerously-skip-permissions",
      "--model", "gemini-3.8-flash-low", "--conversation", "c-1",
    ]);
  });
  it("stdin es una línea NDJSON con el prompt intacto (comillas, &, %VAR%, saltos)", () => {
    const prompt = 'di "a & b" y %PATH%\nsegunda línea';
    const line = buildAgyStdin(prompt);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ event: "user", message: { content: prompt } });
  });
});
```

- [ ] **Step 4: Correr y verificar que fallan**

Run: `npx vitest run test/adapters/agy-parse.test.ts test/adapters/agy-execute.test.ts test/lib/agy-path.test.ts`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 5: Opción `shell` en `src/lib/process-runner.ts`**

Agregar `shell?: boolean;` a `RunProcessOptions` (con comentario `/** default: true en Windows (para .cmd). Usar false para .exe nativos como agy. */`), desestructurarlo en `runProcess` y cambiar `const useShell = process.platform === "win32";` por `const useShell = shell ?? process.platform === "win32";`.

- [ ] **Step 6: Crear `src/lib/agy-path.ts`**

```ts
import fs from "node:fs";
import path from "node:path";

/** Ruta al agy.exe oficial: AGY_PATH, o %LOCALAPPDATA%\agy\bin\agy.exe. null si no existe. */
export function resolveAgyPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.AGY_PATH,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe") : undefined,
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}
```

- [ ] **Step 7: Crear `src/adapters/agy/parse.ts`**

```ts
import type { AdapterExecutionResult } from "../../lib/types.js";
import type { RunProcessResult } from "../../lib/process-runner.js";

const QUOTA_RE = /quota|resource[_ ]?exhausted|rate.?limit|429|too many requests|usage limit/i;
const TRANSIENT_RE = /503|529|overloaded|unavailable|capacity/i;

interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Formatos reales (agy 1.3.0, ver docs/superpowers/specs/2026-10-06-spike-agy.md):
 * - print json: una línea con AgyResult.
 * - stream-json: {"event":"init","conversation_id","init":{"model"}} ·
 *   {"event":"step_update","step_update":{"step_type":"agent_response","text_delta"}} ·
 *   {"event":"result","result":AgyResult}
 */
interface AgyEvent {
  event?: string;
  conversation_id?: string;
  init?: { model?: string };
  step_update?: { step_type?: string; text_delta?: string };
  result?: AgyResult;
  status?: string;
}

/** Hora de reinicio de cuota si el texto la trae (ISO o "in N hours/minutes"). */
export function extractResetAt(text: string, now: number): string | null {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const rel = text.match(/\b(?:in|after|en)\s+(\d+)\s*(hours?|horas?|h|minutes?|minutos?|mins?|m)\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3_600_000 : n * 60_000;
    return new Date(now + ms).toISOString();
  }
  return null;
}

export function parse(proc: RunProcessResult, now: number = Date.now()): AdapterExecutionResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const deltas: string[] = [];
  let final: AgyResult | undefined;

  for (const line of proc.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: AgyEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.event === "init") {
      sessionId = evt.conversation_id ?? sessionId;
      model = evt.init?.model ?? model;
    } else if (evt.event === "step_update" && evt.step_update?.step_type === "agent_response" && evt.step_update.text_delta) {
      deltas.push(evt.step_update.text_delta);
    } else if (evt.event === "result" && evt.result) {
      final = evt.result;
    } else if (!evt.event && typeof evt.status === "string") {
      final = evt as AgyResult;
    }
  }
  if (final?.conversation_id) sessionId = final.conversation_id;

  const stderrText = proc.stderr.trim();
  const failed = final?.status === "ERROR" || !final || (proc.exitCode !== 0 && proc.exitCode !== null);

  let errorMessage: string | null = null;
  let errorFamily: string | null = null;
  let retryNotBefore: string | null = null;

  if (proc.timedOut) {
    errorMessage = "Process timed out";
    errorFamily = "timeout";
  } else if (failed) {
    errorMessage = final?.error || stderrText.replace(/^error:\s*/i, "") || `Process exited with code ${proc.exitCode}`;
    const text = `${errorMessage}\n${stderrText}`;
    if (QUOTA_RE.test(text)) {
      errorFamily = "quota_exhausted";
      retryNotBefore = extractResetAt(text, now);
    } else if (TRANSIENT_RE.test(text)) {
      errorFamily = "transient_upstream";
    } else {
      errorFamily = "unknown";
    }
  }

  return {
    exitCode: failed && proc.exitCode === 0 ? 1 : proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    stdout: proc.stdout,
    stderr: proc.stderr,
    summary: (final?.response ?? deltas.join("")).trim(),
    sessionId,
    model,
    costUsd: 0, // agy no reporta costo
    inputTokens: final?.usage?.input_tokens ?? 0,
    outputTokens: final?.usage?.output_tokens ?? 0,
    errorMessage,
    errorFamily,
    retryNotBefore,
  };
}
```

- [ ] **Step 8: Crear `src/adapters/agy/execute.ts`**

```ts
import { runProcess } from "../../lib/process-runner.js";
import { resolveAgyPath } from "../../lib/agy-path.js";
import { parse } from "./parse.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../../lib/types.js";

export function buildAgyArgs(model?: string, conversationId?: string): string[] {
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--print=", // vacío y pegado: el prompt llega por stdin (ver spike)
    "--dangerously-skip-permissions",
  ];
  if (model) args.push("--model", model);
  if (conversationId) args.push("--conversation", conversationId);
  return args;
}

export function buildAgyStdin(prompt: string): string {
  return JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const exe = resolveAgyPath();
  if (!exe) {
    return parse({
      exitCode: -1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "agy no encontrado: instala Antigravity CLI o define AGY_PATH",
    });
  }

  // shell:false — agy.exe es nativo; nada del prompt pasa por cmd.exe.
  const { promise, kill } = runProcess({
    command: exe,
    args: buildAgyArgs(ctx.model, ctx.sessionId),
    cwd: ctx.cwd,
    stdin: buildAgyStdin(ctx.prompt),
    shell: false,
    timeoutSec: ctx.timeoutSec,
    graceSec: ctx.graceSec,
    env: ctx.env,
    onStdout: (chunk) => ctx.onLog("stdout", chunk),
    onStderr: (chunk) => ctx.onLog("stderr", chunk),
  });
  ctx.onKill?.(kill);

  return parse(await promise);
}
```

- [ ] **Step 9: Crear `src/adapters/agy/detect.ts` e `index.ts`**

```ts
// detect.ts
import { resolveAgyPath } from "../../lib/agy-path.js";
import type { AdapterDetectResult } from "../../lib/types.js";

export async function detect(): Promise<AdapterDetectResult> {
  const resolvedPath = resolveAgyPath();
  return { available: resolvedPath !== null, resolvedPath };
}
```

```ts
// index.ts
import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "agy",
  label: "Antigravity (agy)",
  command: "agy",
  models: MODEL_CATALOG.agy.models,
  defaultModel: MODEL_CATALOG.agy.defaultModel,
};

export const agyAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default agyAdapter;
```

- [ ] **Step 10: Catálogo, registry, planner y timeout**

`src/config/models.ts`: `AdapterType` agrega `"agy"`; en `MODEL_CATALOG` agregar (antes del cierre del objeto):

```ts
  agy: {
    defaultModel: "gemini-3.8-flash-medium",
    models: [
      { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.1-pro-high", label: "Gemini 3.1 Pro (High)" },
      { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 vía Antigravity (Medium)" },
      { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 vía Antigravity (High)" },
    ],
  },
```

y al final del archivo:

```ts
/** Modelo barato para el pre-análisis de archivos adjuntos (vía agy). */
export const AGY_ANALYSIS_MODEL = "gemini-3.8-flash-low";
```

`src/adapters/registry.ts`: importar `agyAdapter` de `./agy/index.js` y agregar `agy: agyAdapter`.
`src/server/planner.ts` `ADAPTER_STRENGTHS`: agregar
`agy: "fast and cheap analysis, reading and summarizing many files, routine implementation; Gemini 3.x and Claude models billed to the Antigravity quota (each call has ~11k tokens of fixed overhead, so prefer few dense steps)",`.
`src/server/runner.ts` `DEFAULT_TIMEOUT`: agregar `agy: 600,`.

- [ ] **Step 11: Correr tests**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS (incluye `test/config/models.test.ts`: agy está en el registry y lee del catálogo).

- [ ] **Step 12: Smoke real de agy** (gasta ~6 llamadas de la cuenta de prueba)

Run: `npm run smoke:models -- agy`
Expected: `ok: true` por modelo. Quitar del catálogo solo los ids que fallen por "modelo no existe/no soportado" (si era el default, el default pasa al primero que pasó). Errores de cuota: reintentar una vez; si persisten, conservar el id y anotarlo. Guardar la tabla final en el cuerpo del commit.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: adapter agy (sin shell, prompt por stdin) y catálogo verificado"
git push
```

---

### Task 3: Retiro de Gemini CLI y `agy` en el ruteo, análisis de adjuntos y UI

**Files:**
- Delete: `src/adapters/gemini/` (4 archivos), `test/adapters/gemini-parse.test.ts`
- Rename: `src/server/routes/gemini-analyze.ts` → `src/server/routes/analyze.ts`
- Modify: `src/config/models.ts`, `src/adapters/registry.ts`, `src/server/planner.ts`, `src/server/runner.ts`, `src/server/index.ts`, `src/lib/process-runner.ts` (comentario), `src/server/routes/usage.ts` (comentario), `ui/src/components/Chat.tsx`, `ui/src/components/PlanView.tsx`, `ui/src/components/AdapterPanel.tsx`, `ui/src/lib/parse-stream.ts`, `CLAUDE.md`, `CONTINUAR.md`
- Test: `test/server/planner-normalize.test.ts` (agregar caso), `test/config/models.test.ts` (agregar caso)

**Interfaces:**
- Consumes: `agyAdapter.execute`, `AGY_ANALYSIS_MODEL` (Task 2).
- Produces: `AdapterType = "claude" | "codex" | "agy"`; `ROUTABLE_ADAPTERS = ["claude", "codex", "agy"]`; `POST /api/analyze` con el mismo contrato que el viejo `/api/gemini/analyze` (`{ files, prompt, cwd? }` → `{ analysis, jobId }` o `{ error, fallback: true }`); evento WS `analyze:log`.

- [ ] **Step 1: Tests nuevos**

En `test/server/planner-normalize.test.ts` agregar:

```ts
  it("agy es un adapter ruteable y conserva un modelo válido del catálogo", () => {
    const [s] = normalizeSteps([{ description: "leer", adapter: "agy", model: "gemini-3.8-flash-low", reason: "r", prompt: "p" }]);
    expect(s.adapter).toBe("agy");
    expect(s.model).toBe("gemini-3.8-flash-low");
  });
  it("gemini ya no es ruteable", () => {
    expect(() => normalizeSteps([{ description: "x", adapter: "gemini", model: "", reason: "", prompt: "p" }])).toThrow("no permitido");
  });
```

En `test/config/models.test.ts` agregar:

```ts
  it("gemini CLI está retirado y agy es ruteable", () => {
    expect(Object.keys(MODEL_CATALOG)).not.toContain("gemini");
    expect(ROUTABLE_ADAPTERS).toEqual(["claude", "codex", "agy"]);
  });
```

(importar `ROUTABLE_ADAPTERS` de `../../src/config/models.js`).

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run test/config test/server/planner-normalize.test.ts`
Expected: FAIL (gemini sigue en el catálogo; agy no es ruteable).

- [ ] **Step 3: Backend**

- `src/config/models.ts`: `AdapterType = "claude" | "codex" | "agy"`; borrar la entrada `gemini` del catálogo y las líneas del comentario sobre ids gemini no verificados; `ROUTABLE_ADAPTERS: readonly AdapterType[] = ["claude", "codex", "agy"]` con comentario "Gemini CLI se retiró en F1 (UNSUPPORTED_CLIENT para la cuenta); agy lo reemplaza".
- `src/adapters/registry.ts`: quitar import y entrada de gemini.
- `src/server/planner.ts`: quitar `gemini` de `ADAPTER_STRENGTHS`.
- `src/server/runner.ts`: quitar `gemini` de `DEFAULT_TIMEOUT`.
- `git rm -r src/adapters/gemini test/adapters/gemini-parse.test.ts`.
- `git mv src/server/routes/gemini-analyze.ts src/server/routes/analyze.ts` y en ese archivo: importar `{ execute } from "../../adapters/agy/execute.js"` y `{ AGY_ANALYSIS_MODEL } from "../../config/models.js"`; doc comment `POST /api/analyze — pre-análisis de adjuntos con agy (modelo barato)`; pasar `model: AGY_ANALYSIS_MODEL` y `timeoutSec: 180` a `execute`; evento WS `type: "analyze:log"`; mensaje vacío `"El análisis de agy vino vacío"`. (El registro de consumo por cuenta se agrega en Task 5.)
- `src/server/index.ts`: `import analyzeRoute from "./routes/analyze.js";` y `app.route("/api/analyze", analyzeRoute);` en lugar de la ruta gemini.
- `src/lib/process-runner.ts`: el comentario que menciona `gemini.CMD` pasa a `(codex.CMD, claude.cmd)`.
- `src/server/routes/usage.ts`: comentario `For codex/agy: falls back to orchestrator runs table.`

- [ ] **Step 4: UI**

- `ui/src/components/Chat.tsx`:
  - comando de la paleta `/gemini` → `{ name: "/agy", args: "<prompt>", description: "Fuerza el uso de Antigravity (agy)", icon: "◎" }`;
  - regex de forzado `/^\/(claude|codex|agy)\s+(.+)/si`;
  - `getGeminiFileContext` → `getFileAnalysisContext`, `fetch("/api/analyze", …)`, prefijo `[Análisis de archivos (agy)]\n`; doc comment actualizado;
  - estado `geminiAnalyzing` → `analyzingFiles` (todas sus apariciones); textos "◎ agy analizando archivos…" y "◎ agy…".
- `ui/src/components/PlanView.tsx`: en el tipo del paso y en los mapas de color/ícono reemplazar la clave `gemini` por `agy` (conservar los estilos sky); la lista de íconos `["claude", "codex", "gemini"]` → `["claude", "codex", "agy"]`.
- `ui/src/lib/parse-stream.ts`: comentario de formatos con agy; `case "agy": return extractAgyText(evt);` reemplaza el de gemini, y:
  ```ts
  function extractAgyText(evt: Record<string, any>): string | null {
    // agy stream-json: { event: "step_update", step_update: { step_type: "agent_response", text_delta: "..." } }
    if (evt.event === "step_update" && evt.step_update?.step_type === "agent_response" && evt.step_update.text_delta) {
      return evt.step_update.text_delta;
    }
    return null;
  }
  ```
  (borrar `extractGeminiText`).
- `ui/src/components/AdapterPanel.tsx`: quitar `gemini: 500_000` del mapa de presupuestos; donde se renderiza `<AdapterUsage adapter={a.type} />`, no renderizarlo cuando `a.type === "agy"` (el uso de agy lo muestran el HUD y el panel de cuentas de Task 7).

- [ ] **Step 5: Docs**

- `CLAUDE.md`: adapters `claude, codex, agy`; quitar la nota de Gemini CLI fallando y poner "Gemini CLI was retired in F1 (Google: UNSUPPORTED_CLIENT); `agy` replaces it"; en Key Design Constraints: "`agy` is spawned directly (`agy.exe`, `shell:false`) with the prompt as NDJSON on stdin". Pipeline de adjuntos → `POST /api/analyze` con agy.
- `CONTINUAR.md`: misma actualización en español (adapters, pipeline de adjuntos, slash command `/agy`).

- [ ] **Step 6: Verificar**

Run: `npm test && npm run lint && npm run typecheck && npm run build:ui`
Run: `git grep -n -i gemini -- src ui/src test scripts` → solo deben quedar ids de modelos `gemini-3.x` del catálogo agy, textos/fixtures de agy y el test "gemini ya no es ruteable".

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: retirar Gemini CLI; agy rutea, analiza adjuntos y aparece en la UI"
git push
```

---

### Task 4: Medidor puro (`src/lib/usage-meter.ts`)

**Files:**
- Create: `src/lib/usage-meter.ts`
- Test: `test/lib/usage-meter.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const HOUR_MS = 3_600_000;
  export const WINDOWS = { short: 5, long: 168 } as const;
  export const WARN_PCT = 85;
  export interface UsagePoint { at: number; tokens: number }
  export interface WindowUsage { windowHours: number; usedTokens: number; limitTokens: number | null; limitSource: "manual" | "calibrated" | null; pct: number | null; resetsAt: number | null }
  export interface WarnState { warn: boolean; reason: string | null }
  export function parseDbTime(s: string): number;
  export function usedInWindow(points: UsagePoint[], now: number, windowHours: number): number;
  export function windowUsage(points: UsagePoint[], now: number, windowHours: number, manualLimit: number | null, calibratedLimit: number | null): WindowUsage;
  export function warnState(windows: WindowUsage[], blockedUntil: number | null, now: number): WarnState;
  export function calibrateOnQuota(points: UsagePoint[], now: number, previousCalibrated: number | null): number | null;
  export function blockUntil(resetAt: string | null, now: number): number;
  ```

- [ ] **Step 1: Escribir `test/lib/usage-meter.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  HOUR_MS, WARN_PCT, parseDbTime, usedInWindow, windowUsage, warnState, calibrateOnQuota, blockUntil,
} from "../../src/lib/usage-meter.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (h: number) => NOW - h * HOUR_MS;
const pts = [
  { at: ago(0.5), tokens: 1000 },
  { at: ago(4.9), tokens: 2000 },
  { at: ago(6), tokens: 4000 },     // fuera de 5 h, dentro de 7 d
  { at: ago(200), tokens: 8000 },   // fuera de todo
];

describe("usage-meter", () => {
  it("parseDbTime acepta formato SQLite (UTC) e ISO", () => {
    expect(parseDbTime("2026-10-06 12:00:00")).toBe(NOW);
    expect(parseDbTime("2026-10-06T12:00:00.000Z")).toBe(NOW);
  });

  it("usedInWindow suma solo dentro de la ventana", () => {
    expect(usedInWindow(pts, NOW, 5)).toBe(3000);
    expect(usedInWindow(pts, NOW, 168)).toBe(7000);
  });

  it("sin tope: pct null y resetsAt = punto más viejo + ventana", () => {
    const w = windowUsage(pts, NOW, 5, null, null);
    expect(w).toEqual({ windowHours: 5, usedTokens: 3000, limitTokens: null, limitSource: null, pct: null, resetsAt: ago(4.9) + 5 * HOUR_MS });
  });

  it("el tope manual manda sobre el calibrado", () => {
    expect(windowUsage(pts, NOW, 5, 6000, 3000)).toMatchObject({ limitTokens: 6000, limitSource: "manual", pct: 50 });
    expect(windowUsage(pts, NOW, 5, null, 4000)).toMatchObject({ limitTokens: 4000, limitSource: "calibrated", pct: 75 });
  });

  it("pct se topa en 100", () => {
    expect(windowUsage(pts, NOW, 5, 1000, null).pct).toBe(100);
  });

  it("ventana vacía: usado 0 y sin reinicio", () => {
    expect(windowUsage([], NOW, 5, 100, null)).toMatchObject({ usedTokens: 0, pct: 0, resetsAt: null });
  });

  it(`aviso desde ${WARN_PCT} %`, () => {
    const at84 = windowUsage([{ at: ago(1), tokens: 84 }], NOW, 5, 100, null);
    const at85 = windowUsage([{ at: ago(1), tokens: 85 }], NOW, 5, 100, null);
    expect(warnState([at84], null, NOW).warn).toBe(false);
    expect(warnState([at85], null, NOW)).toEqual({ warn: true, reason: "~85 % usado en la ventana de 5 h: conviene cambiar de cuenta" });
  });

  it("bloqueo vigente avisa; bloqueo vencido no", () => {
    expect(warnState([], NOW + 1, NOW)).toEqual({ warn: true, reason: "Cuota agotada: conviene cambiar de cuenta" });
    expect(warnState([], NOW - 1, NOW).warn).toBe(false);
  });

  it("calibrateOnQuota toma lo gastado en 5 h; si fue 0 conserva el anterior", () => {
    expect(calibrateOnQuota(pts, NOW, null)).toBe(3000);
    expect(calibrateOnQuota([], NOW, 5000)).toBe(5000);
    expect(calibrateOnQuota([], NOW, null)).toBeNull();
  });

  it("blockUntil usa la hora de reinicio futura o estima ahora + 5 h", () => {
    expect(blockUntil("2026-10-06T15:00:00Z", NOW)).toBe(Date.parse("2026-10-06T15:00:00Z"));
    expect(blockUntil("2026-10-06T11:00:00Z", NOW)).toBe(NOW + 5 * HOUR_MS);
    expect(blockUntil(null, NOW)).toBe(NOW + 5 * HOUR_MS);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run test/lib/usage-meter.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Crear `src/lib/usage-meter.ts`**

```ts
/**
 * Medidor ESTIMADO de uso por cuenta de Antigravity. Google no expone la cuota:
 * se suman los tokens que reporta cada llamada y se calibra el tope con el primer
 * error de cuota. Funciones puras con reloj inyectable (`now` en ms).
 */
export const HOUR_MS = 3_600_000;
export const WINDOWS = { short: 5, long: 168 } as const;
export const WARN_PCT = 85;

export interface UsagePoint {
  at: number;
  tokens: number;
}

export interface WindowUsage {
  windowHours: number;
  usedTokens: number;
  limitTokens: number | null;
  limitSource: "manual" | "calibrated" | null;
  pct: number | null;
  resetsAt: number | null;
}

export interface WarnState {
  warn: boolean;
  reason: string | null;
}

/** "YYYY-MM-DD HH:MM:SS" (SQLite, UTC) o ISO 8601 → ms. */
export function parseDbTime(s: string): number {
  return Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
}

function inWindow(points: UsagePoint[], now: number, windowHours: number): UsagePoint[] {
  const from = now - windowHours * HOUR_MS;
  return points.filter((p) => p.at > from && p.at <= now);
}

export function usedInWindow(points: UsagePoint[], now: number, windowHours: number): number {
  return inWindow(points, now, windowHours).reduce((sum, p) => sum + p.tokens, 0);
}

export function windowUsage(
  points: UsagePoint[],
  now: number,
  windowHours: number,
  manualLimit: number | null,
  calibratedLimit: number | null,
): WindowUsage {
  const pts = inWindow(points, now, windowHours);
  const usedTokens = pts.reduce((sum, p) => sum + p.tokens, 0);
  const limitTokens = manualLimit ?? calibratedLimit ?? null;
  const limitSource = manualLimit != null ? "manual" : calibratedLimit != null ? "calibrated" : null;
  const pct = limitTokens && limitTokens > 0 ? Math.min(100, Math.round((usedTokens * 100) / limitTokens)) : null;
  const oldest = pts.length ? Math.min(...pts.map((p) => p.at)) : null;
  return {
    windowHours,
    usedTokens,
    limitTokens,
    limitSource,
    pct,
    resetsAt: oldest === null ? null : oldest + windowHours * HOUR_MS,
  };
}

export function warnState(windows: WindowUsage[], blockedUntil: number | null, now: number): WarnState {
  if (blockedUntil !== null && blockedUntil > now) {
    return { warn: true, reason: "Cuota agotada: conviene cambiar de cuenta" };
  }
  const hot = windows
    .filter((w) => w.pct !== null && w.pct >= WARN_PCT)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))[0];
  if (hot) {
    return { warn: true, reason: `~${hot.pct} % usado en la ventana de ${hot.windowHours} h: conviene cambiar de cuenta` };
  }
  return { warn: false, reason: null };
}

/** Al agotarse la cuota, lo gastado en la ventana corta se vuelve el tope calibrado. */
export function calibrateOnQuota(points: UsagePoint[], now: number, previousCalibrated: number | null): number | null {
  const used = usedInWindow(points, now, WINDOWS.short);
  return used > 0 ? used : previousCalibrated;
}

/** Hasta cuándo se considera bloqueada la cuenta tras un error de cuota. */
export function blockUntil(resetAt: string | null, now: number): number {
  const t = resetAt ? Date.parse(resetAt) : Number.NaN;
  return Number.isFinite(t) && t > now ? t : now + WINDOWS.short * HOUR_MS;
}
```

- [ ] **Step 4: Correr tests y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add src/lib/usage-meter.ts test/lib/usage-meter.test.ts
git commit -m "feat: medidor de uso estimado (ventanas 5 h/7 d, calibración, aviso 85 %)"
git push
```

---

### Task 5: Cuentas — tablas, repositorio, registro de consumo, API y terminal

**Files:**
- Create: `src/server/agy-accounts.ts`, `src/lib/agy-terminal.ts`, `src/server/routes/accounts.ts`, `test/setup-env.ts`
- Modify: `src/db/schema.ts`, `src/db/migrate.ts` (`SCHEMA_SQL`), `vitest.config.ts`, `src/server/index.ts`, `src/server/runner.ts`, `src/server/plan-runner.ts`, `src/server/routes/analyze.ts`
- Test: `test/server/agy-accounts.test.ts`, `test/lib/agy-terminal.test.ts`

**Interfaces:**
- Consumes: `windowUsage`, `warnState`, `calibrateOnQuota`, `blockUntil`, `WINDOWS`, `HOUR_MS`, `WindowUsage`, `WarnState`, `UsagePoint` (Task 4); `resolveAgyPath` (Task 2); `broadcast` de `src/server/ws.ts`; `migrationDone` de `src/db/migrate.ts`.
- Produces:
  ```ts
  // src/server/agy-accounts.ts
  export type AgyAccountRow = typeof schema.agyAccounts.$inferSelect;
  export interface AccountView {
    id: string; label: string; active: boolean;
    manualLimit5h: number | null; manualLimit7d: number | null; calibratedLimit5h: number | null;
    quotaBlockedUntil: string | null; notes: string | null;
    usage: { short: WindowUsage; long: WindowUsage }; warn: WarnState;
  }
  export class NoActiveAccountError extends Error {}
  export class AccountValidationError extends Error {}
  export async function listAccounts(now?: number): Promise<AccountView[]>;
  export async function getActiveAccount(): Promise<AgyAccountRow | null>;
  export async function requireActiveAccount(): Promise<AgyAccountRow>;
  export async function createAccount(label: string, now?: number): Promise<AccountView>;
  export async function activateAccount(id: string): Promise<void>;
  export async function updateAccount(id: string, patch: { label?: string; manualLimit5h?: number | null; manualLimit7d?: number | null; notes?: string | null }, now?: number): Promise<AccountView>;
  export async function deleteAccount(id: string): Promise<void>;
  export async function recordAgyCall(accountId: string, result: AdapterExecutionResult, source: "chat" | "plan" | "analysis", now?: number): Promise<void>;
  // src/lib/agy-terminal.ts
  export function buildTerminalCommand(exe: string): { command: string; args: string[] };
  export function openAgyTerminal(exe: string): void;
  ```
  Evento WS nuevo: `{ type: "accounts:changed", timestamp }`. Rutas: `GET /api/accounts`, `GET /api/accounts/active`, `POST /api/accounts`, `POST /api/accounts/:id/activate`, `PATCH /api/accounts/:id`, `DELETE /api/accounts/:id`, `POST /api/accounts/switch-terminal`.

- [ ] **Step 1: Base temporal para tests**

`test/setup-env.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cada archivo de test usa su propia base SQLite temporal (nunca ~/.orquestador-ia).
process.env.ORQUESTADOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orq-test-"));
```

En `vitest.config.ts` agregar `setupFiles: ["test/setup-env.ts"],` dentro de `test`.

- [ ] **Step 2: Tests del terminal** — `test/lib/agy-terminal.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildTerminalCommand } from "../../src/lib/agy-terminal.js";

describe("buildTerminalCommand", () => {
  it("abre una consola nueva con start y la ruta de agy entre comillas", () => {
    expect(buildTerminalCommand("C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe")).toEqual({
      command: "cmd.exe",
      args: ["/c", 'start "Antigravity - cambiar cuenta" "C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe"'],
    });
  });
});
```

- [ ] **Step 3: Tests del repositorio** — `test/server/agy-accounts.test.ts`

```ts
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { migrationDone } from "../../src/db/migrate.js";
import { db, schema } from "../../src/db/index.js";
import {
  listAccounts, createAccount, activateAccount, updateAccount, deleteAccount,
  getActiveAccount, requireActiveAccount, recordAgyCall, NoActiveAccountError, AccountValidationError,
} from "../../src/server/agy-accounts.js";
import { HOUR_MS } from "../../src/lib/usage-meter.js";
import type { AdapterExecutionResult } from "../../src/lib/types.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ok = (tokens: number): AdapterExecutionResult => ({
  exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary: "ok", sessionId: "c", model: null,
  costUsd: 0, inputTokens: tokens, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null,
});
const quota = (resetAt: string | null): AdapterExecutionResult => ({
  ...ok(0), exitCode: 1, summary: "", errorMessage: "quota exceeded", errorFamily: "quota_exhausted", retryNotBefore: resetAt,
});

beforeAll(async () => { await migrationDone; });
beforeEach(async () => {
  await db.delete(schema.agyUsage);
  await db.delete(schema.agyAccounts);
});

describe("cuentas agy", () => {
  it("la primera cuenta queda activa; la segunda no", async () => {
    const a = await createAccount("Familia A · 1", NOW);
    const b = await createAccount("Familia A · 2", NOW);
    expect(a.active).toBe(true);
    expect(b.active).toBe(false);
  });

  it("activar una desactiva las demás", async () => {
    const a = await createAccount("A", NOW);
    const b = await createAccount("B", NOW);
    await activateAccount(b.id);
    const list = await listAccounts(NOW);
    expect(list.find((x) => x.id === a.id)?.active).toBe(false);
    expect(list.find((x) => x.id === b.id)?.active).toBe(true);
    expect((await getActiveAccount())?.id).toBe(b.id);
  });

  it("sin cuentas, requireActiveAccount lanza NoActiveAccountError", async () => {
    await expect(requireActiveAccount()).rejects.toBeInstanceOf(NoActiveAccountError);
  });

  it("valida etiqueta y topes", async () => {
    await expect(createAccount("   ", NOW)).rejects.toBeInstanceOf(AccountValidationError);
    const a = await createAccount("A", NOW);
    await expect(updateAccount(a.id, { manualLimit5h: -5 }, NOW)).rejects.toBeInstanceOf(AccountValidationError);
    await expect(updateAccount(a.id, { manualLimit5h: 1.5 }, NOW)).rejects.toBeInstanceOf(AccountValidationError);
  });

  it("registra consumo y lo refleja en las ventanas", async () => {
    const a = await createAccount("A", NOW);
    await recordAgyCall(a.id, ok(1000), "chat", NOW - 1 * HOUR_MS);
    await recordAgyCall(a.id, ok(2000), "plan", NOW - 6 * HOUR_MS);
    const [v] = await listAccounts(NOW);
    expect(v.usage.short.usedTokens).toBe(1000);
    expect(v.usage.long.usedTokens).toBe(3000);
    expect(v.warn.warn).toBe(false);
  });

  it("error de cuota calibra el tope de 5 h y bloquea; un éxito posterior limpia el bloqueo", async () => {
    const a = await createAccount("A", NOW);
    await recordAgyCall(a.id, ok(5000), "chat", NOW - 1 * HOUR_MS);
    await recordAgyCall(a.id, quota("2026-10-06T14:00:00Z"), "chat", NOW);
    let [v] = await listAccounts(NOW);
    expect(v.calibratedLimit5h).toBe(5000);
    expect(v.quotaBlockedUntil).toBe("2026-10-06T14:00:00.000Z");
    expect(v.usage.short.pct).toBe(100);
    expect(v.warn).toEqual({ warn: true, reason: "Cuota agotada: conviene cambiar de cuenta" });

    await recordAgyCall(a.id, ok(10), "chat", NOW + 1000);
    [v] = await listAccounts(NOW + 1000);
    expect(v.quotaBlockedUntil).toBeNull();
  });

  it("el tope manual manda en el porcentaje", async () => {
    const a = await createAccount("A", NOW);
    await recordAgyCall(a.id, ok(900), "chat", NOW - HOUR_MS);
    const v = await updateAccount(a.id, { manualLimit5h: 1000 }, NOW);
    expect(v.usage.short).toMatchObject({ limitSource: "manual", pct: 90 });
    expect(v.warn.warn).toBe(true);
  });

  it("borrar una cuenta borra su consumo; si era la activa, activa otra", async () => {
    const a = await createAccount("A", NOW);
    const b = await createAccount("B", NOW);
    await recordAgyCall(a.id, ok(10), "chat", NOW);
    await deleteAccount(a.id);
    const rows = await db.select().from(schema.agyUsage);
    expect(rows).toHaveLength(0);
    expect((await getActiveAccount())?.id).toBe(b.id);
  });
});
```

- [ ] **Step 4: Correr y verificar que fallan**

Run: `npx vitest run test/server/agy-accounts.test.ts test/lib/agy-terminal.test.ts`
Expected: FAIL (módulos y tablas inexistentes).

- [ ] **Step 5: Esquema**

En `src/db/schema.ts` agregar:

```ts
export const agyAccounts = sqliteTable("agy_accounts", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  active: integer("active").notNull().default(0),
  manualLimit5h: integer("manual_limit_5h"),
  manualLimit7d: integer("manual_limit_7d"),
  calibratedLimit5h: integer("calibrated_limit_5h"),
  quotaBlockedUntil: text("quota_blocked_until"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

/** Consumo de cada llamada a agy (chat, plan o análisis), ligado a la cuenta activa. `at` en ISO. */
export const agyUsage = sqliteTable("agy_usage", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => agyAccounts.id),
  at: text("at").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  source: text("source").notNull(),
});
```

En `src/db/migrate.ts`, al final de `SCHEMA_SQL` (antes del backtick de cierre) agregar:

```sql
CREATE TABLE IF NOT EXISTS agy_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  manual_limit_5h INTEGER,
  manual_limit_7d INTEGER,
  calibrated_limit_5h INTEGER,
  quota_blocked_until TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agy_usage (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES agy_accounts(id),
  at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agy_usage_account_at ON agy_usage(account_id, at);
```

- [ ] **Step 6: Crear `src/lib/agy-terminal.ts`**

```ts
import { spawn } from "node:child_process";

/** Comando para abrir una consola visible con agy interactivo (login/logout oficial). */
export function buildTerminalCommand(exe: string): { command: string; args: string[] } {
  return { command: "cmd.exe", args: ["/c", `start "Antigravity - cambiar cuenta" "${exe}"`] };
}

/** `exe` sale de resolveAgyPath(), nunca de datos del usuario. */
export function openAgyTerminal(exe: string): void {
  if (process.platform !== "win32") throw new Error("Abrir la terminal de agy solo está implementado en Windows");
  const { command, args } = buildTerminalCommand(exe);
  spawn(command, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
}
```

- [ ] **Step 7: Crear `src/server/agy-accounts.ts`**

```ts
import { randomUUID } from "node:crypto";
import { eq, and, gte, ne } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { broadcast } from "./ws.js";
import type { AdapterExecutionResult } from "../lib/types.js";
import {
  HOUR_MS, WINDOWS, windowUsage, warnState, calibrateOnQuota, blockUntil,
  type UsagePoint, type WindowUsage, type WarnState,
} from "../lib/usage-meter.js";

export type AgyAccountRow = typeof schema.agyAccounts.$inferSelect;

export interface AccountView {
  id: string;
  label: string;
  active: boolean;
  manualLimit5h: number | null;
  manualLimit7d: number | null;
  calibratedLimit5h: number | null;
  quotaBlockedUntil: string | null;
  notes: string | null;
  usage: { short: WindowUsage; long: WindowUsage };
  warn: WarnState;
}

export class NoActiveAccountError extends Error {
  constructor() {
    super("No hay cuenta de Antigravity activa: agrega o activa una en el panel de cuentas.");
  }
}

export class AccountValidationError extends Error {}

function validLabel(label: string): string {
  const t = label.trim();
  if (!t || t.length > 80) throw new AccountValidationError("La etiqueta debe tener entre 1 y 80 caracteres");
  return t;
}

function validLimit(v: number | null | undefined): number | null | undefined {
  if (v === undefined || v === null) return v;
  if (!Number.isInteger(v) || v <= 0) throw new AccountValidationError("El tope debe ser un entero positivo de tokens");
  return v;
}

async function usagePoints(accountId: string, now: number): Promise<UsagePoint[]> {
  const from = new Date(now - WINDOWS.long * HOUR_MS).toISOString();
  const rows = await db.select().from(schema.agyUsage)
    .where(and(eq(schema.agyUsage.accountId, accountId), gte(schema.agyUsage.at, from)));
  return rows.map((r) => ({ at: Date.parse(r.at), tokens: r.inputTokens + r.outputTokens }));
}

async function toView(row: AgyAccountRow, now: number): Promise<AccountView> {
  const points = await usagePoints(row.id, now);
  const blocked = row.quotaBlockedUntil ? Date.parse(row.quotaBlockedUntil) : null;
  let short = windowUsage(points, now, WINDOWS.short, row.manualLimit5h, row.calibratedLimit5h);
  // Bloqueo vigente: la ventana corta se muestra llena aunque el tope estimado diga otra cosa.
  if (blocked !== null && blocked > now) short = { ...short, pct: 100, resetsAt: blocked };
  const long = windowUsage(points, now, WINDOWS.long, row.manualLimit7d, null);
  return {
    id: row.id,
    label: row.label,
    active: row.active === 1,
    manualLimit5h: row.manualLimit5h,
    manualLimit7d: row.manualLimit7d,
    calibratedLimit5h: row.calibratedLimit5h,
    quotaBlockedUntil: row.quotaBlockedUntil,
    notes: row.notes,
    usage: { short, long },
    warn: warnState([short, long], blocked, now),
  };
}

function notify() {
  broadcast({ type: "accounts:changed", timestamp: new Date().toISOString() } as any);
}

async function getRow(id: string): Promise<AgyAccountRow> {
  const row = await db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.id, id)).then((r) => r[0]);
  if (!row) throw new AccountValidationError("Cuenta no encontrada");
  return row;
}

export async function listAccounts(now: number = Date.now()): Promise<AccountView[]> {
  const rows = await db.select().from(schema.agyAccounts).orderBy(schema.agyAccounts.createdAt);
  return Promise.all(rows.map((r) => toView(r, now)));
}

export async function getActiveAccount(): Promise<AgyAccountRow | null> {
  return db.select().from(schema.agyAccounts).where(eq(schema.agyAccounts.active, 1)).then((r) => r[0] ?? null);
}

export async function requireActiveAccount(): Promise<AgyAccountRow> {
  const row = await getActiveAccount();
  if (!row) throw new NoActiveAccountError();
  return row;
}

export async function createAccount(label: string, now: number = Date.now()): Promise<AccountView> {
  const clean = validLabel(label);
  const hasActive = (await getActiveAccount()) !== null;
  const id = randomUUID();
  await db.insert(schema.agyAccounts).values({ id, label: clean, active: hasActive ? 0 : 1, createdAt: new Date(now).toISOString() });
  notify();
  return toView(await getRow(id), now);
}

export async function activateAccount(id: string): Promise<void> {
  await getRow(id);
  await db.update(schema.agyAccounts).set({ active: 0 }).where(ne(schema.agyAccounts.id, id));
  await db.update(schema.agyAccounts).set({ active: 1 }).where(eq(schema.agyAccounts.id, id));
  notify();
}

export async function updateAccount(
  id: string,
  patch: { label?: string; manualLimit5h?: number | null; manualLimit7d?: number | null; notes?: string | null },
  now: number = Date.now(),
): Promise<AccountView> {
  await getRow(id);
  const set: Partial<AgyAccountRow> = {};
  if (patch.label !== undefined) set.label = validLabel(patch.label);
  if (patch.manualLimit5h !== undefined) set.manualLimit5h = validLimit(patch.manualLimit5h) ?? null;
  if (patch.manualLimit7d !== undefined) set.manualLimit7d = validLimit(patch.manualLimit7d) ?? null;
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null;
  if (Object.keys(set).length) await db.update(schema.agyAccounts).set(set).where(eq(schema.agyAccounts.id, id));
  notify();
  return toView(await getRow(id), now);
}

export async function deleteAccount(id: string): Promise<void> {
  const row = await getRow(id);
  await db.delete(schema.agyUsage).where(eq(schema.agyUsage.accountId, id));
  await db.delete(schema.agyAccounts).where(eq(schema.agyAccounts.id, id));
  if (row.active === 1) {
    const next = await db.select().from(schema.agyAccounts).orderBy(schema.agyAccounts.createdAt).then((r) => r[0]);
    if (next) await db.update(schema.agyAccounts).set({ active: 1 }).where(eq(schema.agyAccounts.id, next.id));
  }
  notify();
}

/** Registra el consumo de una llamada a agy; calibra y bloquea si fue error de cuota. */
export async function recordAgyCall(
  accountId: string,
  result: AdapterExecutionResult,
  source: "chat" | "plan" | "analysis",
  now: number = Date.now(),
): Promise<void> {
  const row = await getRow(accountId);
  await db.insert(schema.agyUsage).values({
    id: randomUUID(),
    accountId,
    at: new Date(now).toISOString(),
    inputTokens: result.inputTokens || 0,
    outputTokens: result.outputTokens || 0,
    source,
  });

  if (result.errorFamily === "quota_exhausted") {
    const points = await usagePoints(accountId, now);
    await db.update(schema.agyAccounts).set({
      calibratedLimit5h: calibrateOnQuota(points, now, row.calibratedLimit5h),
      quotaBlockedUntil: new Date(blockUntil(result.retryNotBefore, now)).toISOString(),
    }).where(eq(schema.agyAccounts.id, accountId));
  } else if (result.exitCode === 0 && row.quotaBlockedUntil) {
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: null }).where(eq(schema.agyAccounts.id, accountId));
  }
  notify();
}
```

- [ ] **Step 8: Correr tests del repositorio y terminal**

Run: `npx vitest run test/server/agy-accounts.test.ts test/lib/agy-terminal.test.ts`
Expected: PASS.

- [ ] **Step 9: Crear `src/server/routes/accounts.ts` y montarla**

```ts
import { Hono } from "hono";
import {
  listAccounts, createAccount, activateAccount, updateAccount, deleteAccount, getActiveAccount, AccountValidationError,
} from "../agy-accounts.js";
import { resolveAgyPath } from "../../lib/agy-path.js";
import { openAgyTerminal } from "../../lib/agy-terminal.js";

const app = new Hono();

const fail = (err: unknown) =>
  err instanceof AccountValidationError ? { status: 400 as const, error: err.message } : { status: 500 as const, error: String((err as Error)?.message ?? err) };

app.get("/", async (c) => c.json(await listAccounts()));

app.get("/active", async (c) => {
  const row = await getActiveAccount();
  if (!row) return c.json({ account: null });
  const account = (await listAccounts()).find((a) => a.id === row.id) ?? null;
  return c.json({ account });
});

app.post("/", async (c) => {
  try {
    const body = await c.req.json<{ label?: string }>();
    return c.json(await createAccount(body.label ?? ""), 201);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.post("/switch-terminal", async (c) => {
  const exe = resolveAgyPath();
  if (!exe) return c.json({ error: "agy no encontrado: instala Antigravity CLI o define AGY_PATH" }, 404);
  try {
    openAgyTerminal(exe);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 501);
  }
});

app.post("/:id/activate", async (c) => {
  try {
    await activateAccount(c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status === 400 ? 404 : 500);
  }
});

app.patch("/:id", async (c) => {
  try {
    const body = await c.req.json<{ label?: string; manualLimit5h?: number | null; manualLimit7d?: number | null; notes?: string | null }>();
    return c.json(await updateAccount(c.req.param("id"), body));
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.delete("/:id", async (c) => {
  try {
    await deleteAccount(c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status === 400 ? 404 : 500);
  }
});

export default app;
```

En `src/server/index.ts`: `import accountsRoute from "./routes/accounts.js";` y `app.route("/api/accounts", accountsRoute);`.

- [ ] **Step 10: Registrar consumo en chat, plan y análisis**

`src/server/runner.ts` — importar `{ requireActiveAccount, recordAgyCall } from "./agy-accounts.js"` y en `executeInBackground`:
- declarar `let agyAccountId: string | null = null;` antes del `try`;
- dentro del `try`, antes de `adapter.execute`: `if (input.adapter === "agy") agyAccountId = (await requireActiveAccount()).id;` (si no hay cuenta, el `catch` existente produce el error con el mensaje de `NoActiveAccountError`);
- después del bloque try/catch y antes de calcular `status`:
  ```ts
  if (agyAccountId) {
    try { await recordAgyCall(agyAccountId, result, "chat"); } catch (err) { log.error({ err, runId }, "No se pudo registrar el consumo de agy"); }
  }
  ```

`src/server/plan-runner.ts` — importar `{ getActiveAccount, recordAgyCall, NoActiveAccountError }` de `./agy-accounts.js`. Tras marcar el paso como `running`:
  ```ts
  const agyAccount = step.adapter === "agy" ? await getActiveAccount() : null;
  if (step.adapter === "agy" && !agyAccount) {
    const msg = new NoActiveAccountError().message;
    await db.update(schema.planSteps).set({ status: "failed", errorMessage: msg, finishedAt: new Date().toISOString() }).where(eq(schema.planSteps.id, stepId));
    broadcast({ type: "plan:step", planId, stepId, status: "failed", error: msg, timestamp: new Date().toISOString() } as any);
    return;
  }
  ```
  y justo después de `const result = await adapter.execute({...})`:
  ```ts
  if (agyAccount) {
    try { await recordAgyCall(agyAccount.id, result, "plan"); } catch (err) { log.error({ err, stepId }, "No se pudo registrar el consumo de agy"); }
  }
  ```

`src/server/routes/analyze.ts` — importar `{ getActiveAccount, recordAgyCall }` de `../agy-accounts.js`; al inicio del handler (tras validar `files`):
  ```ts
  const account = await getActiveAccount();
  if (!account) return c.json({ error: "Sin cuenta activa de Antigravity", fallback: true }, 200);
  ```
  y después de `execute(...)`: `await recordAgyCall(account.id, result, "analysis");`.

- [ ] **Step 11: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: cuentas de Antigravity, registro de consumo por cuenta y API de cuentas"
git push
```

---

### Task 6: Pausa por cuota en planes

**Files:**
- Modify: `src/server/plan-runner.ts`, `ui/src/components/PlanView.tsx`
- Test: `test/server/plan-runner-quota.test.ts`

**Interfaces:**
- Consumes: `recordAgyCall`, `createAccount` (Task 5); `runPlanStep`, `runPlanAll` existentes.
- Produces: `export const QUOTA_PAUSE_PREFIX = "Pausado por cuota";` en `plan-runner.ts`; evento `plan:step` con `status: "pending"` y `error` con el prefijo; evento `plan:done` con `status: "pending", paused: "quota"`.

- [ ] **Step 1: Escribir `test/server/plan-runner-quota.test.ts`**

```ts
import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AdapterExecutionResult } from "../../src/lib/types.js";

const quotaResult: AdapterExecutionResult = {
  exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "", summary: "", sessionId: null, model: null,
  costUsd: 0, inputTokens: 0, outputTokens: 0, errorMessage: "429 quota exceeded", errorFamily: "quota_exhausted", retryNotBefore: null,
};
const execute = vi.fn(async () => quotaResult);

vi.mock("../../src/adapters/registry.js", () => ({
  getAdapter: (t: string) => (t === "agy" ? { meta: { type: "agy" }, detect: async () => ({ available: true, resolvedPath: "x" }), execute } : undefined),
  adapters: {},
}));

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanAll, QUOTA_PAUSE_PREFIX } = await import("../../src/server/plan-runner.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => { await migrationDone; });

describe("pausa por cuota", () => {
  it("un paso agy con quota_exhausted no reintenta, vuelve a pending y el plan queda pending", async () => {
    await createAccount("Prueba");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
    const planId = randomUUID();
    const stepId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "p", status: "pending" });
    await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "d", adapter: "agy", prompt: "x", status: "pending" });

    await runPlanAll(planId, cwd);

    expect(execute).toHaveBeenCalledTimes(1);
    const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
    expect(step.status).toBe("pending");
    expect(step.errorMessage?.startsWith(QUOTA_PAUSE_PREFIX)).toBe(true);
    const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
    expect(plan.status).toBe("pending");
    const usage = await db.select().from(schema.agyUsage);
    expect(usage).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run test/server/plan-runner-quota.test.ts`
Expected: FAIL (`QUOTA_PAUSE_PREFIX` no existe; el paso termina `failed` o reintenta).

- [ ] **Step 3: Implementar en `src/server/plan-runner.ts`**

- Exportar `export const QUOTA_PAUSE_PREFIX = "Pausado por cuota";`.
- Al marcar el paso `running`, limpiar el error anterior: `.set({ status: "running", startedAt: …, errorMessage: null })`.
- Inmediatamente después del registro de consumo de agy (Task 5) y **antes** de cualquier lógica de reintento (la de `isTransient` coincide con 429), agregar:
  ```ts
  if (step.adapter === "agy" && result.errorFamily === "quota_exhausted") {
    const msg = `${QUOTA_PAUSE_PREFIX} en la cuenta "${agyAccount?.label ?? "?"}": cambia de cuenta en el panel y vuelve a ejecutar el plan.`;
    await db.update(schema.runs).set({ status: "failed", errorMessage: result.errorMessage, errorFamily: result.errorFamily, finishedAt: new Date().toISOString() }).where(eq(schema.runs.id, runId));
    await db.update(schema.tasks).set({ status: "failed", updatedAt: new Date().toISOString() }).where(eq(schema.tasks.id, taskId));
    await db.update(schema.planSteps).set({ status: "pending", errorMessage: msg, runId }).where(eq(schema.planSteps.id, stepId));
    broadcast({ type: "plan:step", planId, stepId, status: "pending", error: msg, timestamp: new Date().toISOString() } as any);
    return;
  }
  ```
- En `runPlanAll`, después del re-fetch de `updated` y antes del chequeo de `failed`:
  ```ts
  if (updated?.status === "pending" && updated.errorMessage?.startsWith(QUOTA_PAUSE_PREFIX)) {
    stopWatch(planId);
    await db.update(schema.plans).set({ status: "pending", updatedAt: new Date().toISOString() }).where(eq(schema.plans.id, planId));
    broadcast({ type: "plan:done", planId, status: "pending", paused: "quota", timestamp: new Date().toISOString() } as any);
    return;
  }
  ```

- [ ] **Step 4: UI de PlanView**

En `ui/src/components/PlanView.tsx`:
- estado nuevo `const [quotaPaused, setQuotaPaused] = useState(false);`;
- en el manejador de `plan:done`: `setQuotaPaused(e.status === "pending" && e.paused === "quota");` y al iniciar `handleRunAll`/`handleRunNext`/`handleResume`: `setQuotaPaused(false);`;
- encima de los controles de ejecución del plan, renderizar:
  ```tsx
  {quotaPaused && (
    <div role="status" className="mx-4 my-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 font-mono text-[11px] text-text-primary">
      Plan pausado por cuota de Antigravity. Cambia de cuenta en el panel de cuentas y pulsa «ejecutar» para seguir desde el paso pendiente.
    </div>
  )}
  ```
  Si `border-warn`/`bg-warn` no existen en el tema (`ui/src/index.css`), usar los tokens de advertencia que el tema sí tenga (buscar `--color-` en `index.css`) — no inventar colores sueltos.
- confirmar que con `plan.status === "pending"` el botón de ejecutar todo está visible; si no, mostrarlo también en ese caso.

- [ ] **Step 5: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck && npm run build:ui`
Expected: PASS.

```bash
git add -A
git commit -m "feat: pausar el plan por cuota de Antigravity en vez de fallar"
git push
```

---

### Task 7: HUD superior y panel de cuentas

**Files:**
- Create: `ui/src/lib/format.ts`, `ui/src/lib/accounts-api.ts`, `ui/src/components/HudBar.tsx`, `ui/src/components/AccountsPanel.tsx`, `test/ui/format.test.ts`
- Modify: `src/server/routes/usage.ts` (`GET /session`), `ui/src/App.tsx`, `ui/src/context/WebSocketProvider.tsx`

**Interfaces:**
- Consumes: API de cuentas (Task 5) — `AccountView` JSON; evento `accounts:changed`.
- Produces: `GET /api/usage/session` → `{ since: string; tokens: number }`; `formatTokens(n: number): string`, `formatIn(ms: number): string`.

- [ ] **Step 1: Tests de formato** — `test/ui/format.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { formatTokens, formatIn } from "../../ui/src/lib/format.js";

describe("formato", () => {
  it("tokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(11_710)).toBe("11.7k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
  it("tiempo restante", () => {
    expect(formatIn(0)).toBe("ya");
    expect(formatIn(35 * 60_000)).toBe("35 min");
    expect(formatIn(2 * 3_600_000 + 10 * 60_000)).toBe("2 h 10 min");
    expect(formatIn(3 * 3_600_000)).toBe("3 h");
  });
});
```

- [ ] **Step 2: Correr y verificar que falla; crear `ui/src/lib/format.ts`**

Run: `npx vitest run test/ui/format.test.ts` → FAIL.

```ts
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatIn(ms: number): string {
  if (ms <= 0) return "ya";
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
```

Run: `npx vitest run test/ui/format.test.ts` → PASS.

- [ ] **Step 3: Endpoint de tokens de la sesión** (`src/server/routes/usage.ts`)

```ts
const SERVER_STARTED_AT = new Date().toISOString();

/** GET /api/usage/session — tokens de todos los adapters desde que arrancó el servidor. */
app.get("/session", async (c) => {
  const runsRows = await db.all<{ tokens: number }>(sql`
    SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens
    FROM runs WHERE datetime(started_at) >= datetime(${SERVER_STARTED_AT})
  `);
  const analysisRows = await db.all<{ tokens: number }>(sql`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
    FROM agy_usage WHERE source = 'analysis' AND at >= ${SERVER_STARTED_AT}
  `);
  return c.json({ since: SERVER_STARTED_AT, tokens: Number(runsRows[0]?.tokens ?? 0) + Number(analysisRows[0]?.tokens ?? 0) });
});
```

(colocarlo antes de `export default app;`).

- [ ] **Step 4: `ui/src/lib/accounts-api.ts`**

```ts
export interface WindowUsage {
  windowHours: number;
  usedTokens: number;
  limitTokens: number | null;
  limitSource: "manual" | "calibrated" | null;
  pct: number | null;
  resetsAt: number | null;
}

export interface AccountView {
  id: string;
  label: string;
  active: boolean;
  manualLimit5h: number | null;
  manualLimit7d: number | null;
  calibratedLimit5h: number | null;
  quotaBlockedUntil: string | null;
  notes: string | null;
  usage: { short: WindowUsage; long: WindowUsage };
  warn: { warn: boolean; reason: string | null };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const accountsApi = {
  list: () => fetch("/api/accounts").then((r) => json<AccountView[]>(r)),
  active: () => fetch("/api/accounts/active").then((r) => json<{ account: AccountView | null }>(r)),
  create: (label: string) =>
    fetch("/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) }).then((r) => json<AccountView>(r)),
  activate: (id: string) => fetch(`/api/accounts/${id}/activate`, { method: "POST" }).then((r) => json<void>(r)),
  update: (id: string, patch: Partial<Pick<AccountView, "label" | "manualLimit5h" | "manualLimit7d" | "notes">>) =>
    fetch(`/api/accounts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => json<AccountView>(r)),
  remove: (id: string) => fetch(`/api/accounts/${id}`, { method: "DELETE" }).then((r) => json<void>(r)),
  openSwitchTerminal: () => fetch("/api/accounts/switch-terminal", { method: "POST" }).then((r) => json<{ ok: true }>(r)),
  session: () => fetch("/api/usage/session").then((r) => json<{ since: string; tokens: number }>(r)),
};
```

- [ ] **Step 5: `ui/src/components/HudBar.tsx`**

```tsx
import { useQuery } from "@tanstack/react-query";
import { accountsApi } from "../lib/accounts-api";
import { formatIn, formatTokens } from "../lib/format";

export function HudBar() {
  const { data: activeData } = useQuery({ queryKey: ["accounts", "active"], queryFn: accountsApi.active, refetchInterval: 60_000 });
  const { data: session } = useQuery({ queryKey: ["usage", "session"], queryFn: accountsApi.session, refetchInterval: 60_000 });
  const account = activeData?.account ?? null;
  const short = account?.usage.short;

  return (
    <header className="flex items-center gap-4 border-b border-edge bg-surface-1 px-4 py-1.5 font-mono text-[11px] text-text-secondary" aria-label="Estado del orquestador">
      <span className="text-text-tertiary">antigravity</span>
      {account ? (
        <>
          <span className="text-text-primary">{account.label}</span>
          {short && (
            <span className="flex items-center gap-2" title="Estimación local: Google no publica la cuota">
              {short.pct !== null ? (
                <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                  <span className={`absolute inset-y-0 left-0 ${short.pct >= 85 ? "bg-err" : "bg-ok"}`} style={{ width: `${short.pct}%` }} />
                </span>
              ) : null}
              <span>
                {short.pct !== null ? `~${short.pct} %` : `${formatTokens(short.usedTokens)} tok (sin tope)`} · estimado
                {short.resetsAt ? ` · se reinicia en ${formatIn(short.resetsAt - Date.now())}` : ""}
              </span>
            </span>
          )}
          {account.warn.warn && (
            <span role="alert" className="rounded border border-err/40 px-1.5 py-0.5 text-err">{account.warn.reason}</span>
          )}
        </>
      ) : (
        <span>sin cuenta activa — agrégala en el panel de cuentas</span>
      )}
      <span className="ml-auto" title="Tokens de todos los adapters desde que arrancó el servidor">
        sesión: {formatTokens(session?.tokens ?? 0)} tok
      </span>
    </header>
  );
}
```

- [ ] **Step 6: `ui/src/components/AccountsPanel.tsx`**

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountsApi, type AccountView, type WindowUsage } from "../lib/accounts-api";
import { formatIn, formatTokens } from "../lib/format";

function UsageLine({ w, name }: { w: WindowUsage; name: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 text-text-tertiary">{name}</span>
      <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {w.pct !== null && <span className={`absolute inset-y-0 left-0 ${w.pct >= 85 ? "bg-err" : "bg-ok"}`} style={{ width: `${w.pct}%` }} />}
      </span>
      <span className="w-28 text-right">
        {w.pct !== null ? `~${w.pct} %` : `${formatTokens(w.usedTokens)} tok`}
        {w.resetsAt ? ` · ${formatIn(w.resetsAt - Date.now())}` : ""}
      </span>
    </div>
  );
}

function LimitInput({ label, value, onSave }: { label: string; value: number | null; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value?.toString() ?? "");
  return (
    <label className="flex items-center gap-2">
      <span className="w-20 text-text-tertiary">{label}</span>
      <input
        inputMode="numeric"
        className="w-24 rounded border border-edge bg-surface-0 px-1.5 py-0.5 text-text-primary"
        value={draft}
        placeholder="auto"
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => onSave(draft ? Number(draft) : null)}
      />
    </label>
  );
}

function AccountCard({ a }: { a: AccountView }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });
  const activate = useMutation({ mutationFn: () => accountsApi.activate(a.id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => accountsApi.remove(a.id), onSuccess: refresh });
  const update = useMutation({ mutationFn: (p: Parameters<typeof accountsApi.update>[1]) => accountsApi.update(a.id, p), onSuccess: refresh });

  return (
    <li className={`space-y-1.5 rounded-lg border px-3 py-2 ${a.active ? "border-ok/50" : "border-edge"}`}>
      <div className="flex items-center gap-2">
        <span className="truncate text-text-primary">{a.label}</span>
        {a.active && <span className="text-ok">activa</span>}
        <span className="ml-auto flex gap-2">
          {!a.active && <button className="hover:text-text-primary" onClick={() => activate.mutate()}>usar esta</button>}
          <button
            className="hover:text-err"
            onClick={() => { if (confirm(`¿Eliminar la cuenta "${a.label}" y su historial de uso?`)) remove.mutate(); }}
          >
            eliminar
          </button>
        </span>
      </div>
      <UsageLine w={a.usage.short} name="5 h" />
      <UsageLine w={a.usage.long} name="7 d" />
      {a.warn.warn && <p role="alert" className="text-err">{a.warn.reason}</p>}
      <details>
        <summary className="cursor-pointer text-text-tertiary">topes (tokens)</summary>
        <div className="mt-1 space-y-1">
          <LimitInput label="5 h manual" value={a.manualLimit5h} onSave={(v) => update.mutate({ manualLimit5h: v })} />
          <LimitInput label="7 d manual" value={a.manualLimit7d} onSave={(v) => update.mutate({ manualLimit7d: v })} />
          <p className="text-text-tertiary">calibrado 5 h: {a.calibratedLimit5h ? formatTokens(a.calibratedLimit5h) : "aún no (se fija con el primer error de cuota)"}</p>
        </div>
      </details>
      {update.error && <p className="text-err">{(update.error as Error).message}</p>}
    </li>
  );
}

export function AccountsPanel() {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list, refetchInterval: 60_000 });
  const [label, setLabel] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => accountsApi.create(label),
    onSuccess: () => { setLabel(""); qc.invalidateQueries({ queryKey: ["accounts"] }); },
  });
  const openTerminal = useMutation({
    mutationFn: accountsApi.openSwitchTerminal,
    onSuccess: () => setHint("Se abrió agy en una terminal: cierra sesión ahí, entra con la otra cuenta y luego marca aquí cuál quedó activa."),
    onError: (e) => setHint((e as Error).message),
  });

  return (
    <section aria-labelledby="cuentas-titulo" className="space-y-2 border-t border-edge px-4 py-3 font-mono text-[11px] text-text-secondary">
      <div className="flex items-center">
        <h2 id="cuentas-titulo" className="text-text-tertiary">cuentas antigravity</h2>
        <button className="ml-auto hover:text-text-primary" onClick={() => openTerminal.mutate()}>cambiar cuenta</button>
      </div>
      {hint && <p role="status" className="text-text-primary">{hint}</p>}
      <ul className="space-y-2">{accounts.map((a) => <AccountCard key={a.id} a={a} />)}</ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => { e.preventDefault(); if (label.trim()) create.mutate(); }}
      >
        <input
          aria-label="Etiqueta de la cuenta nueva"
          className="flex-1 rounded border border-edge bg-surface-0 px-1.5 py-0.5 text-text-primary"
          placeholder="p. ej. Familia A · usuario 2"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="hover:text-text-primary">agregar</button>
      </form>
      {create.error && <p className="text-err">{(create.error as Error).message}</p>}
      <p className="text-text-tertiary">El uso es una estimación local. El orquestador nunca cambia de cuenta solo.</p>
    </section>
  );
}
```

Verificar que las clases de color usadas (`text-ok`, `bg-ok`, `text-err`, `bg-err`, `border-edge`, `bg-surface-0/1/2`, `text-text-*`) existen en `ui/src/index.css` (las usa `App.tsx`/`AdapterPanel.tsx`); si alguna variante con opacidad (`border-ok/50`, `border-err/40`) no compila en Tailwind 4 con esos tokens, usar la variante sólida.

- [ ] **Step 7: Integración**

- `ui/src/App.tsx`: el contenedor raíz pasa a `flex h-screen w-screen flex-col overflow-hidden bg-surface-0`; `<HudBar />` como primer hijo; el `ResizableGroup` conserva `flex-1 overflow-hidden` (agregar `min-h-0`). En el `<aside>` izquierdo, debajo de `<AdapterPanel />`, envolver ambos en un contenedor `flex-1 overflow-y-auto` y agregar `<AccountsPanel />` después de `<AdapterPanel />`.
- `ui/src/context/WebSocketProvider.tsx`: junto a los otros `invalidateQueries`, agregar
  ```ts
  if (event.type === "accounts:changed") {
    queryClient.invalidateQueries({ queryKey: ["accounts"] });
  }
  ```
  y dentro del bloque existente de `run:status` agregar `queryClient.invalidateQueries({ queryKey: ["usage", "session"] });`.

- [ ] **Step 8: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck && npm run build:ui`
Expected: PASS.

```bash
git add -A
git commit -m "feat: HUD superior y panel de cuentas de Antigravity"
git push
```

---

### Task 8: Verificación final de F1 (en vivo) y documentación

**Files:**
- Modify: `CLAUDE.md`, `CONTINUAR.md`, `C:\Users\sidel\Documents\Cerebro\20-Personal\Orquestador-IA.md`, `C:\Users\sidel\Documents\Cerebro\00-INICIO.md`

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run lint && npm run typecheck && npm run build:ui`
Expected: todo verde.

- [ ] **Step 2: Arranque y API**

Con una base temporal para no tocar la real: `ORQUESTADOR_DATA_DIR=<tmp> npm start` en segundo plano; luego:
- `curl -s http://127.0.0.1:3100/api/adapters` → `claude`, `codex`, `agy` (sin `gemini`), `agy.available: true`.
- `curl -s -X POST http://127.0.0.1:3100/api/accounts -H "Content-Type: application/json" -d '{"label":"Prueba"}'` → 201, `active: true`.
- Crear una tarea con adapter `agy` y modelo `gemini-3.8-flash-low`, prompt "Responde solo con la palabra: ok" (`POST /api/tasks` y `POST /api/tasks/:id/run`, mismo contrato que usa `Chat.tsx`), esperar `succeeded` en `GET /api/runs`, y comprobar que `GET /api/accounts` muestra `usage.short.usedTokens > 0`. (Gasta 1 llamada de la cuenta de prueba.)

- [ ] **Step 3: UI en el panel de navegador**

Abrir `http://127.0.0.1:3100`: el HUD muestra "Prueba" con tokens "(sin tope)" y "sesión: …"; el panel de cuentas lista la cuenta; poner tope manual 5 h = 20000 y comprobar que aparece "~N %"; revisar consola sin errores. Detener el servidor y borrar la base temporal.

- [ ] **Step 4: Documentación**

- `CLAUDE.md`: sección "Antigravity accounts" (tablas `agy_accounts`/`agy_usage`, rutas `/api/accounts`, medidor estimado, pausa por cuota, nunca cambio automático).
- `CONTINUAR.md`: estado F1 en español (qué se agregó y cómo se usa el panel).
- Cerebro `Orquestador-IA.md`: Estado "F1 hecho <fecha>"; Siguiente paso "F2: plan como DAG en paralelo + síntesis de Opus"; actualizar `actualizado:`. `00-INICIO.md`: línea del proyecto "(F1 hecho; F2 siguiente)".

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: F1 verificado en vivo y documentado"
git push
```
