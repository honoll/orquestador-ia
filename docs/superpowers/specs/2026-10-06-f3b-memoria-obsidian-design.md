# F3b — Memoria en Obsidian · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: F3a en `main` (merge aede2ca)

## Decisiones aprobadas
1. **Fuente (B):** se lee de **toda** la bóveda Cerebro (`CEREBRO_PATH`, default `%USERPROFILE%\Documents\Cerebro`,
   407 notas en español) y se escribe **solo** en `Cerebro/Orquestador/Planes/`. Nunca se modifican notas existentes.
2. **Búsqueda (B): semántica con Ollama local** y el modelo **`bge-m3`** (multilingüe, descargado el 2026-10-06).
   Índice por secciones (encabezados, trozos ≤ ~1500 caracteres) en tablas de la base del orquestador; incremental
   por fecha de modificación; se actualiza al arrancar, antes de cada plan y con un botón "reindexar".
3. **Recuperación:** consulta = pedido; similitud coseno contra todos los trozos; top **5** notas (mejores trozos)
   dentro de **~6k tokens** (~24 000 caracteres); **siempre** la nota del proyecto (por `ruta:` del frontmatter o por
   nombre). La memoria va al prompt de **Opus como planner**, marcada como datos no confiables; los trabajadores no
   la reciben directa. Sin Ollama o sin modelo → solo la nota del proyecto y aviso "memoria limitada".
   Planes triviales (sin Opus) no usan memoria.
4. **Escritura (A): una nota por plan completado** `Cerebro/Orquestador/Planes/AAAA-MM-DD-<tema>.md` con frontmatter
   de la bóveda (`tipo: plan-orquestador`, `estado: terminado`, `ruta`, `actualizado`, `tags`, tier, tokens), pedido,
   pasos, resultado, **decisiones y aprendizajes** (que la síntesis de Opus devuelve en un bloque aparte, sin llamada
   extra) y enlace a la nota del proyecto. Filtro de secretos antes de escribir. La nota se indexa.
5. **UI:** panel "memoria usada" por plan (notas y relevancia), enlace a la nota escrita (también `obsidian://`),
   indicador del índice (notas, trozos, última actualización, estado de Ollama) con "reindexar".

## Fuera de alcance
Memoria en el chat directo; memoria para trabajadores; reemplazar la inyección de historial del chat.
