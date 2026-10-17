# Modo equipo: tareas acotadas — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el Jefe del modo equipo (F14) reparta tareas acotadas (qué leer, qué entregar) para que cada turno de agy gaste mucho menos contexto de entrada.

**Architecture:** La API de delegación exige `leer` y `entrega` y los guarda dentro del prompt de la tarea; cada turno completo de una hija lleva una regla fija de alcance; el resumen de una hija avisa si su turno pasó de 60k tokens de entrada; los textos (Jefe, guía, roles) empujan a tareas pequeñas; REDACTOR pasa a Flash.

**Tech Stack:** Node + TypeScript, Hono, drizzle/SQLite, vitest.

Spec: `docs/superpowers/specs/2026-10-16-equipo-acotar-tareas-design.md`.

## Global Constraints

- Worktree `C:\estudio\orquestador-ia-acotar`, rama `equipo-acotar-tareas`. Comandos SIEMPRE desde ahí.
- Textos de interfaz y prompts en español de México, con acentos correctos.
- Sin dependencias nuevas, sin migraciones, sin cambios de UI.
- Topes nuevos en `src/server/equipo/constants.ts`: `LEER_MAX_ITEMS = 10`, `LEER_ITEM_MAX = 200`, `ENTREGA_MAX = 300`, `TOPE_TOKENS_TURNO = 60_000`.
- Las consultas `@rol` (`createChildTask(..., { consulta: true })`) NO exigen `leer`/`entrega`.
- Commits en español terminando con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca stagear `.superpowers/` ni `AGENTS.md`. No hacer push (lo hace el coordinador).
- Pruebas: `npx vitest run <archivo>`; al final de cada tarea `npx vitest run test/server/equipo` + `npm run typecheck` + `npm run lint` (0 errores; los warnings previos se quedan).

---

### Task 1: `leer` y `entrega` obligatorios al delegar + aviso de gasto

**Files:**
- Modify: `src/server/equipo/constants.ts`
- Modify: `src/server/equipo/tasks.ts` (`createChildTask`, `childSummary`)
- Test: `test/server/equipo-tasks.test.ts`, `test/server/equipo-agente.test.ts`
- Update callers in tests: `test/server/equipo-agente.test.ts`, `equipo-bandejas.test.ts`, `equipo-routes.test.ts`, `equipo-scheduler.test.ts` (incluido su helper `delegar`), `equipo-tasks.test.ts`

**Interfaces:**
- Produces: `createChildTask(planId, parentStepId, input: { rol?, titulo?, instrucciones?, esperar?, leer?, entrega? }, opts)`; `plan_steps.prompt` = instrucciones + bloques; `childSummary(step)` con aviso; constantes de arriba.

- [ ] **Step 1: Pruebas que fallan** (en `test/server/equipo-tasks.test.ts`, describe "árbol de tareas")

