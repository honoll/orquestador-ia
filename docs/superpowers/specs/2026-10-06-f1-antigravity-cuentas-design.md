# F1 — Antigravity, cuentas y medidor · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: `2026-10-06-spike-agy.md`

## Decisiones aprobadas

1. **Adapter `agy`** (`src/adapters/agy/`, 4 archivos). `agy.exe` directo (`%LOCALAPPDATA%\agy\bin\agy.exe`,
   override `AGY_PATH`), `shell: false`, prompt por stdin en NDJSON
   (`{"event":"user","message":{"content":...}}`), `--input-format stream-json --output-format stream-json --print=`,
   `--dangerously-skip-permissions`, `--model`, `--conversation <id>` para continuar. Parser: texto de
   `step_update.text_delta`/`result.response`, tokens de `result.usage`, `conversation_id`, errores de
   `result.error`; errores de cuota → `errorFamily: "quota_exhausted"` (+ hora de reinicio si el texto la trae).
   Modelos en el catálogo verificados con `npm run smoke:models -- agy`.
2. **Se retira Gemini CLI** (adapter, tests, referencias de UI). El pre-análisis de adjuntos pasa a `agy` con
   `gemini-3.8-flash-low` en `POST /api/analyze`. El planner rutea `claude | codex | agy`.
3. **Cuentas** (tabla `agy_accounts`): etiqueta libre, activa (solo una), tope manual 5 h y 7 d, tope calibrado
   5 h, bloqueo por cuota hasta, notas. Nunca credenciales. Cada llamada a `agy` exige cuenta activa y registra
   su consumo en la tabla `agy_usage` (chat, plan y análisis).
   Botón **"Cambiar cuenta"**: abre una terminal visible con `agy` interactivo; el usuario cierra sesión y entra
   con otra cuenta; luego marca en el orquestador cuál quedó activa (el orquestador no puede leerla).
4. **Medidor estimado**: tokens por cuenta en ventanas de 5 h y 7 d. Tope efectivo = manual si existe, si no el
   calibrado. Calibración: al primer error de cuota, lo gastado en la ventana de 5 h pasa a ser el tope calibrado
   (la ventana semanal solo tiene tope manual: no se puede saber cuál ventana se agotó). Si el error trae hora de
   reinicio se guarda; si no, se estima ahora + 5 h. Un éxito posterior en esa cuenta limpia el bloqueo.
   Aviso "conviene cambiar de cuenta" a partir de **85 %** o con bloqueo vigente. Nunca cambia de cuenta solo.
5. **Pausa por cuota en planes**: si un paso de `agy` da `quota_exhausted`, no se reintenta ni falla: el paso
   vuelve a `pending` con mensaje "Pausado por cuota…", el plan queda `pending` y la UI ofrece reintentar tras
   cambiar de cuenta. Sin cambios a los CHECK de SQLite.
6. **UI/HUD**: barra superior (cuenta activa, uso 5 h "~70 % · estimado · se reinicia en 2 h", aviso, tokens de
   la sesión) y panel de cuentas (lista, uso por ventana, agregar, usar esta, eliminar, editar topes, cambiar cuenta).
7. **Pruebas**: parser con fixtures reales del spike, medidor como funciones puras con reloj inyectable,
   repositorio de cuentas contra una base temporal, smoke de modelos `agy`.
8. **Pendientes de F0**: regex del smoke (`/^ok\.?$/i`), `planner.ts` a LF + `.gitattributes`.

## Fuera de alcance
DAG/paralelo y síntesis de Opus (F2), Obsidian (F3), JEV (F4), voz (F5). Rotación automática de cuentas.
