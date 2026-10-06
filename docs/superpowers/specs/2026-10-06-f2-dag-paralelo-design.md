# F2 — Plan como grafo en paralelo y síntesis de Opus · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: F1 en `main` (merge 8ada463)

## Decisiones aprobadas

1. **Plan como DAG.** El planner (Opus 5.5) devuelve por paso `id`, `dependsOn`, `writes` (lee/escribe) y
   `estimatedTokens`, y para el plan `estimatedTokens`. Se valida: claves únicas, sin dependencias a pasos
   inexistentes, sin auto-dependencia, sin ciclos. Planes viejos (sin claves) = cadena lineal que escribe.
2. **Paralelismo "A": lectores en paralelo, escritores en fila.** Corren todos los pasos listos (dependencias
   `succeeded`/`skipped`) hasta `maxParallel` (default **3**, configurable 1–5 por plan). Nunca dos escritores a
   la vez; un lector puede correr junto a un escritor. Sin worktrees.
3. **Contexto mínimo.** Cada paso recibe solo los resultados de sus dependencias directas, recortados a
   **4000** caracteres cada uno.
4. **Planificador dueño del plan.** `runPlanStep` solo ejecuta el paso y devuelve `{ status: succeeded | failed |
   paused_quota, tokensUsed }`; el estado del plan, `plan:done`, el watcher y la cancelación los maneja solo el
   planificador (`src/server/plan-scheduler.ts`). Si un paso falla: no arranca más, espera a los que corren, plan
   `failed`. Antes de lanzar pasos `agy` revisa si la cuenta activa está bloqueada por cuota: si lo único listo es
   `agy` bloqueado, pausa (`pause_reason = quota`) sin gastar llamada.
5. **Presupuesto "A": pausar y preguntar.** Tope por defecto = **1.5 ×** la estimación de Opus (editable). Se
   cuentan los tokens de todos los intentos y de la síntesis. Al alcanzarlo: termina lo que corre, no arranca más,
   pausa con `pause_reason = budget`. "Continuar" sube el tope **+50 %** (sobre el mayor entre tope y usado).
6. **Síntesis final.** Con todos los pasos hechos, Opus 5.5 (`PLANNER_MODEL`, vía adapter claude en **modo solo
   lectura**, cwd temporal) recibe el pedido original y los resultados (recortados a **6000** c/u, marcados como
   datos no confiables) y escribe la respuesta final en español. Se guarda en el plan. Si falla, el plan queda
   `completed` con `synthesis_status = failed` y un botón "reintentar síntesis".
7. **UI.** Diagrama por niveles (pasos paralelos apilados), insignia lee/escribe y tokens por paso, barra de
   presupuesto con tope editable y paralelismo, aviso de pausa (cuota o presupuesto) con "continuar", tarjeta de
   respuesta final con markdown. Cancelar mata los procesos en curso.
8. **Pendiente de F1.** Una sola cuenta activa garantizada: transacción en activar/borrar + índice único parcial.

## Fuera de alcance
Worktrees y escritores en paralelo, Obsidian (F3), JEV (F4), voz (F5).