```ts
const ALC = { leer: ["src/x.ts"], entrega: "3 viñetas" };

it("createChildTask exige leer y entrega y los guarda en el prompt", async () => {
  const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
  const { id } = await t.createChildTask(planId, rootStepId, { rol: "lector", titulo: "Lee", instrucciones: "Resume x", leer: ["src/x.ts", " CLAUDE.md § Team mode (F14) "], entrega: "3 viñetas, máx 80 palabras" });
  expect((await t.getStep(id))!.prompt).toBe("Resume x\n\nLEE SOLO:\n- src/x.ts\n- CLAUDE.md § Team mode (F14)\n\nENTREGA: 3 viñetas, máx 80 palabras");
  const ok = { rol: "dev", titulo: "a", instrucciones: "b" };
  for (const bad of [
    { ...ok, entrega: "e" },                                  // sin leer
    { ...ok, leer: [], entrega: "e" },
    { ...ok, leer: "src/x.ts", entrega: "e" },                // no es arreglo
    { ...ok, leer: [""], entrega: "e" },
    { ...ok, leer: ["x".repeat(201)], entrega: "e" },
    { ...ok, leer: Array(11).fill("a"), entrega: "e" },
    { ...ok, leer: ["a"] },                                   // sin entrega
    { ...ok, leer: ["a"], entrega: "x".repeat(301) },
  ]) await expect(t.createChildTask(planId, rootStepId, bad)).rejects.toMatchObject({ status: 400 });
});

it("una consulta @rol no exige leer ni entrega", async () => {
  const { planId, rootStepId } = await t.createGoal({ pedido: "m" });
  const { id } = await t.createChildTask(planId, rootStepId, { rol: "qa", titulo: "Consulta", instrucciones: "¿pasa?" }, { consulta: true });
  expect((await t.getStep(id))!.prompt).toBe("¿pasa?");
});

it("childSummary avisa cuando el turno pasó del tope de tokens de entrada", () => {
  const base = { status: "succeeded", statusDetail: null, result: "ok", errorMessage: null } as any;
  expect(t.childSummary({ ...base, inputTokens: 60_001 })).toContain("AVISO: su último turno gastó 60001 tokens de entrada (tope 60000)");
  expect(t.childSummary({ ...base, inputTokens: 60_000 })).not.toContain("AVISO");
  expect(t.childSummary({ ...base, inputTokens: null })).toBe("succeeded: ok");
});
```

Y en `test/server/equipo-agente.test.ts`, junto a los 400 existentes:

```ts
expect((await req("/tareas", token, { rol: "dev", titulo: "t", instrucciones: "x" })).status).toBe(400);
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run test/server/equipo-tasks.test.ts test/server/equipo-agente.test.ts` — Expected: FAIL (prompt sin bloques, sin aviso, sin 400).

- [ ] **Step 3: Implementación mínima**

`constants.ts`:

```ts
export const LEER_MAX_ITEMS = 10;
export const LEER_ITEM_MAX = 200;
export const ENTREGA_MAX = 300;
/** Tokens de entrada de un turno a partir de los cuales el resumen de la hija avisa al Jefe. */
export const TOPE_TOKENS_TURNO = 60_000;
```

`tasks.ts`, en `createChildTask` (tipo de `input` con `leer?: unknown; entrega?: unknown`), tras validar `instrucciones`:

```ts
const prompt = opts.consulta ? instrucciones : `${instrucciones}\n\n${alcance(input.leer, input.entrega)}`;
```

y usar `prompt` en el `insert` en lugar de `instrucciones`. Helper junto a `text`:

```ts
const EJEMPLO_ALCANCE = `por ejemplo "leer": ["src/slug.mjs", "CLAUDE.md § Team mode (F14)"], "entrega": "5 viñetas, máx 150 palabras"`;
/** Bloques LEE SOLO / ENTREGA que acotan a la hija (obligatorios al delegar). */
function alcance(leer: unknown, entrega: unknown): string {
  if (!Array.isArray(leer) || leer.length < 1 || leer.length > LEER_MAX_ITEMS
    || leer.some((x) => typeof x !== "string" || !x.trim() || x.length > LEER_ITEM_MAX)) {
    throw new TeamError(400, `"leer" debe ser una lista de 1 a ${LEER_MAX_ITEMS} rutas o secciones exactas (máx ${LEER_ITEM_MAX} caracteres cada una), ${EJEMPLO_ALCANCE}`);
  }
  if (typeof entrega !== "string" || !entrega.trim() || entrega.length > ENTREGA_MAX) {
    throw new TeamError(400, `"entrega" debe decir formato y largo en 1 a ${ENTREGA_MAX} caracteres, ${EJEMPLO_ALCANCE}`);
  }
  return `LEE SOLO:\n${leer.map((x) => `- ${(x as string).trim()}`).join("\n")}\n\nENTREGA: ${entrega.trim()}`;
}
```

`childSummary`:

