# F11 — Roles de agentes · diseño

Fecha: 2026-10-15 · Estado: aprobado en conversación · Base: F10 (`f10-agy-cuentas`). Orden de integración:
F7 → F8 → F10 → F11 → F9.

## Flujo (decidido por el usuario)
El usuario le da la tarea a **Claude (el Jefe, plan Max)** → el Jefe la divide en partes y a cada parte le asigna un
**rol** con su prompt especializado → los **agentes de agy** (cualquier cuenta libre, F10) hacen el trabajo en
paralelo → el Jefe junta todo en la síntesis y da el resultado. Claude Code solo trabaja como agente cuando un paso
de verdad lo requiere (p. ej. la revisión crítica).

## Inspiración: Paperclip (MIT)
Analizado el paquete local `paperclipai` v2026.831.1 (licencia MIT, © 2025 Paperclip AI). Se toma: rol = etiqueta +
archivo de instrucciones en markdown; guía de rol con secciones (identidad, carta del rol, criterios de terminado);
un solo agente por tarea; presupuesto por agente; estado final obligatorio al terminar. No se toma (por ahora):
organigrama de varios niveles, agentes que contratan agentes, despertares por reloj, aprobación de estrategia por
"board". Si se copia texto de sus prompts, se conserva el aviso de copyright MIT.

## Roles iniciales
| Rol | Hace | Modelo agy (por defecto) | Escritura | Herramientas clave de agy |
|---|---|---|---|---|
| DEV | escribe/modifica código y corre pruebas | `claude-sonnet-4-6`; `claude-opus-4-6-thinking` si el Jefe marca "difícil" | sí | editar archivos, `run_command` |
| QA | prueba lo hecho: corre pruebas, revisa la página en navegador, reporta fallas | `claude-sonnet-4-6` | no (solo reporta) | `run_command`, navegador, capturas |
| IMAGEN | genera imágenes (íconos, ilustraciones, sprites) y las guarda en la carpeta de salidas | `gemini-3.8-flash-high` | solo en la carpeta de salidas | `generate_image` |
| INVESTIGADOR | busca en internet y resume con fuentes | `gemini-3.8-flash-medium` | no | `search_web`, `read_url_content` |
| LECTOR | lee el repo y resume (estructura, dónde está algo) | `gemini-3.8-flash-low` | no | lectura |
| REDACTOR | documentación, textos y copys en español de México | `claude-sonnet-4-6` | sí (texto/markdown) | editar archivos |

## Definición de un rol
- Archivo `roles/<id>.md` en el repo del orquestador, con frontmatter: `id`, `nombre`, `modelo`, `modeloDificil?`,
  `escribe` (true/false/`salidas`), `herramientasPermitidas` (lista informativa para el prompt), `presupuestoTokens?`;
  y secciones fijas: **Identidad** (quién eres, a quién entregas: al Jefe), **Qué haces**, **Qué no haces**,
  **Cómo entregas** (formato), **Terminado cuando** (criterios), **Estado final** (bloque obligatorio).
- **Estado final obligatorio** al final de cada respuesta del agente:
  `<<<ESTADO terminado|bloqueado|necesita {"detalle": "…"}>>>`; el orquestador lo lee: `terminado` → paso
  `succeeded`; `bloqueado` o `necesita` → paso `failed` con el detalle visible y disponible para el Jefe.
- Carpeta de salidas por plan: `<proyecto>/.orquestador/salidas/<planId>/` (imágenes y artefactos); IMAGEN solo
  escribe ahí. Ignorada por git por defecto (se agrega a `.gitignore` del proyecto si no está, con aviso).
- Roles editables desde la app (vista "Roles": lista, editor de markdown, restaurar el original); los cambios se
  guardan en el archivo. Agregar un rol = nuevo archivo.

## Planner y ejecución
- El prompt del Jefe incluye el catálogo de roles (id, qué hace, escribe sí/no) y le pide asignar `role` a cada paso
  (y `dificil: true` para DEV cuando aplique). `plan_steps` gana `role` (texto, null en planes viejos).
- El prompt del paso = contenido del archivo de rol (como instrucciones del sistema/encabezado) + la tarea específica
  del Jefe + resultados de dependencias (como hoy, cercados como datos). Modelo y `read_only` salen del rol
  (`escribe:false` → read_only 1).
- Pasos con rol van a agy (F10, reparto por cuota). La revisión crítica sigue en `claude`.
- Presupuesto por rol (opcional): si un paso de ese rol rebasa `presupuestoTokens`, el plan se pausa por presupuesto
  con el rol indicado.
- La síntesis del Jefe recibe, por paso, el rol y el estado final.

## UI
- Oficina: cada escritorio de AGY muestra el rol que está haciendo ("DEV · agy3"); las tarjetas cuentan por rol.
- PlanView: etiqueta de rol en cada paso; carpeta de salidas enlazada (y miniaturas de imágenes).
- Vista "Roles" (editor).

## Pruebas
Parser de archivos de rol y validación; armado del prompt con rol; lectura del estado final (cada variante y
ausente → `failed` "sin estado final"); asignación de modelo/read_only por rol; IMAGEN restringido a la carpeta de
salidas (instrucción + verificación post-paso de archivos fuera de la carpeta → aviso). En vivo: un plan que use
LECTOR + DEV + QA + IMAGEN con las cuentas de agy.

## Fuera de alcance
Organigrama multinivel, agentes que crean agentes, despertares por reloj, roles por cuenta fija.
