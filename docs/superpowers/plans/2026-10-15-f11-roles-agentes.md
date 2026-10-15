# F11 — Roles de agentes · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** que el Jefe (Claude, plan Max) asigne un rol a cada paso y que cada agente de agy trabaje con el prompt
especializado de su rol, entregue con un estado final obligatorio y, si es IMAGEN, guarde en la carpeta de salidas.
Spec: `docs/superpowers/specs/2026-10-15-f11-roles-agentes-design.md`.

**Architecture:** roles como archivos `roles/<id>.md` (frontmatter + secciones) leídos por `src/server/roles.ts`;
`plan_steps.role`; el planner recibe el catálogo y asigna rol; el prompt del paso = rol + tarea + dependencias; el
modelo/read_only salen del rol; `<<<ESTADO …>>>` decide succeeded/failed; UI: rol en pasos y Oficina, editor de roles.

**Tech Stack:** Hono, Drizzle/libsql, React, vitest. Sin dependencias nuevas.

## Global Constraints
- Rama `f11-roles` desde `f10-agy-cuentas`. Orden de integración F7 → F8 → F10 → F11 → F9.
- Roles iniciales e ids exactos: `dev`, `qa`, `imagen`, `investigador`, `lector`, `redactor`. Modelos por defecto:
  dev `claude-sonnet-4-6` (difícil: `claude-opus-4-6-thinking`), qa `claude-sonnet-4-6`, imagen
  `gemini-3.8-flash-high`, investigador `gemini-3.8-flash-medium`, lector `gemini-3.8-flash-low`, redactor
  `claude-sonnet-4-6`. `escribe`: dev true, qa true (2026-10-15: agy en solo lectura niega todo `run_command`), imagen `salidas`, investigador false, lector false, redactor true.
- Secciones obligatorias del archivo de rol (en este orden, español de México): `## Identidad`, `## Qué haces`,
  `## Qué no haces`, `## Cómo entregas`, `## Terminado cuando`, `## Estado final`.
- Estado final: `<<<ESTADO terminado>>>` | `<<<ESTADO bloqueado {"detalle":"…"}>>>` |
  `<<<ESTADO necesita {"detalle":"…"}>>>`; sin estado → `failed` "sin estado final". Pasos sin rol (planes viejos,
  revisión crítica) no exigen estado.
- Carpeta de salidas: `<proyecto>/.orquestador/salidas/<planId>/`; agregar `.orquestador/` al `.gitignore` del
  proyecto si falta (avisar en el log del plan).
- Inspiración Paperclip (MIT, © 2025 Paperclip AI): si se copia texto literal de sus prompts, conservar el aviso.
- Cada tarea: TDD, `npm test`, `npm run lint` (0 errores), `npm run typecheck` (+ `npm run build:ui` si toca UI).
  Commits en español + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write/Edit. Nunca stagear
  `.superpowers/` ni `AGENTS.md`.

---

### Task 1: Archivos de rol y su lector
**Files:** Create `roles/{dev,qa,imagen,investigador,lector,redactor}.md`, `src/server/roles.ts`; Test `test/server/roles.test.ts`.
```ts
export interface RoleDef { id: string; nombre: string; modelo: string; modeloDificil?: string; escribe: boolean | "salidas";
  herramientas: string[]; presupuestoTokens?: number; body: string /* markdown sin frontmatter */ }
export function parseRole(markdown: string, fileId: string): RoleDef;   // valida frontmatter + 6 secciones en orden
export function loadRoles(dir?: string): RoleDef[];                     // dir por defecto <repo>/roles; inválidos → se omiten con aviso
export function getRole(id: string): RoleDef | null;
```
- [ ] Tests (rol válido; falta sección → error claro; frontmatter inválido; id ≠ nombre de archivo → error) → escribir
  los 6 roles (cada uno concreto: qué herramientas de agy usar, formato de entrega, criterios) → checks → commit →
  `git push -u origin f11-roles`.

### Task 2: Planner con roles, prompt del paso y estado final
**Files:** `src/db/schema.ts` + `migrate.ts` (`plan_steps.role` text nullable, `plan_steps.status_detail` text),
`src/server/planner.ts` (catálogo de roles en el prompt del Jefe; cada paso con `role` y `dificil?`), `plan-create.ts`
(guarda role; modelo/read_only desde el rol), `src/server/plan-dag.ts` `buildStepPrompt` (encabezado del rol + tarea +
dependencias), `src/server/step-status.ts` (`parseStepStatus(text) → {kind, detalle} | null`), `plan-runner.ts`
(aplica el estado), `buildSynthesisPrompt` (rol + estado por paso).
- [ ] Tests: prompt del Jefe lista los 6 roles; normalización asigna modelo/read_only por rol (dev difícil → opus);
  rol inválido → `lector` si `writes=0`, `dev` si escribe; prompt del paso empieza con el cuerpo del rol; parseo de los
  3 estados y ausencia; runner marca failed con detalle; síntesis incluye rol/estado. → checks → commit → push.

### Task 3: Carpeta de salidas e IMAGEN
**Files:** `src/server/outputs.ts` (`outputsDir(projectPath, planId)`, crear carpeta, asegurar `.gitignore`),
`plan-runner.ts` (pasa la ruta de salidas en el prompt de pasos `escribe: "salidas"`; después del paso, si hubo
archivos nuevos/modificados fuera de esa carpeta (comparar `git status --porcelain` antes/después cuando el proyecto
es git) → aviso en el log del paso y `status_detail`), ruta `GET /api/plans/:id/outputs` (lista archivos) y
`GET /api/plans/:id/outputs/:name` (sirve el archivo, solo dentro de la carpeta).
- [ ] Tests (ruta de salidas, `.gitignore` idempotente, servir sin path traversal, aviso de escritura fuera) → checks → commit → push.

### Task 4: UI — rol en pasos y Oficina, salidas, editor de roles
**Files:** rutas `GET /api/roles`, `PUT /api/roles/:id` (valida con `parseRole` antes de guardar; nunca fuera de
`roles/`), `POST /api/roles/:id/restore` (restaura desde `roles/_originales/<id>.md`, que Task 1 debe crear como copia);
UI: etiqueta de rol en `PlanView` (pasos) y miniaturas de `outputs`; `office-state` y Oficina con "ROL · cuenta" en
cada escritorio de AGY; vista "Roles" (lista + editor markdown + guardar/restaurar) accesible desde la barra.
- [ ] Tests de rutas (validación, traversal, restore) y helpers puros de UI → checks + `build:ui` → captura → commit → push.

### Task 5: Verificación en vivo y documentación
- [ ] Plan real con LECTOR + DEV + QA + IMAGEN repartido en las 4 cuentas (agy) y síntesis del Jefe; imagen visible
  en la carpeta de salidas y en PlanView; estados finales leídos.
- [ ] Docs: `## Roles (F11)` en `CLAUDE.md`, `CONTINUAR.md`, nota de Cerebro. Integrar solo con OK del usuario.