```ts
export function childSummary(step: StepRow): string {
  const detalle = step.statusDetail ? ` (${step.statusDetail})` : "";
  const aviso = (step.inputTokens ?? 0) > TOPE_TOKENS_TURNO
    ? ` · AVISO: su último turno gastó ${step.inputTokens} tokens de entrada (tope ${TOPE_TOKENS_TURNO}): acota más (leer, entrega) la próxima vez.`
    : "";
  return `${step.status}${detalle}: ${clip(step.result ?? step.errorMessage ?? "(sin resultado)", RESUMEN_HIJA_MAX)}${aviso}`;
}
```

- [ ] **Step 4: Actualizar las llamadas existentes en pruebas**

Toda llamada de prueba a `createChildTask` sin `{ consulta: true }` y todo `req("/tareas", …)` que espera 201 recibe `leer: ["x"], entrega: "breve"` (p. ej. `...ALC` con una constante local por archivo). Las que prueban un 400/409 por OTRO motivo también llevan los campos para que el 400/409 venga del motivo que prueban. El helper `delegar` de `equipo-scheduler.test.ts` también los manda.

- [ ] **Step 5: Correr**

Run: `npx vitest run test/server/equipo` — Expected: PASS todo. Luego `npm run typecheck` y `npm run lint`.

- [ ] **Step 6: Commit**

```bash
git add src/server/equipo/constants.ts src/server/equipo/tasks.ts test/server/equipo-*.test.ts
git commit -m "Equipo: delegar exige leer y entrega; aviso de gasto en el resumen de la hija"
```

---

### Task 2: Regla de alcance en el turno de las hijas + textos del Jefe y la guía

**Files:**
- Modify: `src/server/equipo/prompts.ts` (`JEFE_BODY`, `GUIA_MINIMA`, `REGLA_ALCANCE`, `TurnInput.alcance`, `buildTurnPrompt`)
- Modify: `src/server/equipo/team-scheduler.ts` (`promptFor`: pasar `alcance`)
- Modify: `roles/_equipo.md` y `roles/_originales/_equipo.md` (mismo contenido)
- Test: `test/server/equipo-prompts.test.ts`

**Interfaces:**
- Consumes (Task 1): la API ya exige `leer` (arreglo) y `entrega` (texto).
- Produces: `export const REGLA_ALCANCE: string`; `TurnInput.alcance?: boolean`.

- [ ] **Step 1: Pruebas que fallan** (`test/server/equipo-prompts.test.ts`)

```ts
import { REGLA_ALCANCE } from "../../src/server/equipo/prompts.js"; // añadir al import existente

it("regla de alcance: en turno completo de hija (escriba o solo lectura), no en el Jefe ni al retomar", () => {
  expect(buildTurnPrompt({ ...base, alcance: true }, "G", "n")).toContain(REGLA_ALCANCE);
  expect(buildTurnPrompt({ ...base, alcance: true, escribe: false }, "G", "n")).toContain(REGLA_ALCANCE);
  expect(buildTurnPrompt(base, "G", "n")).not.toContain(REGLA_ALCANCE);
  expect(buildTurnPrompt({ ...base, alcance: true, resume: true }, "G", "n")).not.toContain(REGLA_ALCANCE);
});

it("el Jefe y las guías piden leer y entrega", () => {
  expect(JEFE_BODY).toContain('"leer"');
  expect(JEFE_BODY).toContain('"entrega"');
  expect(JEFE_BODY).toContain("CLAUDE.md");
  const guia = fs.readFileSync(path.join(process.cwd(), "roles", "_equipo.md"), "utf8");
  expect(guia).toContain('"leer"');
  expect(guia).toBe(fs.readFileSync(path.join(process.cwd(), "roles", "_originales", "_equipo.md"), "utf8"));
});
```

(Si el archivo ya prueba `loadEquipoGuide` sin argumentos contra el texto mínimo, ajustar esa prueba a `GUIA_MINIMA` nueva solo si se rompe.)

