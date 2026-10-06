# F0 — Rescate y base · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dejar el orquestador con red de seguridad (tests, lint, typecheck), modelos vigentes en un solo catálogo, sin rutas de la laptop, y con el spike de `agy` documentado para diseñar F1.

**Architecture:** No se cambia la arquitectura (Hono + React + SQLite + adapters por CLI). Se agregan: vitest con tests de caracterización sobre funciones puras (parsers, quoting, extracción de JSON del planner), un catálogo único de modelos `src/config/models.ts`, un resolvedor de la skill caveman que no dependa de un hash fijo, y un documento de spike de `agy`.

**Tech Stack:** Node 24 · TypeScript 5.7 (ESM, `moduleResolution: bundler`) · tsx · vitest · ESLint 9 (flat config) + typescript-eslint · Hono · Drizzle/libsql.

## Global Constraints

- Idioma de docs, mensajes de commit y textos de UI: español de México.
- Repo: `C:\estudio\orquestador-ia` (rama `main`). Commit + push al terminar cada tarea.
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Modelo del planner/sintetizador: `claude-opus-5-5`.
- Antigravity: solo el binario oficial `agy`, sin modificar, como proceso hijo. **Nunca** leer, copiar ni reenviar credenciales/tokens; nunca llamar endpoints de Google directamente; no usar switchers de terceros.
- Línea base verificada (2026-10-06): `npx tsc --noEmit` pasa limpio en raíz y en `ui/`. Ninguna tarea puede dejarlo peor.
- npm 11 bloquea scripts de instalación (`allow-scripts`). Si `tsx`/`esbuild` fallan tras instalar algo, correr `npm approve-scripts esbuild`.
- Lo que se instale desde la sesión de Claude en `%LOCALAPPDATA%`/`%APPDATA%` queda virtualizado (MSIX) e invisible fuera de la app: `agy` lo instala el usuario en su propia terminal.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `package.json` | Modificar | scripts `test`, `lint`, `typecheck`, `smoke:models`; devDeps vitest/eslint |
| `vitest.config.ts` | Crear | config de tests (`test/**/*.test.ts`) |
| `eslint.config.js` | Crear | lint flat config para `src/` y `test/` |
| `test/helpers/proc.ts` | Crear | fabrica `RunProcessResult` para tests |
| `test/adapters/{claude,codex,gemini}-parse.test.ts` | Crear | caracterización de parsers |
| `src/lib/process-runner.ts` | Modificar | exportar `quoteWindowsArg` |
| `src/server/planner.ts` | Modificar | exportar `extractJsonFromOutput`; usar `PLANNER_MODEL` y catálogo |
| `test/lib/quote-windows-arg.test.ts` | Crear | regresión del bug del regex `/g` |
| `test/server/planner-extract.test.ts` | Crear | extracción de JSON del stream |
| `src/config/models.ts` | Crear | catálogo único de modelos y `PLANNER_MODEL` |
| `src/adapters/{claude,codex,gemini}/index.ts` | Modificar | leer modelos del catálogo |
| `test/config/models.test.ts` | Crear | invariantes del catálogo |
| `scripts/smoke-models.ts` | Crear | prueba real de cada modelo vía su adapter |
| `src/lib/caveman.ts` | Crear | `findCavemanSkill(home)` sin hash fijo |
| `src/server/runner.ts`, `src/server/routes/caveman.ts` | Modificar | usar `findCavemanSkill` |
| `test/lib/caveman.test.ts` | Crear | resolución con carpeta temporal |
| `CONTINUAR.md`, `ui/public/offline.html`, `CLAUDE.md` | Modificar | rutas y docs actualizadas |
| `docs/superpowers/specs/2026-10-06-spike-agy.md` | Crear | hallazgos del spike |
| `test/fixtures/agy/print-ok.json` | Crear | salida real de `agy -p` para el parser de F1 |

---

