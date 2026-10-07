# F3a — Aislar a los trabajadores · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Claude y Codex, cuando trabajan para el orquestador, carguen solo el contexto del proyecto (su `AGENTS.md`/`CLAUDE.md`) y nada global del usuario (skills, plugins, MCP, hooks, memoria, instrucciones generales).

**Architecture:** Banderas de aislamiento fijas en los constructores de argumentos (`buildClaudeArgs`, args del planner, `buildCodexArgs`). Para Codex, un perfil de trabajador (`CODEX_HOME` propio) cuyo estado se consulta con `codex login status`; si tiene sesión, el adapter lo pasa en el entorno. Una ruta de estado, una ruta que abre la terminal de login oficial y un aviso en la UI.

**Tech Stack:** Node 24 · TypeScript 5.7 ESM · Hono · vitest · React 19.

## Global Constraints

- Diseño aprobado: `docs/superpowers/specs/2026-10-06-f3a-aislar-trabajadores-design.md`.
- Idioma de docs, commits y textos de UI: español de México. `CLAUDE.md` sigue en inglés.
- Rama: `f3a-aislar-trabajadores` (NO `main`). Commit + push al terminar cada tarea. Commits terminan con línea en blanco + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca stagear `.superpowers/`.
- Antes de cada commit: `npm test`, `npm run lint` (0 errores), `npm run typecheck`; si se toca `ui/`, también `npm run build:ui`.
- Banderas de Claude (siempre, en este orden, después de `--verbose`): `--setting-sources`, `project,local`, `--strict-mcp-config`, `--disable-slash-commands`. `readOnly` agrega solo `--disallowedTools "Bash Edit Write NotebookEdit WebFetch WebSearch"` (ya no repite `--strict-mcp-config`).
- Banderas de Codex (siempre, después de `--skip-git-repo-check`): `--ignore-user-config` y un `--disable <f>` por cada `f` de `plugins apps hooks browser_use computer_use image_generation skill_search multi_agent goals tool_suggest personality`.
- Perfil de trabajador de Codex: `<raíz de datos>/workers/codex`, donde raíz = `ORQUESTADOR_DATA_DIR` o `~/.orquestador-ia` (nunca AppData). Estado = exit code de `codex login status` con ese `CODEX_HOME` (0 = con sesión), cacheado **60 s**. **Nunca** leer, copiar ni listar archivos de credenciales.
- Tests: nunca ejecutan `codex`/`claude` reales (se inyecta la función que consulta el estado).
- No se agregan dependencias nuevas.

---

### Task 1: Claude aislado (adapter y planner)

**Files:**
- Modify: `src/adapters/claude/execute.ts`, `src/server/planner.ts`
- Test: `test/adapters/claude-execute.test.ts`, `test/server/planner-args.test.ts` (crear)

**Interfaces:**
- Produces:
  ```ts
  // src/adapters/claude/execute.ts
  export const CLAUDE_ISOLATION_ARGS: readonly string[] = ["--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands"];
  export function buildClaudeArgs(model?: string, sessionId?: string, opts?: { readOnly?: boolean }): string[];
  // src/server/planner.ts
  export function buildPlannerArgs(systemPromptFile: string): string[];
  ```

- [ ] **Step 1: Tests** — reemplazar en `test/adapters/claude-execute.test.ts` los casos de argv exacto por:

```ts
import { describe, it, expect } from "vitest";
import { buildClaudeArgs, CLAUDE_ISOLATION_ARGS, READ_ONLY_DISALLOWED_TOOLS } from "../../src/adapters/claude/execute.js";

describe("buildClaudeArgs", () => {
  it("escritor: aislado + salta permisos", () => {
    expect(buildClaudeArgs("claude-opus-5-5")).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose",
      ...CLAUDE_ISOLATION_ARGS,
      "--dangerously-skip-permissions", "--model", "claude-opus-5-5",
    ]);
  });
  it("readOnly: aislado + tools prohibidas, sin saltar permisos ni repetir --strict-mcp-config", () => {
    const a = buildClaudeArgs(undefined, undefined, { readOnly: true });
    expect(a).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose",
      ...CLAUDE_ISOLATION_ARGS,
      "--disallowedTools", READ_ONLY_DISALLOWED_TOOLS,
    ]);
    expect(a.filter((x) => x === "--strict-mcp-config")).toHaveLength(1);
  });
  it("aislamiento exacto", () => {
    expect(CLAUDE_ISOLATION_ARGS).toEqual(["--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands"]);
  });
  it("agrega --resume con sesión", () => {
    expect(buildClaudeArgs(undefined, "abc")).toContain("--resume");
  });
});
```