- [ ] **Step 2: Correr y ver que fallan** — `npx vitest run test/server/equipo-prompts.test.ts`.

- [ ] **Step 3: Implementación**

`prompts.ts`:

```ts
/** Va en todo turno completo de una hija: el gasto de agy es casi todo contexto leído. */
export const REGLA_ALCANCE = `ALCANCE (obligatorio): lee solo lo que dice LEE SOLO en tu tarea. Busca con grep_search y lee rangos de líneas; no abras completos archivos grandes (CLAUDE.md, lockfiles, dist/, node_modules/) ni recorras el proyecto. Si de verdad te falta algo, lee lo mínimo y dilo en tu entrega. Respeta el formato y largo de ENTREGA.`;
```

`TurnInput` gana `alcance?: boolean;` y en `buildTurnPrompt` (rama completa, no `resume`) se inserta `t.alcance ? REGLA_ALCANCE : ""` justo antes del bloque `${STEP_TASK_HEADER}…`.

`team-scheduler.ts` `promptFor`: añadir `alcance: step.role !== JEFE_ROL,` al objeto que pasa a `buildTurnPrompt` (`JEFE_ROL` ya se usa en ese archivo).

`JEFE_BODY`, sección "## Qué haces", reemplazar la viñeta de delegar por:

```
- Delegas con la API (POST /api/equipo/tareas). Cada tarea lleva SIEMPRE "leer" (lista de rutas o secciones exactas, máx 10) y "entrega" (formato y largo, p. ej. "5 viñetas, máx 150 palabras"); sin ellos la API responde 400.
- Cada tarea es UNA pregunta o UN entregable. Si necesitaría leer más de ~10 archivos o producir varias cosas, pártela en varias tareas.
- En "instrucciones" das el contexto que ya sabes (rutas, decisiones, nombres): la otra agente no ve tu conversación y cada archivo que tenga que buscar cuesta tokens.
- Leer y resumir va a LECTOR (modelo barato); DEV, QA y REDACTOR solo para escribir o probar.
- Nunca pidas "lee CLAUDE.md" (u otro documento grande) completo: nombra la sección (p. ej. "CLAUDE.md § Team mode (F14)") o el rango de líneas.
```

y añadir en "## Qué no haces": `- No mandas tareas abiertas ("revisa el proyecto", "lee todo y propón"): cuestan la cuota de agy de horas.`

`GUIA_MINIMA`: `{rol,titulo,instrucciones,leer,entrega,esperar}` en lugar de `{rol,titulo,instrucciones,esperar}`.

`roles/_equipo.md` (y copia idéntica en `roles/_originales/_equipo.md`): en "## Delegar una subtarea a otro rol" añadir el párrafo