### Task 1: Red de seguridad — vitest, ESLint, typecheck y tests de parsers

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`, `eslint.config.js`, `test/helpers/proc.ts`
- Test: `test/adapters/claude-parse.test.ts`, `test/adapters/codex-parse.test.ts`, `test/adapters/gemini-parse.test.ts`

**Interfaces:**
- Consumes: `parse(proc: RunProcessResult): AdapterExecutionResult` de `src/adapters/*/parse.ts`; `RunProcessResult` de `src/lib/process-runner.ts`.
- Produces: `makeProc(partial: Partial<RunProcessResult>): RunProcessResult` en `test/helpers/proc.ts`; scripts `npm test`, `npm run lint`, `npm run typecheck`.

- [ ] **Step 1: Instalar dependencias de desarrollo**

```bash
cd C:\estudio\orquestador-ia
npm install -D vitest@^3 eslint@^9 typescript-eslint@^8 @eslint/js@^9 globals@^16
```

- [ ] **Step 2: Agregar scripts a `package.json`** (dentro de `"scripts"`, conservando los existentes)

```json
"test": "vitest run",
"test:watch": "vitest",
"lint": "eslint src test scripts",
"typecheck": "tsc --noEmit && cd ui && npx tsc --noEmit -p ."
```

- [ ] **Step 3: Crear `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Crear `eslint.config.js`**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["node_modules", "dist", "ui"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

- [ ] **Step 5: Crear `test/helpers/proc.ts`**

```ts
import type { RunProcessResult } from "../../src/lib/process-runner.js";

export function makeProc(partial: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    ...partial,
  };
}

export const jsonl = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o)).join("\n");
```

- [ ] **Step 6: Escribir `test/adapters/claude-parse.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parse } from "../../src/adapters/claude/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

describe("claude parse", () => {
  it("extrae resultado, sesión, costo y tokens del stream-json", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "system", session_id: "s-1", model: "claude-opus-5-5" },
        { type: "result", result: "hola", total_cost_usd: 0.012, usage: { input_tokens: 100, output_tokens: 20 }, session_id: "s-1" },
      ),
    }));
    expect(r.summary).toBe("hola");
    expect(r.sessionId).toBe("s-1");
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.costUsd).toBe(0.012);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(20);
    expect(r.errorMessage).toBeNull();
  });

  it("clasifica 429 como transient_upstream", () => {
    const r = parse(makeProc({ exitCode: 1, stderr: "429 Too Many Requests" }));
    expect(r.errorFamily).toBe("transient_upstream");
    expect(r.errorMessage).toBe("429 Too Many Requests");
  });

  it("timeout gana sobre cualquier otro error", () => {
    const r = parse(makeProc({ exitCode: 1, timedOut: true, stderr: "boom" }));
    expect(r.errorFamily).toBe("timeout");
    expect(r.errorMessage).toBe("Process timed out");
  });

  it("ignora líneas que no son JSON", () => {
    const r = parse(makeProc({ stdout: "basura\n" + jsonl({ result: "ok" }) }));
    expect(r.summary).toBe("ok");
  });
});
```

- [ ] **Step 7: Escribir `test/adapters/codex-parse.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parse } from "../../src/adapters/codex/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

describe("codex parse", () => {
  it("une los agent_message y lee tokens de turn.completed", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "thread.started", thread_id: "t-9" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "parte 1" } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "parte 2" } },
        { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } },
      ),
    }));
    expect(r.sessionId).toBe("t-9");
    expect(r.summary).toBe("parte 1\nparte 2");
    expect(r.inputTokens).toBe(50);
    expect(r.outputTokens).toBe(7);
  });

  it("desanida el mensaje de error que viene como JSON en string", () => {
    const r = parse(makeProc({
      exitCode: 1,
      stdout: jsonl({ type: "turn.failed", error: { message: JSON.stringify({ error: { message: "modelo no soportado" } }) } }),
    }));
    expect(r.errorMessage).toBe("modelo no soportado");
    expect(r.summary).toBe("Error: modelo no soportado");
    expect(r.errorFamily).toBe("unknown");
  });
});
```

- [ ] **Step 8: Escribir `test/adapters/gemini-parse.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parse } from "../../src/adapters/gemini/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

describe("gemini parse", () => {
  it("concatena deltas del asistente y toma tokens de result", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "init", session_id: "g-1", model: "gemini-2.5-flash" },
        { type: "message", role: "user", content: "hola" },
        { type: "message", role: "assistant", content: "Ho", delta: true },
        { type: "message", role: "assistant", content: "la", delta: true },
        { type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2 } },
      ),
    }));
    expect(r.sessionId).toBe("g-1");
    expect(r.summary).toBe("Hola");
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(2);
  });

  it("con modelo 'auto-*' toma el primer modelo no-lite de stats.models", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "init", session_id: "g-2", model: "auto-gemini-3" },
        { type: "result", status: "success", stats: { models: { "gemini-3-flash-lite": {}, "gemini-3-pro": {} } } },
      ),
    }));
    expect(r.model).toBe("gemini-3-pro");
  });
});
```

- [ ] **Step 9: Correr tests**

Run: `npm test`
Expected: 8 tests PASS. Son tests de caracterización del comportamiento actual: si alguno falla, el test está mal escrito respecto al código (corregir el test, no el parser), salvo que revele un bug real — en ese caso anotarlo en el commit y detenerse a preguntar.

- [ ] **Step 10: Correr lint y typecheck**

Run: `npm run lint` y luego `npm run typecheck`
Expected: typecheck limpio. Lint: corregir los errores que reporte en `src/` (los `any` quedan como warning). Si una regla genera más de 20 errores en código existente que no se toca en F0, bajarla a `"warn"` en `eslint.config.js` con un comentario `// TODO-F2: limpiar` y listarla en el mensaje de commit.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json vitest.config.ts eslint.config.js test/ src/
git commit -m "test: vitest, eslint y tests de caracterización de parsers"
git push
```

---

### Task 2: Funciones puras exportadas y blindadas (quoting y planner)

**Files:**
- Modify: `src/lib/process-runner.ts:8` (agregar `export`)
- Modify: `src/server/planner.ts:88` (agregar `export` a `extractJsonFromOutput`)
- Test: `test/lib/quote-windows-arg.test.ts`, `test/server/planner-extract.test.ts`

**Interfaces:**
- Produces: `export function quoteWindowsArg(arg: string): string`; `export function extractJsonFromOutput(stdout: string): any`.

- [ ] **Step 1: Escribir `test/lib/quote-windows-arg.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { quoteWindowsArg } from "../../src/lib/process-runner.js";

describe("quoteWindowsArg", () => {
  it("string vacío → par de comillas", () => expect(quoteWindowsArg("")).toBe('""'));
  it("arg simple no se toca", () => expect(quoteWindowsArg("--json")).toBe("--json"));
  it("arg con espacio se envuelve", () => expect(quoteWindowsArg("a b")).toBe('"a b"'));
  it("escapa TODAS las comillas (regresión del bug sin /g)", () =>
    expect(quoteWindowsArg('di "hola" y "adiós"')).toBe('"di \\"hola\\" y \\"adiós\\""'));
  it("duplica backslashes finales antes de la comilla de cierre", () =>
    expect(quoteWindowsArg("C:\\mi carpeta\\")).toBe('"C:\\mi carpeta\\\\"'));
});
```

- [ ] **Step 2: Escribir `test/server/planner-extract.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { extractJsonFromOutput } from "../../src/server/planner.js";
import { jsonl } from "../helpers/proc.js";

describe("extractJsonFromOutput", () => {
  it("lee el JSON desde el evento result", () => {
    const out = jsonl({ type: "result", result: 'Aquí va:\n{"steps":[{"description":"x"}]}' });
    expect(extractJsonFromOutput(out).steps[0].description).toBe("x");
  });

  it("arma el JSON a partir de deltas", () => {
    const out = jsonl(
      { type: "content_block_delta", delta: { text: '{"steps":' } },
      { type: "content_block_delta", delta: { text: "[]}" } },
    );
    expect(extractJsonFromOutput(out)).toEqual({ steps: [] });
  });

  it("lanza error si no hay JSON", () => {
    expect(() => extractJsonFromOutput(jsonl({ result: "sin json" }))).toThrow("No JSON found");
  });
});
```

- [ ] **Step 3: Correr y verificar que fallan**

Run: `npx vitest run test/lib test/server`
Expected: FAIL — `quoteWindowsArg` / `extractJsonFromOutput` no están exportadas.

- [ ] **Step 4: Exportar las funciones**

En `src/lib/process-runner.ts` cambiar `function quoteWindowsArg(arg: string): string {` por `export function quoteWindowsArg(arg: string): string {`.
En `src/server/planner.ts` cambiar `function extractJsonFromOutput(stdout: string): any {` por `export function extractJsonFromOutput(stdout: string): any {`.

- [ ] **Step 5: Correr toda la suite**

Run: `npm test`
Expected: PASS (todas). Si el test de backslashes finales falla, documentar la salida real en el commit: es comportamiento existente y se corrige en esta misma tarea solo si la salida rompe cmd.exe (comprobar con `node -e "require('child_process').spawnSync('cmd',['/c','echo',<salida>],{stdio:'inherit',shell:false})"`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/process-runner.ts src/server/planner.ts test/
git commit -m "test: blindar quoteWindowsArg y extracción de JSON del planner"
git push
```

---

### Task 3: Catálogo único de modelos + planner en Opus 5.5 + smoke real

**Files:**
- Create: `src/config/models.ts`, `scripts/smoke-models.ts`
- Modify: `src/adapters/claude/index.ts`, `src/adapters/codex/index.ts`, `src/adapters/gemini/index.ts`, `src/server/planner.ts:22-26,132`, `package.json` (script `smoke:models`), `tsconfig.json` (nada: `scripts/` corre con tsx)
- Test: `test/config/models.test.ts`

**Interfaces:**
- Consumes: `adapters` de `src/adapters/registry.ts`; `Adapter.execute(ctx)`.
- Produces:
  ```ts
  export type AdapterType = "claude" | "codex" | "gemini";
  export interface ModelEntry { id: string; label: string }
  export const PLANNER_MODEL: string;            // "claude-opus-5-5"
  export const MODEL_CATALOG: Record<AdapterType, { defaultModel: string; models: ModelEntry[] }>;
  ```

- [ ] **Step 1: Escribir `test/config/models.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { MODEL_CATALOG, PLANNER_MODEL } from "../../src/config/models.js";
import { adapters } from "../../src/adapters/registry.js";

describe("catálogo de modelos", () => {
  it("el planner es Opus 5.5 y está en el catálogo de claude", () => {
    expect(PLANNER_MODEL).toBe("claude-opus-5-5");
    expect(MODEL_CATALOG.claude.models.map((m) => m.id)).toContain(PLANNER_MODEL);
  });

  it("cada default está en su propia lista y no hay ids repetidos", () => {
    for (const [type, cat] of Object.entries(MODEL_CATALOG)) {
      const ids = cat.models.map((m) => m.id);
      expect(ids, type).toContain(cat.defaultModel);
      expect(new Set(ids).size, type).toBe(ids.length);
    }
  });

  it("los adapters leen del catálogo", () => {
    for (const type of Object.keys(MODEL_CATALOG) as (keyof typeof MODEL_CATALOG)[]) {
      expect(adapters[type].meta.models).toEqual(MODEL_CATALOG[type].models);
      expect(adapters[type].meta.defaultModel).toBe(MODEL_CATALOG[type].defaultModel);
    }
  });

  it("no quedan modelos retirados", () => {
    const all = Object.values(MODEL_CATALOG).flatMap((c) => c.models.map((m) => m.id));
    for (const old of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-6", "claude-sonnet-4-5-20250929", "o3"]) {
      expect(all).not.toContain(old);
    }
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run test/config`
Expected: FAIL — no existe `src/config/models.ts`.

- [ ] **Step 3: Crear `src/config/models.ts`** (lista candidata; el Step 7 la poda con la prueba real)

```ts
export type AdapterType = "claude" | "codex" | "gemini";

export interface ModelEntry {
  id: string;
  label: string;
}

/** Director: planea los pasos y une las respuestas de los trabajadores. */
export const PLANNER_MODEL = "claude-opus-5-5";