`test/server/planner-args.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildPlannerArgs } from "../../src/server/planner.js";
import { CLAUDE_ISOLATION_ARGS } from "../../src/adapters/claude/execute.js";

describe("buildPlannerArgs", () => {
  it("el planner también corre aislado, con Opus y su system prompt en archivo", () => {
    const a = buildPlannerArgs("C:\\tmp\\sys.txt");
    for (const f of CLAUDE_ISOLATION_ARGS) expect(a).toContain(f);
    expect(a).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--system-prompt-file", "C:\\tmp\\sys.txt"]));
  });
});
```

- [ ] **Step 2: Correr y verificar que fallan** — `npx vitest run test/adapters/claude-execute.test.ts test/server/planner-args.test.ts` → FAIL.

- [ ] **Step 3: Implementar**
- `execute.ts`: exportar `CLAUDE_ISOLATION_ARGS` (comentario: medido en el spike de F3a — sin estas banderas Claude cargaba el CLAUDE.md global del usuario e ignoraba el del proyecto); `buildClaudeArgs` = base + `...CLAUDE_ISOLATION_ARGS` + (readOnly ? `["--disallowedTools", READ_ONLY_DISALLOWED_TOOLS]` : `["--dangerously-skip-permissions"]`) + modelo + resume.
- `planner.ts`: extraer `export function buildPlannerArgs(systemPromptFile: string): string[]` con los args actuales del planner más `...CLAUDE_ISOLATION_ARGS` (importado del adapter) justo después de `--verbose`; `generatePlan` lo usa.

- [ ] **Step 4: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck` → PASS.

```bash
git add src test
git commit -m "feat: Claude corre aislado de la configuración global (adapter y planner)"
git push -u origin f3a-aislar-trabajadores
```

---

### Task 2: Codex aislado y perfil de trabajador

**Files:**
- Create: `src/lib/worker-profile.ts`, `test/lib/worker-profile.test.ts`
- Modify: `src/adapters/codex/execute.ts`, `test/adapters/codex-execute.test.ts` (crear si no existe)

**Interfaces:**
- Consumes: `runProcess`, `withoutOrchestratorSecrets` (`src/lib/process-runner.ts`).
- Produces:
  ```ts
  // src/lib/worker-profile.ts
  export const CODEX_STATUS_TTL_MS = 60_000;
  export function orchestratorDataRoot(env?: NodeJS.ProcessEnv): string;      // ORQUESTADOR_DATA_DIR o ~/.orquestador-ia
  export function codexWorkerHome(env?: NodeJS.ProcessEnv): string;           // <raíz>/workers/codex (crea la carpeta)
  export type LoginChecker = (codexHome: string) => Promise<boolean>;         // true si `codex login status` sale 0
  export const checkCodexLogin: LoginChecker;
  export function createCodexProfile(opts?: { checker?: LoginChecker; now?: () => number; env?: NodeJS.ProcessEnv }): {
    status(): Promise<{ home: string; loggedIn: boolean }>;
    envForWorker(): Promise<Record<string, string>>;  // { CODEX_HOME: home } si loggedIn, {} si no
    invalidate(): void;
  };
  export const codexProfile: ReturnType<typeof createCodexProfile>;
  // src/adapters/codex/execute.ts
  export const CODEX_DISABLED_FEATURES: readonly string[];
  export function buildCodexArgs(model?: string, opts?: { readOnly?: boolean }): string[];
  ```

- [ ] **Step 1: Tests**

`test/lib/worker-profile.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orchestratorDataRoot, codexWorkerHome, createCodexProfile, CODEX_STATUS_TTL_MS } from "../../src/lib/worker-profile.js";

