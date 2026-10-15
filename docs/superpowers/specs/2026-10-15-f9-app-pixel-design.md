# F9 — Toda la app en estilo pixel · diseño

Fecha: 2026-10-15 · Estado: aprobado en conversación · Base: F8 (`f8-oficina`, sobre F7). Orden de integración a
`main`: F7 → F8 → F9. Maqueta aprobada: `docs/superpowers/specs/assets/f9-app-pixel-maqueta.html`.

## Decisiones aprobadas
1. **Nivel C, "todo pixel"**, excepto el código: VT323 para todo el texto, Silkscreen (400/700) para títulos,
   etiquetas y botones; **JetBrains Mono** solo para código (bloques y `code` en markdown, comandos, rutas,
   logs de pasos, salidas de agentes).
2. **Fuentes locales (descarga aprobada, ya bajadas):** subconjunto latino de Google Fonts, licencia OFL —
   `vt323-400.woff2` 17 936 B, `silkscreen-400.woff2` 8 404 B, `silkscreen-700.woff2` 7 524 B, más `OFL-VT323.txt` y
   `OFL-Silkscreen.txt`. Copia de trabajo en
   `C:\Users\sidel\AppData\Local\Temp\claude\C--\f5b352d1-366d-4594-8baf-5c3a3529cab3\scratchpad\fonts\` → destino
   `ui/public/fonts/` (servidas por la app, sin red al usarla).
3. **Capa de tema global + ajustes por pantalla** (no se reescriben componentes):
   - `ui/src/index.css`: `@font-face` de las 3 fuentes (`font-display: swap`); `body` en VT323 con tamaño base
     ~20 px; títulos/etiquetas/botones en Silkscreen; `code, pre, kbd, samp, .font-code` en JetBrains Mono;
     tokens de radio de Tailwind en 0 (esquinas cuadradas); bordes un poco más claros (`--color-edge` visible en
     marcos de 3 px).
   - Clases: `px-panel` (marco 3 px + sombra dura 3 px), `px-btn` (+ `px-btn-pri` morado, `px-btn-blue` azul; se
     "hunde" 2 px al presionar), `px-tag` (etiqueta de estado), `px-input`, `px-grid` (rejilla de fondo 24 px).
   - Foco visible: contorno pixel de 2 px. `prefers-reduced-motion` respetado.
4. **Avatares pixel en el chat**: el personaje del modelo que respondió (Opus → Jefe con sombrero; Sonnet/Haiku →
   Claude; codex → Codex; agy → Agy), reutilizando `spriteFrame`/`AgentSprite` de F8, sin animación.
5. **Iconos de estado pixel** unificados (✓ ▶ ⏸ ✗ ⊘ ↷) con color fijo por estado en todas las pantallas.

## Pantallas
| Pantalla | Cambios |
|---|---|
| `HudBar` | barra de cuota pixel, punto "en línea", selector CHAT/OFICINA como `px-btn`. |
| Columna izquierda (`AdapterPanel`, `AccountsPanel`, `MemoryStatus`, `WorkerIsolationNotice`) | títulos Silkscreen, modelo elegido en marco morado con sombra, cuentas en `px-panel` con medidor, avisos en marcos amarillo/rojo. |
| `Chat` | burbujas `px-panel` (usuario morado; modelo con avatar y nombre en Silkscreen), markdown en VT323 con código en Mono dentro de bloque oscuro enmarcado, fila de entrada (adjuntos, micrófono, Platicar azul, Enviar morado) como la maqueta. |
| `ConversationView` (Platicar grande) | el círculo pasa a botón grande pixel de 3 tonos: gris reposo, azul escuchando, morado pensando, verde hablando; frases en `px-panel`. |
| `PlanView` | tarjetas de paso `px-panel` con borde del color de su estado, `px-tag`, barra de presupuesto pixel, banners de pausa (cuota/presupuesto/guardia) en marco amarillo con su botón, respuesta final con avatar del Jefe; logs en Mono. |
| `ProjectPanel` | listas con iconos pixel, activo en marco morado, "nuevo proyecto" `px-btn`. |
| `GitHubCloneModal`, `FileContextPicker` | marco 3 px, fondo oscurecido, botones pixel. |
| Oficina (F8) | solo ajustes a las fuentes nuevas. |

## Legibilidad y accesibilidad
Contraste AA (≥ 4.5:1) en todo texto; ningún texto VT323 < 16 px; interlineado algo mayor en respuestas largas;
foco visible; reduced motion.

## Pruebas
Funciones puras con vitest: `avatarRoleFor(adapter, model)` (modelo → personaje) y `statusStyle(status)`
(estado → icono y color). `npm run build:ui`. Revisión visual por tarea en el panel de navegador a 1300 y 1000 px con
captura; recorrido final (chat, plan, Platicar, Oficina, ventanas).

## Fuera de alcance
Reorganizar pantallas o agregar funciones; es un cambio de piel: todo hace lo mismo que hoy.