/**
 * Fuente única de modelos por adapter. Cada id aquí pasó `npm run smoke:models`
 * (fecha de la última verificación en el commit que lo cambió).
 */
export const MODEL_CATALOG: Record<AdapterType, { defaultModel: string; models: ModelEntry[] }> = {
  claude: {
    defaultModel: "claude-opus-5-5",
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
  },
  codex: {
    defaultModel: "gpt-5.5",
    models: [
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ],
  },
  gemini: {
    defaultModel: "gemini-3-flash-preview",
    models: [
      { id: "gemini-3-pro-preview", label: "Gemini 3 Pro" },
      { id: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    ],
  },
};
```

- [ ] **Step 4: Hacer que los adapters lean del catálogo**

`src/adapters/claude/index.ts` (mismo patrón en codex con `"codex"`/`"Codex CLI"` y gemini con `"gemini"`/`"Gemini CLI"`):

```ts
import type { Adapter, AdapterMeta } from "../../lib/types.js";
import { MODEL_CATALOG } from "../../config/models.js";
import { detect } from "./detect.js";
import { execute } from "./execute.js";

export const meta: AdapterMeta = {
  type: "claude",
  label: "Claude Code",
  command: "claude",
  models: MODEL_CATALOG.claude.models,
  defaultModel: MODEL_CATALOG.claude.defaultModel,
};

export const claudeAdapter: Adapter = {
  meta,
  detect,
  execute,
};

export default claudeAdapter;
```

- [ ] **Step 5: Planner usa el catálogo**

En `src/server/planner.ts`:
- agregar `import { MODEL_CATALOG, PLANNER_MODEL } from "../config/models.js";`
- reemplazar el objeto `ADAPTER_DEFAULTS` (líneas 22-26) por:
  ```ts
  const ADAPTER_DEFAULTS: Record<string, string> = Object.fromEntries(
    Object.entries(MODEL_CATALOG).map(([type, cat]) => [type, cat.defaultModel]),
  );
  ```
- en `args`, cambiar `"--model", "claude-sonnet-4-6",` por `"--model", PLANNER_MODEL,`.

- [ ] **Step 6: Correr tests**

Run: `npm test` y `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Crear `scripts/smoke-models.ts` y agregar script `"smoke:models": "tsx scripts/smoke-models.ts"`**

```ts
import os from "node:os";
import { adapters } from "../src/adapters/registry.js";
import { MODEL_CATALOG, type AdapterType } from "../src/config/models.js";

const only = process.argv[2] as AdapterType | undefined;
const rows: { adapter: string; model: string; ok: boolean; detalle: string }[] = [];

for (const [type, cat] of Object.entries(MODEL_CATALOG) as [AdapterType, (typeof MODEL_CATALOG)[AdapterType]][]) {
  if (only && type !== only) continue;
  const adapter = adapters[type];
  const found = await adapter.detect();
  if (!found.available) {
    rows.push({ adapter: type, model: "-", ok: false, detalle: "CLI no encontrado en PATH" });
    continue;
  }
  for (const m of cat.models) {
    const r = await adapter.execute({
      runId: `smoke-${type}-${m.id}`,
      prompt: "Responde solo con la palabra: ok",
      model: m.id,
      cwd: os.tmpdir(),
      timeoutSec: 180,
      onLog: () => {},
    });
    const ok = r.exitCode === 0 && !r.errorMessage && /ok/i.test(r.summary);
    rows.push({ adapter: type, model: m.id, ok, detalle: ok ? `${r.inputTokens}/${r.outputTokens} tok` : (r.errorMessage ?? r.summary).slice(0, 120) });
  }
}

console.table(rows);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
```

- [ ] **Step 8: Correr el smoke real** (gasta unos pocos tokens por modelo)

Run: `npm run smoke:models`
Expected: tabla con `ok: true` por modelo. Por cada fila `ok: false` por "modelo no existe/no soportado": quitar ese id de `MODEL_CATALOG` y, si era el default, poner como default el primero que sí pasó. Errores de cuota/red no implican quitar el modelo: reintentar ese adapter con `npm run smoke:models -- gemini`. Repetir hasta que todo pase. Guardar la tabla final en el mensaje de commit.

- [ ] **Step 9: Correr tests y commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/config/models.ts src/adapters src/server/planner.ts scripts/smoke-models.ts package.json test/config
git commit -m "feat: catálogo único de modelos, planner en Opus 5.5 y smoke real"
git push
```

---

### Task 4: Sin rutas de la laptop ni hash fijo de caveman; docs al día

**Files:**
- Create: `src/lib/caveman.ts`
- Modify: `src/server/runner.ts:12-13,107-111`, `src/server/routes/caveman.ts:5-6`, `CONTINUAR.md:9,125`, `ui/public/offline.html:256-257`, `CLAUDE.md` (sección Commands y Plan System)
- Test: `test/lib/caveman.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function cavemanFlagFile(home: string): string;
  export function findCavemanSkill(home: string): string | null; // ruta al SKILL.md más reciente o null
  ```

- [ ] **Step 1: Escribir `test/lib/caveman.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCavemanSkill, cavemanFlagFile } from "../../src/lib/caveman.js";