describe("perfil de trabajador de Codex", () => {
  it("la raíz es ORQUESTADOR_DATA_DIR o ~/.orquestador-ia, nunca AppData", () => {
    expect(orchestratorDataRoot({ ORQUESTADOR_DATA_DIR: "D:\\datos" })).toBe("D:\\datos");
    expect(orchestratorDataRoot({ USERPROFILE: "C:\\Users\\x" })).toBe(path.join("C:\\Users\\x", ".orquestador-ia"));
  });
  it("codexWorkerHome crea <raíz>/workers/codex", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-"));
    const home = codexWorkerHome({ ORQUESTADOR_DATA_DIR: root });
    expect(home).toBe(path.join(root, "workers", "codex"));
    expect(fs.existsSync(home)).toBe(true);
  });
  it("con sesión: envForWorker da CODEX_HOME; sin sesión: {}", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-"));
    const env = { ORQUESTADOR_DATA_DIR: root };
    const yes = createCodexProfile({ checker: async () => true, env });
    expect(await yes.envForWorker()).toEqual({ CODEX_HOME: path.join(root, "workers", "codex") });
    const no = createCodexProfile({ checker: async () => false, env });
    expect(await no.envForWorker()).toEqual({});
    expect(await no.status()).toEqual({ home: path.join(root, "workers", "codex"), loggedIn: false });
  });
  it("cachea el estado 60 s e invalidate fuerza otra consulta", async () => {
    let t = 0;
    const checker = vi.fn(async () => true);
    const p = createCodexProfile({ checker, now: () => t, env: { ORQUESTADOR_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wp-")) } });
    await p.status(); await p.status();
    expect(checker).toHaveBeenCalledTimes(1);
    t = CODEX_STATUS_TTL_MS + 1;
    await p.status();
    expect(checker).toHaveBeenCalledTimes(2);
    p.invalidate();
    await p.status();
    expect(checker).toHaveBeenCalledTimes(3);
  });
  it("si el checker falla, se considera sin sesión", async () => {
    const p = createCodexProfile({ checker: async () => { throw new Error("x"); }, env: { ORQUESTADOR_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wp-")) } });
    expect((await p.status()).loggedIn).toBe(false);
  });
});
```

`test/adapters/codex-execute.test.ts` (agregar si existe; crear si no):

```ts
import { describe, it, expect } from "vitest";
import { buildCodexArgs, CODEX_DISABLED_FEATURES } from "../../src/adapters/codex/execute.js";

describe("buildCodexArgs", () => {
  const iso = ["--ignore-user-config", ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f])];
  it("lista exacta de funciones apagadas", () => {
    expect(CODEX_DISABLED_FEATURES).toEqual(["plugins", "apps", "hooks", "browser_use", "computer_use", "image_generation", "skill_search", "multi_agent", "goals", "tool_suggest", "personality"]);
  });
  it("escritor: --full-auto + aislamiento + modelo + stdin", () => {
    expect(buildCodexArgs("gpt-5.5")).toEqual(["exec", "--json", "--full-auto", "--skip-git-repo-check", ...iso, "-m", "gpt-5.5", "-"]);
  });
  it("readOnly: sandbox de solo lectura + aislamiento", () => {
    expect(buildCodexArgs(undefined, { readOnly: true })).toEqual(["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", ...iso, "-"]);
  });
});
```

- [ ] **Step 2: Correr y verificar que fallan.**

- [ ] **Step 3: Crear `src/lib/worker-profile.ts`**

```ts
import fs from "node:fs";
import path from "node:path";
import { runProcess, withoutOrchestratorSecrets } from "./process-runner.js";

/**
 * Perfil de trabajador de Codex (F3a): CODEX_HOME propio del orquestador, sin el AGENTS.md global ni las skills del
 * usuario. Tiene su propia sesión (el usuario la inicia con `codex login`); aquí solo se consulta `codex login status`.
 * Nunca se leen ni copian credenciales.
 */
export const CODEX_STATUS_TTL_MS = 60_000;

export function orchestratorDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ORQUESTADOR_DATA_DIR || path.join(env.USERPROFILE || env.HOME || ".", ".orquestador-ia");
}

export function codexWorkerHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = path.join(orchestratorDataRoot(env), "workers", "codex");
  fs.mkdirSync(home, { recursive: true });
  return home;
}

