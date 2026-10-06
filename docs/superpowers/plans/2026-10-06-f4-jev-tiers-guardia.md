# F4 — JEV para tiers y guardia · Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usar JEV (TypeSafe) para clasificar cada pedido de `/plan` como trivial/normal/crítico (ahorrando a Opus en lo trivial y agregando revisión + aprobación en lo crítico) y para vigilar cada paso escritor antes de lanzarlo, pausando el plan si pide commit/push, borrar o salir del proyecto.

**Architecture:** Un cliente HTTP mínimo `src/lib/jev.ts` que nunca lanza (devuelve `null` si no hay llave o falla). Lógica pura del tier en `src/server/plan-tier.ts` y de la guardia en `src/server/plan-guard.ts` (con reglas locales de respaldo). `POST /api/plans` decide el tier antes de llamar a Opus; el planificador (`plan-scheduler.ts`) consulta la guardia antes de lanzar escritores y pausa con `pause_reason = guard`; una ruta nueva aprueba el paso. PlanView muestra el tier, el aviso de plan crítico y el aviso de guardia.

**Tech Stack:** Node 24 (`fetch`, `AbortSignal.timeout`, `process.loadEnvFile`) · TypeScript 5.7 ESM · Hono · Drizzle + libsql · vitest · React 19.

## Global Constraints

- Diseño aprobado: `docs/superpowers/specs/2026-10-06-f4-jev-tiers-guardia-design.md`.
- Idioma de docs, commits y textos de UI: español de México. `CLAUDE.md` sigue en inglés.
- Rama: `f4-jev` (NO `main`). Commit + push al terminar cada tarea. Commits terminan con línea en blanco + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Antes de cada commit: `npm test`, `npm run lint` (0 errores), `npm run typecheck`; si se toca `ui/`, también `npm run build:ui`.
- JEV: endpoint `https://api.typesafe.ai/v1/systemone`, modelo `jev-latest`, header `Authorization: Bearer <TYPESAFE_API_KEY>`. Timeout **10 s**; un reintento en **429/529** tras **1 s**. El cliente **nunca lanza**.
- Umbrales: tier con confianza **< 0.7** → `normal`; guardia: cualquier Noul **≥ 0.5** marca el paso.
- Tier trivial: un paso `agy` con modelo **`gemini-3.8-flash-low`**, `estimatedTokens` **15000**; arranca solo.
- Tier crítico: paso extra clave **`review`** (si existe, `review2`, `review3`…), adapter `claude`, modelo `PLANNER_MODEL`, `writes = 0`, `read_only = 1`, `estimatedTokens` **20000**, depende de todos los pasos hoja.
- La llave vive solo en `.env` (gitignored). Nunca se imprime, se loguea ni se escribe en Cerebro. Los tests **borran** `TYPESAFE_API_KEY` del entorno y nunca llaman a la red (fetch simulado).
- No se agregan dependencias nuevas.

---

## Mapa de archivos

| Archivo | Acción | Responsabilidad |
|---|---|---|
| `src/lib/jev.ts` | Crear | cliente HTTP de JEV que nunca lanza |
| `src/server/routes/jev.ts`, `src/server/index.ts` | Crear/Modificar | `GET /api/jev/status`; carga de `.env` |
| `.env.example`, `test/setup-env.ts` | Crear/Modificar | documentar la llave; quitarla en tests |
| `src/db/schema.ts`, `src/db/migrate.ts` | Modificar | `plans.tier*`; `plan_steps.read_only/guard_flags/guard_approved` |
| `src/server/plan-runner.ts` | Modificar | pasar `readOnly` del paso al adapter |
| `src/server/plan-tier.ts` | Crear | clasificación de tier, paso trivial, paso de revisión |
| `src/server/plan-guard.ts` | Crear | reglas locales y guardia con JEV |
| `src/server/routes/plans.ts` | Modificar | tier en la creación; aprobar paso; PATCH anula aprobación |
| `src/server/plan-scheduler.ts` | Modificar | guardia antes de lanzar escritores |
| `ui/src/components/PlanView.tsx` | Modificar | insignia de tier, aviso crítico, aviso de guardia |
| Tests | Crear/Modificar | `test/lib/jev.test.ts`, `test/server/plan-tier.test.ts`, `test/server/plan-guard.test.ts`, `test/server/plan-scheduler-guard.test.ts`, `test/server/plans-routes.test.ts`, `test/server/plan-schema.test.ts`, `test/server/plan-runner-quota.test.ts` |

---

### Task 1: Cliente de JEV, carga de `.env` y estado

**Files:**
- Create: `src/lib/jev.ts`, `src/server/routes/jev.ts`, `.env.example`, `test/lib/jev.test.ts`
- Modify: `src/server/index.ts`, `test/setup-env.ts`

**Interfaces:**
- Produces:
  ```ts
  export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
  export const JEV_MODEL = "jev-latest";
  export const JEV_STATE_MAX_CHARS = 8000;
  export interface JevQuestion { type: "choice" | "noul"; instructions: string; criteria?: Record<string, string> }
  export interface JevChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  export interface JevNoulAnswer { type: "noul"; noul: number }
  export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;
  export interface JevClient { configured(): boolean; ask(state: string, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer> | null> }
  export function createJevClient(opts?: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number; retryDelayMs?: number }): JevClient;
  export const jev: JevClient; // lee process.env.TYPESAFE_API_KEY en cada llamada
  ```
  Ruta: `GET /api/jev/status` → `{ configured: boolean }`.

- [ ] **Step 1: `test/setup-env.ts`** — agregar al final: `delete process.env.TYPESAFE_API_KEY; // los tests nunca llaman a JEV real`.