```
Toda tarea lleva `leer` (lista de 1 a 10 rutas o secciones exactas que la otra agente debe leer, p. ej.
`["src/slug.mjs", "CLAUDE.md § Team mode (F14)"]`) y `entrega` (formato y largo, p. ej. `"5 viñetas, máx 150
palabras"`). Sin ellos la API responde 400. Una tarea = una pregunta o un entregable.
```

y en los dos ejemplos (Bash JSON y PowerShell hashtable) añadir los campos: `"leer":["src/form.ts"],"entrega":"PASA/FALLA y máx 5 viñetas"` / `leer = @("src/form.ts"); entrega = "PASA/FALLA y máx 5 viñetas"`. En "## Reglas" añadir: `- Lee solo lo que dice LEE SOLO en tu tarea; no recorras el proyecto ni abras completos archivos grandes.`

- [ ] **Step 4: Correr** — `npx vitest run test/server/equipo` PASS, `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/server/equipo/prompts.ts src/server/equipo/team-scheduler.ts roles/_equipo.md roles/_originales/_equipo.md test/server/equipo-prompts.test.ts
git commit -m "Equipo: regla de alcance en cada turno de hija; el Jefe y la guía piden leer y entrega"
```

---

### Task 3: Roles: leer solo lo indicado, entregas cortas, REDACTOR en Flash

**Files:**
- Modify: `roles/{lector,investigador,redactor,dev,qa,imagen}.md` y la copia idéntica de cada uno en `roles/_originales/`
- Test: `test/server/roles.test.ts` (o el archivo de pruebas de roles que exista; buscar con `grep -rln "roles/_originales\|loadRoles" test`)

**Interfaces:** ninguna nueva. `parseRole` debe seguir aceptando cada archivo.

- [ ] **Step 1: Prueba que falla**

```ts
it("roles reales: REDACTOR en Flash y originales idénticos a los editables", () => {
  const dir = path.join(process.cwd(), "roles");
  expect(getRole("redactor", dir)!.modelo).toBe("gemini-3.8-flash-medium");
  for (const id of ["lector", "investigador", "redactor", "dev", "qa", "imagen"]) {
    expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf8")).toBe(fs.readFileSync(path.join(dir, "_originales", `${id}.md`), "utf8"));
    expect(fs.readFileSync(path.join(dir, `${id}.md`), "utf8")).toMatch(/LEE SOLO/);
  }
});
```

(Antes de escribirla, comprobar que hoy cada rol editable es idéntico a su original con `git diff --no-index roles/x.md roles/_originales/x.md`; si alguno difiere, avisar al coordinador en vez de pisarlo.)

- [ ] **Step 2: Correr y ver que falla.**

- [ ] **Step 3: Editar cada rol (y su original, mismo texto)**

- `redactor.md`: frontmatter `modelo: gemini-3.8-flash-medium`.
- En "## Qué haces" de `lector.md` cambiar la primera viñeta ("Recorres la estructura con…") por:
  `- Lees lo que nombra LEE SOLO en tu tarea; si necesitas ubicar algo, usa grep_search y view_file con rango de líneas. No recorras el proyecto con list_dir/find_by_name salvo que la tarea lo pida.`
- En `dev.md`, `redactor.md`, `qa.md`, `investigador.md`, `imagen.md`, en "## Qué haces", donde dice que lee antes de editar/escribir/probar, añadir al final de esa viñeta: ` Lee solo lo que nombra LEE SOLO en tu tarea (y lo mínimo que te falte); no abras completos archivos grandes como CLAUDE.md.` Si el rol no tiene una viñeta así, agregar una viñeta nueva con: `- Lees solo lo que nombra LEE SOLO en tu tarea (y lo mínimo que te falte); no abras completos archivos grandes como CLAUDE.md.`
- En "## Cómo entregas" de los 6, añadir una línea al final de la sección: `Respeta el formato y largo de ENTREGA en tu tarea; si no dice, máximo ~200 palabras.`

- [ ] **Step 4: Correr** — la prueba de roles, `npx vitest run test/server/equipo`, cualquier prueba que use el modelo de REDACTOR (`grep -rn "redactor" test | grep -i "sonnet"`; actualizar a `gemini-3.8-flash-medium` si alguna fija el modelo), `npm run typecheck`, `npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add roles/*.md roles/_originales/*.md test/
git commit -m "Roles: leer solo lo indicado, entregas cortas y REDACTOR en Gemini Flash"
```

---

### Task 4 (coordinador): prueba en vivo y docs

No es para subagente. Cuando la cuota de agy se libere (bloqueo hasta ~2026-10-17T04:21Z):
1. Servidor de prueba `:3111` con `main` y la misma meta en `f11-demo`; luego `:3111` con la rama y la misma meta.
2. Comparar tokens por turno en `plan_steps`/`runs`/`agy_usage`.
3. Sección corta en `CLAUDE.md` (Team mode F14: campos `leer`/`entrega`, regla de alcance, aviso 60k, REDACTOR en Flash, resultados medidos), nota de Cerebro del Orquestador, commit y push. Merge solo con OK de Alejandro.
