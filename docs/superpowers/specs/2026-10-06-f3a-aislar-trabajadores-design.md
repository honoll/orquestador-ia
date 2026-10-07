# F3a — Aislar a los trabajadores · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: F4 en `main` (merge 24dce88)

## Problema
En la verificación de F2 un paso de Codex estimado en 12k gastó 168k tokens: cargó skills y el `AGENTS.md` global del
usuario y siguió instrucciones globales (buscar MAQUINAS.md, hacer commit). Decisión del usuario (opción A): los
trabajadores **conservan** el `AGENTS.md`/`CLAUDE.md` del proyecto y **pierden todo lo global** (skills, plugins, MCP,
hooks, memoria, instrucciones generales).

## Medición (spike 2026-10-06, carpeta de juguete con AGENTS.md/CLAUDE.md de proyecto)

| CLI | Normal | Aislado | ¿Globales? | ¿Proyecto? |
|---|---|---|---|---|
| Codex | 17.3k in | 10.7k in (`--ignore-user-config` + `--disable …`) | **sí** (`~/.codex/AGENTS.md` sigue) | sí |
| Claude | 37k (caché) | 39.6k | **no** con `--setting-sources project,local --strict-mcp-config --disable-slash-commands` | sí (sin aislar lo ignoró) |
| agy | 11.8k | 11.8k | no | sí |

Codex con `CODEX_HOME` vacío: 401 (sin sesión). `codex login status`: exit 0 "Logged in…", exit 1 "Not logged in".

## Decisiones
1. **Claude** (trabajadores, chat, planner y síntesis): siempre `--setting-sources project,local --strict-mcp-config
   --disable-slash-commands`. `readOnly` sigue agregando `--disallowedTools …`.
2. **Codex**: siempre `--ignore-user-config` y `--disable` de `plugins apps hooks browser_use computer_use
   image_generation skill_search multi_agent goals tool_suggest personality`. Además **perfil de trabajador**:
   `CODEX_HOME = <datos del orquestador>/workers/codex` (fuera de AppData), con sesión propia que el usuario inicia una
   vez con el flujo oficial (`codex login` en una terminal visible abierta por un botón). El orquestador solo consulta
   `codex login status` (exit code), nunca lee ni copia credenciales. Sin sesión en el perfil → se usa el `CODEX_HOME`
   normal con las banderas y la UI avisa "Codex aislado parcialmente".
3. **agy**: sin cambios (medido sin fuga).
4. **Verificación en vivo** tras el login del usuario: marcador `BIBLIA_ECOSISTEMA` → "no", `PROYECTO-OK` presente,
   tokens medidos, y un paso **escritor** de Codex edita archivos con `--ignore-user-config`.

## Fuera de alcance
F3b (memoria en Obsidian). Quitar el costo fijo de agy (no es posible).