- [ ] **Step 2: Escribir `test/lib/jev.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { createJevClient, JEV_ENDPOINT, JEV_STATE_MAX_CHARS } from "../../src/lib/jev.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const answers = { tier: { type: "choice", choice: "trivial", confidence: 0.9, probabilities: { trivial: 0.9, normal: 0.1 } } };

describe("cliente JEV", () => {
  it("sin llave: no configurado y ask devuelve null sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const c = createJevClient({ apiKey: "", fetchImpl: fetchImpl as any });
    expect(c.configured()).toBe(false);
    expect(await c.ask("x", { q: { type: "noul", instructions: "?" } })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("manda state, modelo y preguntas con Bearer y devuelve answers", async () => {
    const fetchImpl = vi.fn(async () => ok({ model: "jev-1.13.0", answers, usage: {} }));
    const c = createJevClient({ apiKey: "k", fetchImpl: fetchImpl as any });
    const r = await c.ask("pedido", { tier: { type: "choice", instructions: "?", criteria: { trivial: "a", normal: "b" } } });
    expect(r).toEqual(answers);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ state: "pedido", model: "jev-latest" });
    expect(body.questions.tier.criteria).toEqual({ trivial: "a", normal: "b" });
  });

  it("recorta el state", async () => {
    const fetchImpl = vi.fn(async () => ok({ answers }));
    await createJevClient({ apiKey: "k", fetchImpl: fetchImpl as any }).ask("x".repeat(JEV_STATE_MAX_CHARS + 100), { q: { type: "noul", instructions: "?" } });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.state.length).toBe(JEV_STATE_MAX_CHARS);
  });

  it("reintenta una vez en 429 y luego responde", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(ok({ answers }));
    const r = await createJevClient({ apiKey: "k", fetchImpl: fetchImpl as any, retryDelayMs: 1 }).ask("x", { q: { type: "noul", instructions: "?" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r).toEqual(answers);
  });

  it("errores, respuestas sin answers y excepciones devuelven null (nunca lanza)", async () => {
    const q = { q: { type: "noul" as const, instructions: "?" } };
    expect(await createJevClient({ apiKey: "k", fetchImpl: vi.fn(async () => new Response("", { status: 401 })) as any }).ask("x", q)).toBeNull();
    expect(await createJevClient({ apiKey: "k", fetchImpl: vi.fn(async () => ok({ nada: 1 })) as any }).ask("x", q)).toBeNull();
    expect(await createJevClient({ apiKey: "k", fetchImpl: vi.fn(async () => { throw new Error("red"); }) as any }).ask("x", q)).toBeNull();
    const twice429 = vi.fn(async () => new Response("", { status: 529 }));
    expect(await createJevClient({ apiKey: "k", fetchImpl: twice429 as any, retryDelayMs: 1 }).ask("x", q)).toBeNull();
    expect(twice429).toHaveBeenCalledTimes(2);
  });

  it("el cliente por defecto lee la llave del entorno en cada llamada", async () => {
    const c = createJevClient({ fetchImpl: vi.fn() as any });
    expect(c.configured()).toBe(false);
    process.env.TYPESAFE_API_KEY = "k";
    try {
      expect(c.configured()).toBe(true);
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});
```

- [ ] **Step 3: Correr y verificar que falla**

Run: `npx vitest run test/lib/jev.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 4: Crear `src/lib/jev.ts`**

```ts
import pino from "pino";

/**
 * Cliente mínimo de JEV (TypeSafe AI, modelo "System One": decisiones tipadas, no texto).
 * Nunca lanza: sin llave, con error de red/HTTP o respuesta inválida devuelve null y el llamador usa su alternativa.
 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_STATE_MAX_CHARS = 8000;

export interface JevQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string>;
}
export interface JevChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevNoulAnswer { type: "noul"; noul: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevClient {
  configured(): boolean;
  ask(state: string, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer> | null>;
}

const log = pino({ name: "jev" });
const RETRY_STATUSES = new Set([429, 529]);

export function createJevClient(opts: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number; retryDelayMs?: number } = {}): JevClient {
  const key = () => (opts.apiKey !== undefined ? opts.apiKey : process.env.TYPESAFE_API_KEY ?? "").trim();
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryDelayMs = opts.retryDelayMs ?? 1_000;

  return {
    configured: () => key().length > 0,
    async ask(state, questions) {
      const apiKey = key();
      if (!apiKey) return null;
      const body = JSON.stringify({ state: state.slice(0, JEV_STATE_MAX_CHARS), model: JEV_MODEL, questions });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await doFetch(JEV_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (RETRY_STATUSES.has(res.status) && attempt === 0) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }
          if (!res.ok) {
            log.warn({ status: res.status }, "JEV respondió con error");
            return null;
          }
          const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
          return data && typeof data.answers === "object" && data.answers ? data.answers : null;
        } catch (err) {
          log.warn({ err: (err as Error).message }, "JEV no disponible");
          return null;
        }
      }
      return null;
    },
  };
}

export const jev: JevClient = createJevClient();
```

- [ ] **Step 5: Ruta de estado y carga de `.env`**
- `src/server/routes/jev.ts`:
  ```ts
  import { Hono } from "hono";
  import { jev } from "../../lib/jev.js";

  const app = new Hono();
  app.get("/status", (c) => c.json({ configured: jev.configured() }));
  export default app;
  ```
- `src/server/index.ts`: después de los imports y **antes** de `await migrationDone`:
  ```ts
  // Llaves locales (p. ej. TYPESAFE_API_KEY) en .env, que está en .gitignore.
  try { process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env")); } catch { /* sin .env */ }
  ```
  y montar `app.route("/api/jev", jevRoute);` (import `jevRoute from "./routes/jev.js"`).
- `.env.example`:
  ```
  # Copia este archivo como .env (no se sube a git) y pega tu llave de https://console.typesafe.ai/keys
  TYPESAFE_API_KEY=
  ```
- Confirmar que `.gitignore` contiene `.env` (ya está) y que `git check-ignore .env` lo reporta.

- [ ] **Step 6: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: cliente de JEV que nunca truena, carga de .env y /api/jev/status"
git push -u origin f4-jev
```

---

### Task 2: Esquema (tier, solo lectura, guardia) y `readOnly` por paso

**Files:**
- Modify: `src/db/schema.ts`, `src/db/migrate.ts`, `src/server/plan-runner.ts`, `src/server/routes/plans.ts` (solo `PATCH /:planId/steps/:stepId`)
- Test: `test/server/plan-schema.test.ts`, `test/server/plan-runner-quota.test.ts`, `test/server/plans-routes.test.ts`

**Interfaces:**
- Produces (Drizzle):
  - `plans`: `tier: text("tier")` (`"trivial" | "normal" | "critical" | null`), `tierConfidence: real("tier_confidence")`, `tierSource: text("tier_source")` (`"jev" | "fallback" | null`). `pauseReason` admite además `"guard"`.
  - `planSteps`: `readOnly: integer("read_only").notNull().default(0)`, `guardFlags: text("guard_flags")` (JSON `GuardFlag[]`), `guardApproved: integer("guard_approved").notNull().default(0)`.
- `runPlanStep` pasa `readOnly: step.readOnly === 1` a `adapter.execute`.
- `PATCH /:planId/steps/:stepId`: si cambia `prompt`, también `guardApproved: 0, guardFlags: null`.

- [ ] **Step 1: Tests**
- `test/server/plan-schema.test.ts`: agregar
  ```ts
  it("F4: tier en plans y solo-lectura/guardia en plan_steps con defaults", async () => {
    const planId = randomUUID();
    await db.insert(schema.plans).values({ id: planId, description: "d", status: "pending", tier: "critical", tierConfidence: 0.91, tierSource: "jev" });
    const id = randomUUID();
    await db.insert(schema.planSteps).values({ id, planId, stepIndex: 0, description: "x", adapter: "claude", prompt: "p", status: "pending" });
    const p = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
    const s = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, id)).then((r) => r[0]);
    expect(p).toMatchObject({ tier: "critical", tierConfidence: 0.91, tierSource: "jev" });
    expect(s).toMatchObject({ readOnly: 0, guardFlags: null, guardApproved: 0 });
  });
  ```
- `test/server/plan-runner-quota.test.ts`: agregar un caso que crea el paso con `readOnly: 1` y verifica `h.execute.mock.calls[0][0].readOnly === true`, y otro con `readOnly: 0` → `false`.
- `test/server/plans-routes.test.ts`: agregar
  ```ts
  it("PATCH de paso: cambiar el prompt anula la aprobación de la guardia", async () => {
    const id = await mk();
    const stepId = randomUUID();
    await db.insert(schema.planSteps).values({ id: stepId, planId: id, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending", guardApproved: 1, guardFlags: "[]" });
    const r = await req(`/${id}/steps/${stepId}`, "PATCH", { prompt: "otro" });
    expect(await r.json()).toMatchObject({ prompt: "otro", guardApproved: 0, guardFlags: null });
  });
  ```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run test/server/plan-schema.test.ts test/server/plan-runner-quota.test.ts test/server/plans-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**