let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "cav-")); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const mk = (hash: string, mtime: number) => {
  const dir = path.join(home, ".claude", "plugins", "cache", "caveman", "caveman", hash, "caveman");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "SKILL.md");
  fs.writeFileSync(f, hash);
  fs.utimesSync(f, mtime, mtime);
  return f;
};

describe("caveman", () => {
  it("null si el plugin no está instalado", () => expect(findCavemanSkill(home)).toBeNull());
  it("encuentra el SKILL.md sin conocer el hash", () => {
    const f = mk("abc123", 1000);
    expect(findCavemanSkill(home)).toBe(f);
  });
  it("con varias versiones elige la más reciente", () => {
    mk("vieja", 1000);
    const nueva = mk("nueva", 2000);
    expect(findCavemanSkill(home)).toBe(nueva);
  });
  it("flag file vive en ~/.claude/.caveman-active", () =>
    expect(cavemanFlagFile(home)).toBe(path.join(home, ".claude", ".caveman-active")));
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run test/lib/caveman.test.ts`
Expected: FAIL — no existe `src/lib/caveman.ts`.

- [ ] **Step 3: Crear `src/lib/caveman.ts`**

```ts
import fs from "node:fs";
import path from "node:path";

export function cavemanFlagFile(home: string): string {
  return path.join(home, ".claude", ".caveman-active");
}

/** Busca ~/.claude/plugins/cache/caveman/caveman/<hash>/caveman/SKILL.md sin asumir el hash. */
export function findCavemanSkill(home: string): string | null {
  const base = path.join(home, ".claude", "plugins", "cache", "caveman", "caveman");
  let hashes: string[];
  try {
    hashes = fs.readdirSync(base);
  } catch {
    return null;
  }
  const candidates = hashes
    .map((h) => path.join(base, h, "caveman", "SKILL.md"))
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return candidates[0]?.f ?? null;
}
```

- [ ] **Step 4: Usarlo en `runner.ts` y `routes/caveman.ts`**

En ambos archivos, borrar las constantes `CAVEMAN_FLAG_FILE` y `SKILL_MD_PATH` y agregar:

```ts
import { cavemanFlagFile, findCavemanSkill } from "../lib/caveman.js"; // en routes/: "../../lib/caveman.js"
const HOME = process.env.HOME || process.env.USERPROFILE || "";
```

En `runner.ts`, `buildCavemanPrefix()` queda:

```ts
    if (!fs.existsSync(cavemanFlagFile(HOME))) return "";
    const skillPath = findCavemanSkill(HOME);
    if (!skillPath) return "";
    const skillMd = fs.readFileSync(skillPath, "utf-8");
```

En `routes/caveman.ts` reemplazar `CAVEMAN_FLAG_FILE` por `cavemanFlagFile(HOME)` (y `SKILL_MD_PATH` por `findCavemanSkill(HOME)` si se usa más abajo en el archivo).

- [ ] **Step 5: Correr tests**

Run: `npm test` y `npm run typecheck` y `npm run lint`
Expected: PASS.

- [ ] **Step 6: Actualizar rutas y docs**

- `CONTINUAR.md`: `C:\Users\sidel\orquestador-ia\` → `C:\estudio\orquestador-ia\` (líneas 9 y 125); en la sección de adapters, reemplazar las listas de modelos por "ver `src/config/models.ts`".
- `ui/public/offline.html` líneas 256-257: `cd C:\Users\sidel\orquestador-ia` → `cd C:\estudio\orquestador-ia` (ambas apariciones).
- `CLAUDE.md`: en *Commands* agregar `npm test`, `npm run lint`, `npm run typecheck`, `npm run smoke:models`; borrar "There is no test suite. There is no linter configured."; en *Plan System* cambiar `claude-sonnet-4-6` por "`PLANNER_MODEL` de `src/config/models.ts` (Opus 5.5)"; en *Adapter System* agregar "los modelos viven en `src/config/models.ts`".

Verificación: `git grep -n "Users\\\\sidel\|ef6050c5e184\|sonnet-4-6"` → solo debe aparecer en `docs/superpowers/` (spec/plan).

- [ ] **Step 7: Commit**

```bash
git add src/lib/caveman.ts src/server test/lib CONTINUAR.md ui/public/offline.html CLAUDE.md
git commit -m "fix: sin rutas de la laptop ni hash fijo de caveman; docs al día"
git push
```

---

### Task 5: Spike de `agy` (con el usuario)

> Esta tarea **no** la puede hacer un subagente solo: la instalación y el login los hace Alejandro en **su propia** PowerShell (fuera de la app, por la virtualización MSIX y porque es un script remoto). Usar una cuenta de Google que no duela perder.

**Files:**
- Create: `docs/superpowers/specs/2026-10-06-spike-agy.md`, `test/fixtures/agy/print-ok.json`

**Interfaces:**
- Produces: documento con respuestas a P1–P5 (abajo) y un fixture real de salida JSON que F1 usará para el parser del adapter `agy`.

- [ ] **Step 1 (Alejandro): Instalar `agy` en su terminal**

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

Expected: binario en `C:\Users\sidel\AppData\Local\agy\bin\agy.exe` y `agy` en PATH tras abrir una terminal nueva.

- [ ] **Step 2 (Alejandro): Primer login con la cuenta de prueba**

Run: `agy` → elegir "Google OAuth" → completar en el navegador → salir.

- [ ] **Step 3: Verificar que el orquestador lo ve**

Run (en una terminal nueva del usuario o desde la sesión, si el PATH ya lo incluye): `agy --version` y `agy --help > C:\estudio\orquestador-ia\docs\superpowers\specs\agy-help.txt`
Expected: versión impresa; ayuda guardada. Si desde la sesión de Claude no aparece, anotarlo (P5) y continuar desde la terminal del usuario.

- [ ] **Step 4: Responder P1 — salida headless**

Run: `agy -p "Responde solo con la palabra: ok" --output-format json > C:\estudio\orquestador-ia\test\fixtures\agy\print-ok.json`
Expected: JSON válido. Anotar: campos de texto, sesión/conversación, tokens, modelo. Probar también `--output-format stream-json` si existe y anotar el formato de eventos. Comprobar que el fixture no contiene tokens ni correos (si contiene correo, reemplazarlo por `cuenta@ejemplo.com`).

- [ ] **Step 5: Responder P2 — cuota oficial**

Run: `agy --help` y la ayuda de cada subcomando listado; buscar `usage`, `quota`, `status`, `limits`. Si existe un comando oficial, correrlo y anotar su salida (sin datos personales).
Expected: "sí, comando X con formato Y" o "no existe → F1 usa estimación local".

- [ ] **Step 6: Responder P3 — aislamiento por cuenta sin tocar credenciales**

Buscar en la ayuda/variables de entorno documentadas una carpeta de configuración (p. ej. flag `--config-dir` o variable de entorno). Si existe: crear `C:\estudio\orquestador-ia\.agy-perfiles\prueba2`, lanzar `agy` apuntando ahí y ver si pide login nuevo sin afectar la sesión principal (después correr `agy -p "ok"` normal y confirmar que sigue la cuenta original). **Solo se observa qué archivos/carpetas aparecen (nombres), nunca se abre ni copia su contenido.**
Expected: "aislamiento posible con X" o "no posible → cambiar de cuenta = logout + login oficial".

- [ ] **Step 7: Responder P4 — logout/login oficiales**

Run: buscar en la ayuda comandos `login`/`logout`/`auth`. Anotar cómo se cierra sesión y cómo se inicia sin TTY (el modo print falla en vez de bloquear si no hay terminal).
Expected: comandos exactos para el botón "Iniciar sesión" de F1 (que abrirá una terminal visible para el login).

- [ ] **Step 8: Responder P5 — spawn desde Node**

Run desde la raíz del repo:

```bash
npx tsx -e "import {runProcess} from './src/lib/process-runner.ts'; const {promise}=runProcess({command:'agy',args:['-p','Responde solo con la palabra: ok','--output-format','json'],cwd:process.cwd(),timeoutSec:120}); const r=await promise; console.log(r.exitCode, r.stdout.slice(0,300), r.stderr.slice(0,300));"
```

Expected: exit 0 y JSON en stdout. Si falla por quoting, anotar el error (F1 lo resuelve como Codex, por stdin si `agy` lo admite).

- [ ] **Step 9: Escribir `docs/superpowers/specs/2026-10-06-spike-agy.md`**

Estructura obligatoria (llenar con lo observado, sin inventar):

```markdown
# Spike agy — 2026-10-06
Versión: <salida de agy --version>
## P1 Salida headless
## P2 Cuota oficial
## P3 Aislamiento por cuenta
## P4 Login/logout
## P5 Spawn desde Node
## Decisiones para F1
- Medidor de uso: oficial | estimado
- Cambio de cuenta: carpeta aislada | logout+login
```

- [ ] **Step 10: Commit**

```bash
git add docs/superpowers/specs/2026-10-06-spike-agy.md docs/superpowers/specs/agy-help.txt test/fixtures/agy/
git commit -m "docs: spike de agy (salida headless, cuota, cuentas)"
git push
```

---

### Task 6: Verificación final de F0 y registro en Cerebro

**Files:**
- Modify: `C:\Users\sidel\Documents\Cerebro\00-INICIO.md` (línea en *Proyectos personales*)
- Create: `C:\Users\sidel\Documents\Cerebro\<carpeta de Proyectos personales>\Orquestador-IA.md` (misma carpeta que `GeoRoute-Lab.md`; localizarla con `Get-ChildItem C:\Users\sidel\Documents\Cerebro -Recurse -Filter GeoRoute-Lab.md`)

- [ ] **Step 1: Suite completa**

Run: `npm test; npm run lint; npm run typecheck; npm run build:ui`
Expected: todo en verde; `ui/dist/` generado.

- [ ] **Step 2: Arranque real**

Run: `npm start` (en segundo plano) y luego `curl http://127.0.0.1:3100/api/adapters`
Expected: JSON con `claude`, `codex`, `gemini` disponibles y sus modelos del catálogo. Abrir `http://127.0.0.1:3100` en el panel de navegador: el panel de adapters muestra Opus 5.5 como default de Claude. Detener el servidor.

- [ ] **Step 3: Nota en Cerebro** (sin secretos)

```markdown
---
tipo: proyecto
estado: activo
actualizado: 2026-10-06
---
# Orquestador-IA
Repo: `C:\estudio\orquestador-ia` · GitHub `orquestador-ia`
Qué es: Opus 5.5 dirige a Antigravity (`agy` oficial), Gemini CLI y Codex con prompts mínimos y une las respuestas.
Diseño: `docs/superpowers/specs/2026-10-06-orquestador-v2-design.md`
## Estado
- F0 rescate y base: hecho 2026-10-06 (tests, lint, catálogo de modelos, spike agy)
## Siguiente paso
- F1: adapter agy + panel de cuentas + medidor de uso (ver spike)
- F4 JEV: falta definición de Alejandro
## Trampas
- Antigravity: solo `agy` oficial; nunca tokens ni switchers de terceros (baneos sep-2026).
- `agy` se instala desde la terminal del usuario (MSIX virtualiza AppData).
```

Y en `00-INICIO.md`, bajo *Proyectos personales*: `- [[Orquestador-IA]] — Opus 5.5 orquesta agy/Gemini/Codex (F0 hecho; F1 siguiente)`.

- [ ] **Step 4: Commit del repo (si quedó algo) y push**

```bash
git status
git push
```