export type LoginChecker = (codexHome: string) => Promise<boolean>;

export const checkCodexLogin: LoginChecker = async (codexHome) => {
  const { promise } = runProcess({
    command: "codex",
    args: ["login", "status"],
    cwd: codexHome,
    env: { ...withoutOrchestratorSecrets(process.env), CODEX_HOME: codexHome } as Record<string, string>,
    timeoutSec: 20,
  });
  const r = await promise;
  return r.exitCode === 0;
};

export function createCodexProfile(opts: { checker?: LoginChecker; now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
  const checker = opts.checker ?? checkCodexLogin;
  const now = opts.now ?? Date.now;
  let cache: { at: number; loggedIn: boolean } | null = null;

  async function status(): Promise<{ home: string; loggedIn: boolean }> {
    const home = codexWorkerHome(opts.env);
    if (!cache || now() - cache.at > CODEX_STATUS_TTL_MS) {
      let loggedIn = false;
      try { loggedIn = await checker(home); } catch { loggedIn = false; }
      cache = { at: now(), loggedIn };
    }
    return { home, loggedIn: cache.loggedIn };
  }

  return {
    status,
    async envForWorker(): Promise<Record<string, string>> {
      const s = await status();
      return s.loggedIn ? { CODEX_HOME: s.home } : {};
    },
    invalidate() { cache = null; },
  };
}

export const codexProfile = createCodexProfile();
```

Nota: `runProcess` ya filtra los secretos del orquestador; pasar `env` con `CODEX_HOME` es suficiente — si `withoutOrchestratorSecrets` sobra ahí, quitarlo.

- [ ] **Step 4: `src/adapters/codex/execute.ts`**
- `export const CODEX_DISABLED_FEATURES = ["plugins", "apps", "hooks", "browser_use", "computer_use", "image_generation", "skill_search", "multi_agent", "goals", "tool_suggest", "personality"] as const;` (tipado como `readonly string[]`), con comentario que cite el spike (17.3k → 10.7k).
- `buildCodexArgs`: después de `--skip-git-repo-check`, `--ignore-user-config` y `--disable f` por cada función.
- `execute`: `const isolationEnv = await codexProfile.envForWorker();` y `env: { ...ctx.env, ...isolationEnv }` en `runProcess`.

- [ ] **Step 5: Verificar y commit** — `npm test && npm run lint && npm run typecheck` → PASS.

```bash
git add src test
git commit -m "feat: Codex aislado (sin config del usuario) y perfil de trabajador con CODEX_HOME propio"
git push
```

---

### Task 3: Estado, terminal de login y aviso en la UI

**Files:**
- Create: `src/server/routes/workers.ts`, `test/server/workers-routes.test.ts`
- Modify: `src/lib/agy-terminal.ts` (o un archivo nuevo `src/lib/codex-terminal.ts`), `src/server/index.ts`, `ui/src/components/AccountsPanel.tsx` (o un componente nuevo `ui/src/components/WorkerIsolationNotice.tsx` montado debajo de `AccountsPanel` en `App.tsx`)

**Interfaces:**
- Consumes: `codexProfile` (Task 2); `withoutOrchestratorSecrets`.
- Produces:
  - `GET /api/workers/status` → `{ claude: { isolated: true }, agy: { isolated: true }, codex: { isolated: boolean, home: string } }` (`isolated` de codex = `loggedIn`).
  - `POST /api/workers/codex/login-terminal` → 200 `{ ok: true }` (abre `cmd.exe /c start "Codex - perfil de trabajadores" cmd /k codex login` con `CODEX_HOME` del perfil y sin secretos) e invalida el caché; 501 fuera de Windows.
  - `export function buildCodexLoginCommand(): { command: string; args: string[] }` (puro, testeable).

- [ ] **Step 1: Tests** — `test/server/workers-routes.test.ts` con `vi.mock("../../src/lib/worker-profile.js", ...)` (hoisted) para controlar `codexProfile.status()` e `invalidate`, y `vi.mock` del módulo de terminal para que `openCodexLoginTerminal` sea un `vi.fn()`:
  - status con sesión → `codex.isolated: true`; sin sesión → `false`; `claude`/`agy` siempre `true`.
  - `POST /codex/login-terminal` llama a `openCodexLoginTerminal` y a `invalidate`.
  - Test puro de `buildCodexLoginCommand`: `{ command: "cmd.exe", args: ["/c", 'start "Codex - perfil de trabajadores" cmd /k codex login'] }`.

- [ ] **Step 2: Correr y verificar que fallan.**

- [ ] **Step 3: Implementar**
- Terminal: mismo patrón que `openAgyTerminal` (`detached`, `stdio: "ignore"`, `windowsVerbatimArguments: true`), `env: { ...withoutOrchestratorSecrets(process.env), CODEX_HOME: home }`.
- Ruta `src/server/routes/workers.ts` montada en `/api/workers`.
- UI: aviso compacto en la columna izquierda (debajo del panel de cuentas):
  - Codex aislado → `codex: aislado ✓`.
  - Codex sin sesión de trabajador → texto "Codex aislado parcialmente: inicia la sesión del perfil de trabajadores (una vez)" + botón "iniciar sesión de Codex para trabajadores" (POST a la ruta) + al volver, "ya inicié sesión" que vuelve a consultar el estado. Botones nativos con alto ≥ 24 px y foco visible; textos en español.
  - Consultar `GET /api/workers/status` con TanStack Query (refetch cada 60 s).

- [ ] **Step 4: Verificar y commit** — `npm test && npm run lint && npm run typecheck && npm run build:ui` → PASS.

```bash
git add src test ui
git commit -m "feat: estado del aislamiento de trabajadores y login del perfil de Codex"
git push
```

---

### Task 4: Verificación en vivo y documentación

- [ ] **Step 1: Suite completa** en verde.
- [ ] **Step 2 (Alejandro):** abrir el orquestador, pulsar "iniciar sesión de Codex para trabajadores" y completar `codex login` en la terminal que se abre (o correr en su terminal `set CODEX_HOME=%USERPROFILE%\.orquestador-ia\workers\codex && codex login`).
- [ ] **Step 3: Mediciones** en `C:\orq-spike\proj` (AGENTS.md/CLAUDE.md con la regla `PROYECTO-OK`), con los args reales que arman `buildCodexArgs`/`buildClaudeArgs` (script de una sola vez con `npx tsx -e`): pregunta marcador "¿aparece BIBLIA_ECOSISTEMA en tus instrucciones?" → Codex con perfil y Claude deben decir **no** y empezar con `PROYECTO-OK`; anotar tokens de entrada de Codex (antes 17.3k / 10.7k).
- [ ] **Step 4: Escritor de Codex** con `--ignore-user-config` y el perfil: pedirle crear `prueba.txt` con "hola" en `C:\orq-spike\proj` → el archivo existe.
- [ ] **Step 5: Documentación** — `CLAUDE.md` (sección "Worker isolation" con la tabla del spike, banderas, perfil de Codex, `GET /api/workers/status`, login), `CONTINUAR.md` (lo mismo en español y cómo iniciar la sesión del perfil), Cerebro `Orquestador-IA.md` (estado F3a + resultados medidos; trampa: "el perfil de trabajador de Codex necesita su propio login") y `00-INICIO.md`.
- [ ] **Step 6: Commit** — `git commit -m "docs: F3a (aislar trabajadores) verificado y documentado"` y push.
