# Roles de agentes

Cada archivo `<id>.md` de esta carpeta es un rol: las instrucciones que recibe un agente de agy cuando el Jefe le
asigna un paso. El orquestador los lee con `src/server/roles.ts`; los cambios se ven sin reiniciar.

## Formato

```markdown
---
id: dev
nombre: DEV
modelo: claude-sonnet-4-6
modeloDificil: claude-opus-4-6-thinking
escribe: true
herramientasPermitidas: [view_file, run_command]
presupuestoTokens: 50000
---
## Identidad
## Qué haces
## Qué no haces
## Cómo entregas
## Terminado cuando
## Estado final
```

- `id`: igual al nombre del archivo (`dev` → `dev.md`); minúsculas, números y guiones.
- `modelo`: modelo de agy por defecto. `modeloDificil` (opcional): el que se usa si el Jefe marca el paso como difícil.
- `adaptadores` (opcional, default `[agy]`): con qué CLIs puede correr el rol, `agy` y/o `codex`. Si incluye `codex`, `PLANNER_ADAPTERS` lo permite y el Jefe elige codex para ese paso, corre en Codex con `modeloCodex` (default del catálogo de codex); si no, va a agy con `modelo`. Hoy solo DEV lo usa.
- `escribe`: `true`, `false` (solo lectura) o `salidas` (solo escribe en la carpeta de salidas del plan).
  Ojo: con `false` agy corre sin permisos y **niega todo `run_command`** (probado 2026-10-15, también con `--mode auto`);
  un rol que deba correr pruebas o builds (QA) necesita `true` y la regla "no edites" va en su texto.
- `herramientasPermitidas`: lista informativa de herramientas de agy, en una sola línea `[a, b]`.
- `presupuestoTokens` (opcional): entero positivo.
- Las 6 secciones son obligatorias y van en ese orden. "Estado final" debe pedir como última línea
  `<<<ESTADO terminado>>>`, `<<<ESTADO bloqueado {"detalle":"motivo concreto"}>>>` o
  `<<<ESTADO necesita {"detalle":"qué necesitas"}>>>`.

## Agregar un rol

Crea `roles/<id>.md` con el formato de arriba. Un archivo inválido se omite con un aviso en el log del servidor.

`_originales/` guarda la versión original de cada rol incluido para "restaurar" desde la app; no se edita a mano.