- Esquema Drizzle con los campos de Interfaces (comentarios: `tier` y fuente; `readOnly` = sin permisos de escritura para el adapter; `guardFlags` JSON de banderas; `guardApproved` = el usuario aprobó correr el paso aunque la guardia lo marcó).
- `SCHEMA_SQL`: columnas nuevas en los `CREATE TABLE` (`tier TEXT, tier_confidence REAL, tier_source TEXT`; `read_only INTEGER NOT NULL DEFAULT 0, guard_flags TEXT, guard_approved INTEGER NOT NULL DEFAULT 0`). En `migrate()`, agregar a la lista de `ALTER TABLE` con try/catch los seis `ADD COLUMN` correspondientes. Extender el test de upgrade existente (`test/server/plan-schema-upgrade.test.ts`) para que verifique las columnas nuevas.
- `plan-runner.ts`: `readOnly: step.readOnly === 1` en la llamada a `adapter.execute`.
- Ruta PATCH de paso: si `typeof body.prompt === "string"`, agregar `guardApproved: 0` y `guardFlags: null` al `set` (ampliar su tipo).

- [ ] **Step 4: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: esquema de tier y guardia; pasos de solo lectura llegan al adapter"
git push
```

---

### Task 3: Tier del pedido (`src/server/plan-tier.ts`) y creación de planes

**Files:**
- Create: `src/server/plan-tier.ts`, `test/server/plan-tier.test.ts`
- Modify: `src/server/routes/plans.ts` (`POST /`), `test/server/plans-routes.test.ts`

**Interfaces:**
- Consumes: `JevClient`, `jev` (Task 1); `PLANNER_MODEL` y `GeneratedPlan`/`PlanStep` de `planner.ts`; `defaultBudget` de `plan-dag.ts`; `runPlanDag` de `plan-scheduler.ts`; columnas de Task 2.
- Produces:
  ```ts
  export type Tier = "trivial" | "normal" | "critical";
  export const TIER_MIN_CONFIDENCE = 0.7;
  export const TRIVIAL_MODEL = "gemini-3.8-flash-low";
  export const TRIVIAL_ESTIMATED_TOKENS = 15000;
  export const REVIEW_ESTIMATED_TOKENS = 20000;
  export const TIER_QUESTION: JevQuestion; export const WRITES_QUESTION: JevQuestion;
  export interface TierDecision { tier: Tier; confidence: number | null; source: "jev" | "fallback" }
  export function tierFromAnswer(answer: JevAnswer | undefined | null): TierDecision;
  export async function classifyTier(description: string, client?: JevClient): Promise<TierDecision>;
  export async function trivialWrites(description: string, client?: JevClient): Promise<boolean>;
  export function makeTrivialStep(description: string, writes: boolean): PlanStep;
  export function addReviewStep(plan: GeneratedPlan, request: string): GeneratedPlan & { reviewKey: string };
  ```

- [ ] **Step 1: Escribir `test/server/plan-tier.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  tierFromAnswer, classifyTier, trivialWrites, makeTrivialStep, addReviewStep,
  TIER_MIN_CONFIDENCE, TRIVIAL_MODEL, TRIVIAL_ESTIMATED_TOKENS, REVIEW_ESTIMATED_TOKENS,
} from "../../src/server/plan-tier.js";
import type { JevClient } from "../../src/lib/jev.js";

const client = (answers: Record<string, unknown> | null): JevClient => ({ configured: () => true, ask: vi.fn(async () => answers as any) });
const choice = (c: string, confidence: number) => ({ type: "choice", choice: c, confidence, probabilities: {} });

describe("tier", () => {
  it("usa la elección de JEV si la confianza alcanza el umbral", () => {
    expect(tierFromAnswer(choice("critical", TIER_MIN_CONFIDENCE) as any)).toEqual({ tier: "critical", confidence: TIER_MIN_CONFIDENCE, source: "jev" });
  });
  it("confianza baja → normal, conservando la confianza y la fuente jev", () => {
    expect(tierFromAnswer(choice("trivial", 0.69) as any)).toEqual({ tier: "normal", confidence: 0.69, source: "jev" });
  });
  it("sin respuesta, tipo equivocado u opción desconocida → normal por alternativa", () => {
    expect(tierFromAnswer(null)).toEqual({ tier: "normal", confidence: null, source: "fallback" });
    expect(tierFromAnswer({ type: "noul", noul: 0.9 } as any).source).toBe("fallback");
    expect(tierFromAnswer(choice("urgente", 0.99) as any)).toEqual({ tier: "normal", confidence: null, source: "fallback" });
  });
  it("classifyTier pregunta a JEV con el pedido como state", async () => {
    const c = client({ tier: choice("trivial", 0.95) });
    expect(await classifyTier("resume este archivo", c)).toEqual({ tier: "trivial", confidence: 0.95, source: "jev" });
    expect((c.ask as any).mock.calls[0][0]).toBe("resume este archivo");
    expect(Object.keys((c.ask as any).mock.calls[0][1])).toEqual(["tier"]);
  });
  it("classifyTier sin JEV → normal", async () => {
    expect(await classifyTier("x", client(null))).toEqual({ tier: "normal", confidence: null, source: "fallback" });
  });
  it("trivialWrites: noul ≥ 0.5 escribe; sin JEV asume que escribe (conservador)", async () => {
    expect(await trivialWrites("x", client({ writes: { type: "noul", noul: 0.5 } }))).toBe(true);
    expect(await trivialWrites("x", client({ writes: { type: "noul", noul: 0.2 } }))).toBe(false);
    expect(await trivialWrites("x", client(null))).toBe(true);
  });
});

describe("pasos especiales", () => {
  it("paso trivial: agy, modelo barato, clave s1, sin dependencias", () => {
    expect(makeTrivialStep("haz X", false)).toMatchObject({
      stepIndex: 0, key: "s1", dependsOn: [], writes: false, estimatedTokens: TRIVIAL_ESTIMATED_TOKENS,
      adapter: "agy", model: TRIVIAL_MODEL, prompt: "haz X",
    });
  });
  it("revisión: depende de las hojas, solo lectura implícita, al final y con el pedido en el prompt", () => {
    const plan = {
      estimatedTokens: 30000,
      steps: [
        { stepIndex: 0, key: "s1", dependsOn: [], writes: false, estimatedTokens: 1, description: "a", adapter: "agy", model: "m", reason: "", prompt: "p" },
        { stepIndex: 1, key: "s2", dependsOn: ["s1"], writes: true, estimatedTokens: 1, description: "b", adapter: "codex", model: "m", reason: "", prompt: "p" },
        { stepIndex: 2, key: "s3", dependsOn: [], writes: false, estimatedTokens: 1, description: "c", adapter: "agy", model: "m", reason: "", prompt: "p" },
      ],
    } as any;
    const out = addReviewStep(plan, "migra la base de producción");
    const review = out.steps.at(-1)!;
    expect(out.reviewKey).toBe("review");
    expect(review).toMatchObject({ key: "review", stepIndex: 3, dependsOn: ["s2", "s3"], writes: false, adapter: "claude", model: "claude-opus-5-5", estimatedTokens: REVIEW_ESTIMATED_TOKENS });
    expect(review.prompt).toContain("migra la base de producción");
    expect(out.estimatedTokens).toBe(30000 + REVIEW_ESTIMATED_TOKENS);
  });
  it("si ya existe la clave review usa review2", () => {
    const plan = { estimatedTokens: null, steps: [{ stepIndex: 0, key: "review", dependsOn: [], writes: false, estimatedTokens: null, description: "a", adapter: "agy", model: "m", reason: "", prompt: "p" }] } as any;
    expect(addReviewStep(plan, "x").reviewKey).toBe("review2");
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run test/server/plan-tier.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Crear `src/server/plan-tier.ts`**

```ts
import { jev as defaultJev, type JevAnswer, type JevClient, type JevQuestion } from "../lib/jev.js";
import { PLANNER_MODEL } from "../config/models.js";
import type { GeneratedPlan, PlanStep } from "./planner.js";

export type Tier = "trivial" | "normal" | "critical";
export const TIER_MIN_CONFIDENCE = 0.7;
export const TRIVIAL_MODEL = "gemini-3.8-flash-low";
export const TRIVIAL_ESTIMATED_TOKENS = 15000;
export const REVIEW_ESTIMATED_TOKENS = 20000;

export const TIER_QUESTION: JevQuestion = {
  type: "choice",
  instructions: "¿Qué tan importante y riesgoso es este pedido para un orquestador de agentes de código?",
  criteria: {
    trivial: "Una sola acción simple y de bajo riesgo: una pregunta, un resumen, un cambio mínimo en un archivo; no necesita planear varios pasos.",
    normal: "Trabajo de varios pasos en código o documentos con riesgo moderado y reversible.",
    critical: "Cambios amplios o delicados: seguridad, datos de producción, dinero, borrados, migraciones, despliegues o algo difícil de revertir.",
  },
};

export const WRITES_QUESTION: JevQuestion = {
  type: "noul",
  instructions: "¿Este pedido requiere crear o modificar archivos, o ejecutar comandos que cambien el proyecto?",
};

export interface TierDecision {
  tier: Tier;
  confidence: number | null;
  source: "jev" | "fallback";
}

const TIERS: readonly Tier[] = ["trivial", "normal", "critical"];
const FALLBACK: TierDecision = { tier: "normal", confidence: null, source: "fallback" };

export function tierFromAnswer(answer: JevAnswer | undefined | null): TierDecision {
  if (!answer || answer.type !== "choice" || !(TIERS as readonly string[]).includes(answer.choice)) return FALLBACK;
  const confidence = Number(answer.confidence);
  if (!Number.isFinite(confidence)) return FALLBACK;
  return confidence >= TIER_MIN_CONFIDENCE
    ? { tier: answer.choice as Tier, confidence, source: "jev" }
    : { tier: "normal", confidence, source: "jev" };
}

export async function classifyTier(description: string, client: JevClient = defaultJev): Promise<TierDecision> {
  const answers = await client.ask(description, { tier: TIER_QUESTION });
  return tierFromAnswer(answers?.tier);
}

/** Un trivial que no sabemos si escribe se trata como escritor: así pasa por la guardia. */
export async function trivialWrites(description: string, client: JevClient = defaultJev): Promise<boolean> {
  const answers = await client.ask(description, { writes: WRITES_QUESTION });
  const a = answers?.writes;
  return a && a.type === "noul" && Number.isFinite(a.noul) ? a.noul >= 0.5 : true;
}

export function makeTrivialStep(description: string, writes: boolean): PlanStep {
  return {
    stepIndex: 0,
    key: "s1",
    dependsOn: [],
    writes,
    estimatedTokens: TRIVIAL_ESTIMATED_TOKENS,
    description: description.slice(0, 60),
    adapter: "agy",
    model: TRIVIAL_MODEL,
    reason: "Pedido trivial según JEV: un solo paso con el modelo barato, sin planear con Opus.",
    prompt: description,
  };
}

/** Plan crítico: agrega una revisión de Opus (solo lectura) que depende de todos los pasos hoja. */
export function addReviewStep(plan: GeneratedPlan, request: string): GeneratedPlan & { reviewKey: string } {
  const keys = new Set(plan.steps.map((s) => s.key));
  let reviewKey = "review";
  for (let n = 2; keys.has(reviewKey); n++) reviewKey = `review${n}`;
  const dependedOn = new Set(plan.steps.flatMap((s) => s.dependsOn));
  const leaves = plan.steps.filter((s) => !dependedOn.has(s.key)).map((s) => s.key);
  const review: PlanStep = {
    stepIndex: plan.steps.length,
    key: reviewKey,
    dependsOn: leaves,
    writes: false,
    estimatedTokens: REVIEW_ESTIMATED_TOKENS,
    description: "Revisión crítica de Opus",
    adapter: "claude",
    model: PLANNER_MODEL,
    reason: "Plan crítico: revisión obligatoria antes de la síntesis.",
    prompt:
      `Revisa críticamente el trabajo de los pasos previos para este pedido:\n"""\n${request}\n"""\n\n` +
      "Lista errores, riesgos, cosas incompletas o inseguras con referencias concretas (archivo, paso). " +
      "No modifiques nada: solo revisa y reporta. Si todo está bien, dilo explícitamente.",
  };
  return {
    steps: [...plan.steps, review],
    estimatedTokens: plan.estimatedTokens === null ? null : plan.estimatedTokens + REVIEW_ESTIMATED_TOKENS,
    reviewKey,
  };
}
```

- [ ] **Step 4: Correr tests del módulo**

Run: `npx vitest run test/server/plan-tier.test.ts`
Expected: PASS.

- [ ] **Step 5: `POST /api/plans` con tier** (`src/server/routes/plans.ts`)

Dentro del bloque en segundo plano, **antes** del ciclo de `generatePlan`:

```ts
    const tier = await classifyTier(body.description);
    await db.update(schema.plans)
      .set({ tier: tier.tier, tierConfidence: tier.confidence, tierSource: tier.source, updatedAt: new Date().toISOString() })
      .where(eq(schema.plans.id, planId));
    broadcast({ type: "plan:tier", planId, ...tier, timestamp: new Date().toISOString() } as any);
```

- Si `tier.tier === "trivial"`: **no** llamar a `generatePlan`; `generated = { steps: [makeTrivialStep(body.description, await trivialWrites(body.description))], estimatedTokens: TRIVIAL_ESTIMATED_TOKENS }` (saltar el ciclo de reintentos).
- Si `tier.tier === "critical"`: tras generar con éxito, `generated = addReviewStep(generated, body.description)`.
- Al insertar los pasos, agregar `readOnly: step.key === reviewKey ? 1 : 0` (guardar `reviewKey` del resultado de `addReviewStep`; `undefined` en los demás tiers).
- Tras emitir `plan:ready`, si el tier es trivial: `runPlanDag(planId, cwd, { mode: "all" }).catch((err) => console.error("runPlanDag trivial error:", err));` — usar `planCwd`/el mismo `cwd` ya calculado al inicio de la ruta.

Tests en `test/server/plans-routes.test.ts` (el archivo ya simula `plan-scheduler.js`; agregar `vi.mock("../../src/server/plan-tier.js", ...)` **parcial** con `vi.importActual` para controlar `classifyTier`/`trivialWrites`, y `vi.mock("../../src/server/planner.js", ...)` parcial para `generatePlan`, ambos vía `vi.hoisted`):

```ts
  it("trivial: un paso agy, sin Opus, y arranca solo", async () => {
    h.tier = { tier: "trivial", confidence: 0.95, source: "jev" };
    const r = await req("/", "POST", { description: "resume a.txt" });
    const { id } = await r.json();
    await vi.waitFor(async () => expect(h.runPlanDag).toHaveBeenCalledWith(id, expect.any(String), { mode: "all" }));
    expect(h.generatePlan).not.toHaveBeenCalled();
    const steps = await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ adapter: "agy", model: "gemini-3.8-flash-low", stepKey: "s1" });
    const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
    expect(p).toMatchObject({ tier: "trivial", tierSource: "jev", status: "pending" });
  });

  it("crítico: Opus planea, se agrega la revisión de solo lectura y NO arranca solo", async () => {
    h.tier = { tier: "critical", confidence: 0.9, source: "jev" };
    h.runPlanDag.mockClear();
    const r = await req("/", "POST", { description: "migra producción" });
    const { id } = await r.json();
    await vi.waitFor(async () => {
      const p = await db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((x) => x[0]);
      expect(p.status).toBe("pending");
    });
    const steps = (await db.select().from(schema.planSteps).where(eq(schema.planSteps.planId, id))).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(steps.at(-1)).toMatchObject({ stepKey: "review", adapter: "claude", readOnly: 1, writes: 0 });
    expect(h.runPlanDag).not.toHaveBeenCalled();
  });
```

(`h.generatePlan` devuelve un plan de un paso `{ key: "s1", adapter: "codex", ... }`; `h.tier` lo lee el mock de `classifyTier`; `trivialWrites` simulado devuelve `false`.)

- [ ] **Step 6: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS.

```bash
git add -A
git commit -m "feat: JEV clasifica el pedido (trivial sin Opus y arranca solo; crítico con revisión de Opus)"
git push
```

---

### Task 4: Guardia (`src/server/plan-guard.ts`)

**Files:**
- Create: `src/server/plan-guard.ts`, `test/server/plan-guard.test.ts`

**Interfaces:**
- Consumes: `JevClient`, `jev`, `JevQuestion` (Task 1); `DEP_RESULT_MAX_CHARS` (`plan-dag.ts`).
- Produces:
  ```ts
  export type GuardFlagId = "git" | "destructive" | "outside_project";
  export interface GuardFlag { id: GuardFlagId; label: string; probability: number; source: "jev" | "local" }
  export interface GuardResult { flagged: boolean; flags: GuardFlag[]; source: "jev" | "local" }
  export const GUARD_THRESHOLD = 0.5;
  export const GUARD_QUESTIONS: Record<GuardFlagId, JevQuestion>;
  export const GUARD_LABELS: Record<GuardFlagId, string>;
  export function buildGuardState(input: { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string }): string;
  export function localGuard(text: string, projectPath: string): GuardFlag[];
  export async function guardStep(input: { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string }, client?: JevClient): Promise<GuardResult>;
  ```

- [ ] **Step 1: Escribir `test/server/plan-guard.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { localGuard, guardStep, buildGuardState, GUARD_THRESHOLD } from "../../src/server/plan-guard.js";
import type { JevClient } from "../../src/lib/jev.js";

const P = "C:\\proyectos\\demo";
const ids = (t: string) => localGuard(t, P).map((f) => f.id).sort();
const client = (answers: Record<string, unknown> | null): JevClient => ({ configured: () => true, ask: vi.fn(async () => answers as any) });

describe("reglas locales", () => {
  it("git", () => {
    expect(ids("al final haz git push origin main")).toEqual(["git"]);
    expect(ids("git commit -am 'x'")).toEqual(["git"]);
    expect(ids("git reset --hard HEAD~3")).toEqual(["git"]);
    expect(ids("git status y git diff")).toEqual([]);
  });
  it("destructivo", () => {
    expect(ids("rm -rf build")).toEqual(["destructive"]);
    expect(ids("Remove-Item .\\dist -Recurse -Force")).toEqual(["destructive"]);
    expect(ids("DROP TABLE users;")).toEqual(["destructive"]);
    expect(ids("borra la línea 3 del README")).toEqual([]);
  });
  it("fuera del proyecto", () => {
    expect(ids("lee C:\\Users\\sidel\\.ssh\\id_rsa")).toEqual(["outside_project"]);
    expect(ids("escribe en C:\\Windows\\System32\\x.dll")).toEqual(["outside_project"]);
    expect(ids("edita C:\\proyectos\\demo\\src\\a.ts")).toEqual([]);
    expect(ids("revisa %APPDATA%\\algo")).toEqual(["outside_project"]);
  });
  it("una bandera por tipo, con probabilidad 1 y fuente local", () => {
    const f = localGuard("git push && git commit && rm -rf x", P);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.probability === 1 && x.source === "local")).toBe(true);
  });
});

describe("guardStep", () => {
  const input = { prompt: "implementa la función", deps: [{ key: "s1", result: "contexto" }], projectPath: P };

  it("con JEV: marca las preguntas ≥ umbral", async () => {
    const r = await guardStep(input, client({
      git: { type: "noul", noul: 0.93 },
      destructive: { type: "noul", noul: GUARD_THRESHOLD - 0.01 },
      outside_project: { type: "noul", noul: GUARD_THRESHOLD },
    }));
    expect(r.source).toBe("jev");
    expect(r.flagged).toBe(true);
    expect(r.flags.map((f) => [f.id, f.probability, f.source])).toEqual([["git", 0.93, "jev"], ["outside_project", GUARD_THRESHOLD, "jev"]]);
  });

  it("con JEV que dice que no a todo: no marca aunque el texto tenga 'no hagas push'", async () => {
    const r = await guardStep({ ...input, prompt: "no hagas git push" }, client({
      git: { type: "noul", noul: 0.05 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.02 },
    }));
    expect(r).toEqual({ flagged: false, flags: [], source: "jev" });
  });

  it("sin JEV: reglas locales", async () => {
    const r = await guardStep({ ...input, prompt: "luego git push" }, client(null));
    expect(r.source).toBe("local");
    expect(r.flags.map((f) => f.id)).toEqual(["git"]);
  });

  it("si JEV responde incompleto, usa reglas locales", async () => {
    const r = await guardStep({ ...input, prompt: "rm -rf x" }, client({ git: { type: "noul", noul: 0.1 } }));
    expect(r.source).toBe("local");
    expect(r.flags.map((f) => f.id)).toEqual(["destructive"]);
  });

  it("el state incluye prompt, resultados recortados y la carpeta del proyecto", () => {
    const s = buildGuardState({ prompt: "P1", deps: [{ key: "s1", result: "R".repeat(9000) }], projectPath: P });
    expect(s).toContain("P1");
    expect(s).toContain(P);
    expect(s.length).toBeLessThan(9000);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run test/server/plan-guard.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Crear `src/server/plan-guard.ts`**

```ts
import { jev as defaultJev, type JevClient, type JevQuestion } from "../lib/jev.js";
import { DEP_RESULT_MAX_CHARS } from "./plan-dag.js";

export type GuardFlagId = "git" | "destructive" | "outside_project";
export interface GuardFlag { id: GuardFlagId; label: string; probability: number; source: "jev" | "local" }
export interface GuardResult { flagged: boolean; flags: GuardFlag[]; source: "jev" | "local" }

export const GUARD_THRESHOLD = 0.5;
const IDS: GuardFlagId[] = ["git", "destructive", "outside_project"];

export const GUARD_LABELS: Record<GuardFlagId, string> = {
  git: "pide commit, push o tocar el historial/remotos de git",
  destructive: "pide borrar o sobrescribir archivos o datos",
  outside_project: "pide trabajar fuera de la carpeta del proyecto o tocar configuración del sistema/usuario",
};

export const GUARD_QUESTIONS: Record<GuardFlagId, JevQuestion> = {
  git: { type: "noul", instructions: "¿Esta tarea pide hacer commit, push, reescribir el historial o cambiar remotos de git?" },
  destructive: { type: "noul", instructions: "¿Esta tarea pide borrar archivos, carpetas o datos, o sobrescribirlos en masa?" },
  outside_project: { type: "noul", instructions: "¿Esta tarea pide leer o escribir fuera de la carpeta del proyecto indicada, o tocar configuración del sistema o del usuario?" },
};

const GIT_RE = /\bgit\s+(push|commit|rebase|filter-branch|reset\s+--hard|remote\s+(add|set-url|remove|rm))\b|\bgh\s+(pr\s+merge|repo\s+delete)\b/i;
const DESTRUCTIVE_RE = /\brm\s+-[a-z]*(rf|fr)[a-z]*\b|\bRemove-Item\b[^\n]*-Recurse|\brmdir\s+\/s\b|\bdel\s+\/[sfq]\b|\bformat\s+[a-z]:|\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i;
const SENSITIVE_RE = /(%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|\\AppData\\|[\\/]\.ssh\b|[\\/]\.claude[\\/]|[\\/]\.codex[\\/]|[\\/]\.gemini[\\/]|(^|\s)~[\\/]|\/etc\/)/i;
const WIN_ABS_RE = /[A-Za-z]:\\[^\s"'`<>|]*/g;

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/** Reglas conservadoras de respaldo (no entienden negaciones: solo se usan sin JEV). */
export function localGuard(text: string, projectPath: string): GuardFlag[] {
  const flags: GuardFlag[] = [];
  const add = (id: GuardFlagId) => flags.push({ id, label: GUARD_LABELS[id], probability: 1, source: "local" });
  if (GIT_RE.test(text)) add("git");
  if (DESTRUCTIVE_RE.test(text)) add("destructive");
  const root = norm(projectPath);
  const outside = (text.match(WIN_ABS_RE) ?? []).some((p) => {
    const n = norm(p);
    return !(n === root || n.startsWith(`${root}\\`));
  });
  if (outside || SENSITIVE_RE.test(text)) add("outside_project");
  return flags;
}

export function buildGuardState(input: { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string }): string {
  const deps = input.deps
    .map((d) => `### ${d.key}\n${(d.result ?? "").slice(0, DEP_RESULT_MAX_CHARS / 2)}`)
    .join("\n\n");
  return `Carpeta del proyecto: ${input.projectPath}\n\nTarea:\n${input.prompt}\n\nResultados previos que recibirá:\n${deps || "(ninguno)"}`;
}

export async function guardStep(
  input: { prompt: string; deps: { key: string; result: string | null }[]; projectPath: string },
  client: JevClient = defaultJev,
): Promise<GuardResult> {
  const answers = await client.ask(buildGuardState(input), GUARD_QUESTIONS);
  const complete = answers && IDS.every((id) => {
    const a = answers[id];
    return a && a.type === "noul" && Number.isFinite(a.noul);
  });
  if (!complete) {
    const text = `${input.prompt}\n${input.deps.map((d) => d.result ?? "").join("\n")}`;
    const flags = localGuard(text, input.projectPath);
    return { flagged: flags.length > 0, flags, source: "local" };
  }
  const flags: GuardFlag[] = IDS
    .map((id) => ({ id, label: GUARD_LABELS[id], probability: (answers![id] as { noul: number }).noul, source: "jev" as const }))
    .filter((f) => f.probability >= GUARD_THRESHOLD);
  return { flagged: flags.length > 0, flags, source: "jev" };
}
```

- [ ] **Step 4: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS. Si algún caso de las reglas locales falla, ajustar la regex (no el test) y anotar cuál.

```bash
git add -A
git commit -m "feat: guardia de pasos escritores con JEV y reglas locales de respaldo"
git push
```

---

### Task 5: Guardia en el planificador y aprobación del paso

**Files:**
- Modify: `src/server/plan-scheduler.ts`, `src/server/routes/plans.ts`
- Test: `test/server/plan-scheduler-guard.test.ts` (crear), `test/server/plans-routes.test.ts`

**Interfaces:**
- Consumes: `guardStep`, `GuardResult` (Task 4); columnas `guardFlags`, `guardApproved` (Task 2).
- Produces: `pause_reason = "guard"`; evento `plan:guard { planId, stepId, flags, source }`; ruta `POST /api/plans/:planId/steps/:stepId/approve` → 404 si no existe, 409 si el plan corre, si no `guardApproved = 1` y `runPlanDag(..., { mode: "all" })`, 202 `{ ok: true }`.

- [ ] **Step 1: Escribir `test/server/plan-scheduler-guard.test.ts`** (mismo patrón de adapters falsos que `test/server/plan-scheduler.test.ts`; sin `TYPESAFE_API_KEY` la guardia usa reglas locales; para el caso JEV se simula `../../src/lib/jev.js`)

```ts
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = { calls: [] as string[], jevAnswers: null as Record<string, unknown> | null };
  const ok = (summary: string) => ({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", summary, sessionId: null, model: null, costUsd: 0, inputTokens: 10, outputTokens: 0, errorMessage: null, errorFamily: null, retryNotBefore: null });
  const make = (type: string) => ({ meta: { type }, detect: async () => ({ available: true, resolvedPath: "x" }),
    execute: async (ctx: any) => { state.calls.push(/\[(s\d+)\]/.exec(ctx.prompt)?.[1] ?? "synth"); return ok("hecho"); } });
  return { state, adapters: { claude: make("claude"), codex: make("codex"), agy: make("agy") } as Record<string, any> };
});
vi.mock("../../src/adapters/registry.js", () => ({ getAdapter: (t: string) => h.adapters[t], adapters: h.adapters }));
vi.mock("../../src/lib/jev.js", async (orig) => {
  const real: any = await orig();
  return { ...real, jev: { configured: () => h.state.jevAnswers !== null, ask: async () => h.state.jevAnswers } };
});

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { runPlanDag } = await import("../../src/server/plan-scheduler.js");
const { eq } = await import("drizzle-orm");

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
beforeAll(async () => { await migrationDone; });
beforeEach(() => { h.state.calls = []; h.state.jevAnswers = null; });

async function mk(prompt: string, writes = 1) {
  const planId = randomUUID();
  const stepId = randomUUID();
  await db.insert(schema.plans).values({ id: planId, description: "d", status: "pending" });
  await db.insert(schema.planSteps).values({ id: stepId, planId, stepIndex: 0, description: "x", adapter: "codex", prompt: `[s1] ${prompt}`, status: "pending", stepKey: "s1", dependsOn: "[]", writes });
  return { planId, stepId };
}
const plan = (id: string) => db.select().from(schema.plans).where(eq(schema.plans.id, id)).then((r) => r[0]);
const step = (id: string) => db.select().from(schema.planSteps).where(eq(schema.planSteps.id, id)).then((r) => r[0]);

describe("guardia en el planificador", () => {
  it("escritor marcado (reglas locales): no se lanza, plan pending con motivo guard y banderas guardadas", async () => {
    const { planId, stepId } = await mk("al terminar haz git push");
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toEqual([]);
    expect(await plan(planId)).toMatchObject({ status: "pending", pauseReason: "guard" });
    const s = await step(stepId);
    expect(s.status).toBe("pending");
    expect(JSON.parse(s.guardFlags!)[0]).toMatchObject({ id: "git", source: "local" });
  });

  it("aprobado: corre aunque la guardia lo marque", async () => {
    const { planId, stepId } = await mk("al terminar haz git push");
    await db.update(schema.planSteps).set({ guardApproved: 1 }).where(eq(schema.planSteps.id, stepId));
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toContain("s1");
    expect((await plan(planId)).status).toBe("completed");
  });

  it("los lectores no pasan por la guardia", async () => {
    const { planId } = await mk("lee y haz git push mental", 0);
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toContain("s1");
  });

  it("con JEV que dice que no: corre aunque el texto mencione push", async () => {
    h.state.jevAnswers = { git: { type: "noul", noul: 0.02 }, destructive: { type: "noul", noul: 0.01 }, outside_project: { type: "noul", noul: 0.03 } };
    const { planId } = await mk("no hagas git push");
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toContain("s1");
  });

  it("con JEV que marca: pausa con fuente jev", async () => {
    h.state.jevAnswers = { git: { type: "noul", noul: 0.1 }, destructive: { type: "noul", noul: 0.88 }, outside_project: { type: "noul", noul: 0.1 } };
    const { planId, stepId } = await mk("limpia la carpeta");
    await runPlanDag(planId, cwd);
    expect(h.state.calls).toEqual([]);
    expect(JSON.parse((await step(stepId)).guardFlags!)).toEqual([expect.objectContaining({ id: "destructive", probability: 0.88, source: "jev" })]);
  });
});
```

En `test/server/plans-routes.test.ts` agregar:

```ts
  it("aprobar paso: marca guardApproved y relanza; 409 si corre; 404 si no existe", async () => {
    const id = await mk({ pauseReason: "guard" });
    const stepId = randomUUID();
    await db.insert(schema.planSteps).values({ id: stepId, planId: id, stepIndex: 0, description: "x", adapter: "codex", prompt: "p", status: "pending", guardFlags: "[]" });
    expect((await req(`/${id}/steps/${randomUUID()}/approve`)).status).toBe(404);
    h.running.add(id);
    expect((await req(`/${id}/steps/${stepId}/approve`)).status).toBe(409);
    h.running.delete(id);
    expect((await req(`/${id}/steps/${stepId}/approve`)).status).toBe(202);
    const s = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((x) => x[0]);
    expect(s.guardApproved).toBe(1);
    expect(h.runPlanDag).toHaveBeenLastCalledWith(id, expect.any(String), { mode: "all" });
  });
```

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run test/server/plan-scheduler-guard.test.ts test/server/plans-routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Planificador** (`src/server/plan-scheduler.ts`)
- Importar `guardStep` de `./plan-guard.js`; el tipo de `pause` pasa a `"quota" | "budget" | "guard" | null`.
- En el `for (const step of picks)`, **antes** de marcar `running`: si `step.writes && row.guardApproved !== 1`:
  ```ts
  const guard = await guardStep({ prompt: row.prompt, deps: deps.map((d) => ({ key: d.key, result: d.result })), projectPath: cwd });
  if (guard.flagged) {
    await db.update(schema.planSteps).set({ guardFlags: JSON.stringify(guard.flags) }).where(eq(schema.planSteps.id, step.id));
    emit({ type: "plan:guard", planId, stepId: step.id, flags: guard.flags, source: guard.source });
    pause = "guard";
    continue; // no se lanza; los lectores de esta misma vuelta sí
  }
  await db.update(schema.planSteps).set({ guardFlags: null }).where(eq(schema.planSteps.id, step.id));
  ```
  (usar `row.prompt`, el prompt **original** sin el encabezado de `buildStepPrompt`.)
- El resto (salida con `pause` → plan `pending` + `pause_reason` + `plan:done { paused }`) ya cubre `"guard"`.

- [ ] **Step 4: Ruta de aprobación** (`src/server/routes/plans.ts`)

```ts
app.post("/:planId/steps/:stepId/approve", async (c) => {
  const { planId, stepId } = c.req.param();
  const plan = await db.select().from(schema.plans).where(eq(schema.plans.id, planId)).then((r) => r[0]);
  const step = await db.select().from(schema.planSteps).where(eq(schema.planSteps.id, stepId)).then((r) => r[0]);
  if (!plan || !step || step.planId !== planId) return c.json({ error: "Not found" }, 404);
  if (isPlanRunning(planId)) return c.json(RUNNING, 409);
  await db.update(schema.planSteps).set({ guardApproved: 1 }).where(eq(schema.planSteps.id, stepId));
  runPlanDag(planId, await planCwd(plan), { mode: "all" }).catch((err) => console.error("runPlanDag approve error:", err));
  return c.json({ ok: true }, 202);
});
```

- [ ] **Step 5: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS. Correr `npx vitest run test/server/plan-scheduler.test.ts test/server/plan-scheduler-guard.test.ts` 3 veces seguidas.

```bash
git add -A
git commit -m "feat: la guardia pausa pasos escritores riesgosos y se aprueban desde la API"
git push
```

---

### Task 6: PlanView — tier, plan crítico y aviso de guardia

**Files:**
- Modify: `ui/src/components/PlanView.tsx`

**Interfaces:**
- Consumes: `plan.tier`, `plan.tierConfidence`, `plan.tierSource`, `plan.pauseReason === "guard"`, `step.guardFlags` (JSON `{ id, label, probability, source }[]`), `step.guardApproved`, `step.readOnly`; eventos `plan:tier`, `plan:guard`; ruta `POST /api/plans/:planId/steps/:stepId/approve`; `GET /api/jev/status`.

- [ ] **Step 1: Tipos** — `Plan` agrega `tier: "trivial" | "normal" | "critical" | null; tierConfidence: number | null; tierSource: "jev" | "fallback" | null;` y `pauseReason` incluye `"guard"`. `PlanStep` agrega `readOnly: number; guardFlags: string | null; guardApproved: number;`.

- [ ] **Step 2: Componentes**

```tsx
const TIER_TEXT = { trivial: "trivial", normal: "normal", critical: "crítico" } as const;

function TierBadge({ plan }: { plan: Plan }) {
  if (!plan.tier) return null;
  const tone = plan.tier === "critical" ? "text-err border-err/40" : plan.tier === "trivial" ? "text-ok border-ok/40" : "text-text-secondary border-edge";
  const detail = plan.tierSource === "jev"
    ? `JEV · confianza ${Math.round((plan.tierConfidence ?? 0) * 100)} %`
    : "sin JEV: se trató como normal";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone}`} title={detail}>
      {TIER_TEXT[plan.tier]}<span className="sr-only"> ({detail})</span>
    </span>
  );
}

function CriticalBanner({ plan, onApprove }: { plan: Plan; onApprove: () => void }) {
  const untouched = plan.steps.every((s) => s.status === "pending");
  if (plan.tier !== "critical" || plan.status !== "pending" || plan.pauseReason || !untouched) return null;
  return (
    <div role="status" className="mx-4 my-2 flex flex-wrap items-center gap-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-text-primary">
      <span>Plan crítico: revisa los pasos (incluye una revisión de Opus al final) y apruébalo para ejecutarlo.</span>
      <button onClick={onApprove} className="ml-auto rounded border border-err/50 px-2 py-0.5 text-err hover:text-text-primary">aprobar y ejecutar</button>
    </div>
  );
}

function GuardBanner({ plan, onApprove, onCancel }: { plan: Plan; onApprove: (stepId: string) => void; onCancel: () => void }) {
  if (plan.status !== "pending" || plan.pauseReason !== "guard") return null;
  const step = plan.steps.find((s) => s.guardFlags && s.guardApproved !== 1 && s.status === "pending");
  if (!step) return null;
  let flags: { label: string; probability: number; source: string }[] = [];
  try { flags = JSON.parse(step.guardFlags!); } catch { /* sin detalle */ }
  return (
    <div role="alert" className="mx-4 my-2 space-y-2 rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-text-primary">
      <p>La guardia detuvo el paso <strong>{step.stepKey ?? step.stepIndex + 1} — {step.description}</strong> antes de lanzarlo:</p>
      <ul className="list-disc pl-5">
        {flags.map((f, i) => <li key={i}>{f.label} · {f.source === "jev" ? `JEV ${Math.round(f.probability * 100)} %` : "regla local"}</li>)}
      </ul>
      <div className="flex gap-2">
        <button onClick={() => onApprove(step.id)} className="rounded border border-ok/40 px-2 py-0.5 text-ok hover:text-text-primary">aprobar este paso</button>
        <button onClick={onCancel} className="rounded border border-edge px-2 py-0.5 text-text-secondary hover:text-text-primary">cancelar</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Integración**
- `TierBadge` junto a `/plan` en el encabezado.
- `CriticalBanner` (con `onApprove = handleRunAll`) y `GuardBanner` (con `onApprove = (stepId) => postAction(\`/api/plans/${plan.id}/steps/${stepId}/approve\`)` y `onCancel = handleStop`) junto al `PauseBanner` existente. `PauseBanner` **no** debe mostrarse cuando `pauseReason === "guard"` (lo cubre `GuardBanner`).
- En el encabezado, cuando el plan es crítico y no ha corrido nada, el botón "ejecutar todo" se oculta (lo reemplaza el del aviso).
- Eventos: `plan:tier` → `setPlan((p) => ({ ...p, tier: e.tier, tierConfidence: e.confidence, tierSource: e.source }))`; `plan:guard` → actualizar `guardFlags` del paso (`JSON.stringify(e.flags)`); al recibir `plan:done` con `paused: "guard"`, volver a pedir el plan (`GET /api/plans/:id`) para traer las banderas.
- `StepCard`: si `readOnly === 1`, insignia "solo lectura"; si `guardApproved === 1`, insignia "aprobado".
- En `GeneratingView` (mientras se genera), si llega `plan:tier`, mostrar una línea "tier: crítico (JEV 91 %)" o "tier: normal (sin JEV)".

- [ ] **Step 4: Verificar y commit**

Run: `npm test && npm run lint && npm run typecheck && npm run build:ui`
Expected: PASS.

```bash
git add -A
git commit -m "feat: PlanView muestra el tier de JEV, el aviso de plan crítico y la guardia"
git push
```

---

### Task 7: Verificación en vivo y documentación

**Files:**
- Modify: `CLAUDE.md`, `CONTINUAR.md`, `C:\Users\sidel\Documents\Cerebro\20-Personal\Orquestador-IA.md`, `C:\Users\sidel\Documents\Cerebro\00-INICIO.md`

- [ ] **Step 1: Suite completa** — `npm test && npm run lint && npm run typecheck && npm run build:ui` en verde.

- [ ] **Step 2: Sin llave (siempre)** — servidor con base temporal (`ORQUESTADOR_DATA_DIR=<tmp> ORQUESTADOR_PORT=3199`): `GET /api/jev/status` → `{ configured: false }`; crear un plan con un pedido trivial → `tier: normal, tierSource: fallback` (Opus planea como siempre). No ejecutarlo.

- [ ] **Step 3: Con llave (solo si Alejandro ya puso `TYPESAFE_API_KEY` en `.env`)** — reiniciar el servidor; `GET /api/jev/status` → `{ configured: true }`.
  - Pedido trivial ("Resume a.txt en una oración" en un proyecto de juguete con `a.txt`): `tier: trivial, tierSource: jev`, un paso `agy`, arranca solo, termina con síntesis.
  - Pedido crítico ("Borra la tabla users de la base de producción y despliega"): **no ejecutarlo**; verificar `tier: critical` y el paso `review` de solo lectura en la UI con "aprobar y ejecutar".
  - Guardia: plan de juguete con un paso escritor cuyo prompt diga "al terminar haz git push" → pausa `guard` con fuente `jev`; "cancelar".
  - Si no hay llave, anotar estos tres como pendientes de verificación en vivo (no inventar resultados).
  - Revisar la UI en el panel de navegador (insignia de tier, avisos). Detener el servidor y borrar los temporales.

- [ ] **Step 4: Documentación**
- `CLAUDE.md`: sección "JEV (TypeSafe)": cliente que nunca lanza, `.env`/`TYPESAFE_API_KEY`, `/api/jev/status`, tiers y umbral, plan trivial/crítico, guardia (preguntas, umbral, reglas locales de respaldo, aprobación, `plan:guard`), nota de privacidad.
- `CONTINUAR.md`: lo mismo en español, cómo poner la llave y qué hace cada tier.
- Cerebro `Orquestador-IA.md`: estado F4 (y si la verificación con llave quedó pendiente); en Trampas: "JEV manda prompts a TypeSafe (retención no documentada): no usar con proyectos de clientes". `00-INICIO.md`: "(F4 hecho; F3 siguiente)". Nunca escribir la llave.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: F4 (JEV) verificado y documentado"
git push
```
