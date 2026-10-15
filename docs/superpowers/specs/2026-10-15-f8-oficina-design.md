# F8 — Vista "Oficina" (estilo pixel-art) · diseño

Fecha: 2026-10-15 · Estado: aprobado en conversación · Base: F7 (`f7-app-escritorio`, puerto 3110) — F8 se construye
encima de esa rama. Referencia visual del usuario: tablero "Craft Office" (agentes pixel-art en escritorios, cola,
PRs, log). Maqueta aprobada (v2): `docs/superpowers/specs/assets/f8-oficina-maqueta.html`.

## Decisiones aprobadas
1. **Ubicación (A):** vista nueva **Oficina** al lado del **Chat**, con selector `Chat | Oficina` en la barra
   superior. Chat queda igual. En Oficina se reemplazan el centro y la columna derecha; la columna izquierda
   (adaptadores, cuentas, memoria) se queda.
2. **Elenco:**
   | Personaje | Color | Accesorio | Qué es | Trabaja cuando |
   |---|---|---|---|---|
   | JEFE | `#a78bfa` | sombrero rojo | Opus 5.5 (planner y síntesis) | hay plan `generating` o síntesis `running` |
   | GUARDIA | `#fbbf24` | gorra con placa | JEV (tier y guardia) | evento `plan:tier`/`plan:guard` en los últimos 8 s; marca "pausó" mientras haya pasos pausados por guardia |
   | AGY ×N | `#60a5fa` | antena | pasos/chat con agy | pasos `running` con adaptador agy, o run de chat `running` |
   | CODEX ×N | `#34d399` | lentes | pasos/chat con codex | ídem codex |
   | CLAUDE ×N | `#e879f9` | moño | pasos/chat con claude (incl. revisión crítica) | ídem claude (excepto planner/síntesis, que son del JEFE) |
   | BIBLIO | `#f472b6` | pila de libros | memoria (Ollama bge-m3 + Cerebro) | indexando, o `plan:memory loading` en los últimos 20 s |
   | RECEPCIÓN | `#fb923c` | diadema | voz (Whisper/Piper/Platicar) | sesión de Platicar activa o Whisper `starting/warming` |
3. **Paneles:** tarjetas por personaje arriba (estado, modelo, última actividad, tokens de la sesión); **rack** con
   las cuentas de Antigravity (barra de cuota 5 h, activa encendida, bloqueada en rojo); **Cola** (pasos `pending`
   y `running` de planes activos); **Planes** (recientes con estado); **Log** (eventos WS en vivo).
4. **Estilo (v2):** personajes en `<canvas>` de 28×22 escalados ×4 (`image-rendering: pixelated`), cabeza en bloque
   con 3 tonos (claro/base/oscuro derivados del color), cara-pantalla con ojos, de lado frente a su monitor con
   teclado, escritorio con franja de su color. Trabajando: rebote de 1 px, texto que corre en el monitor, tecleo,
   parpadeo ocasional, 4 cuadros/s. En reposo: gris, ojos cerrados, monitor apagado, "z". Escena con pared, reloj,
   letrero "ORQUESTADOR · OFICINA", zonas DIRECCIÓN / TRABAJADORES / SERVICIOS y plantas.
5. **Datos (foto + WS):** `GET /api/office/state` arma una foto del momento desde la base y el estado en memoria;
   la UI la pide al abrir la Oficina y la refresca (debounce 300 ms) ante eventos `plan:*`, `run:status`,
   `memory:indexed`, `voice:assistant:*`, `accounts:changed`. El log se arma en la UI con los eventos desde que se
   abrió la página (últimos 100).

## Arquitectura
**Servidor**
- `src/server/office-state.ts`: `buildOfficeState(input): OfficeState` **puro** (recibe filas/estados y `now`), y
  `collectOfficeInput()` que lee: planes `generating`/síntesis `running`; `plan_steps` `running`/`pending` de
  planes activos (con adaptador, descripción, plan); `runs` `running` (chat); tokens de la sesión por adaptador
  (misma ventana que `GET /api/usage/session`: desde el arranque del servidor) + `agy_usage`; estado del índice
  de memoria (`indexing`); sesión de voz activa (`activeAssistant()`) y estado de Whisper; últimos eventos
  `plan:tier`/`plan:guard`/`plan:memory` (marcas de tiempo guardadas por un `onBroadcast` en memoria).
- Ruta `GET /api/office/state` (`src/server/routes/office.ts`) →
  `{ agents: AgentState[], queue: QueueItem[], generatedAt }` con
  `AgentState = { id: "jefe"|"guardia"|"agy"|"codex"|"claude"|"biblio"|"recepcion", working: boolean,
  desks: number (1–4), activity: string, model: string, tokens: number, paused?: boolean }` y
  `QueueItem = { planId, stepId, stepKey, description, adapter, status: "running"|"pending"|"paused", project }`
  (máx. 20, `running` primero).
- Rack y Planes reutilizan `/api/accounts` y la lista de planes existente.

**UI** (`ui/src/components/office/`, lógica en `ui/src/lib/office.ts`)
- `OfficeView` (foto + refresco por eventos con `useWs().subscribe`), `AgentCards`, `OfficeScene`,
  `AgentSprite` (canvas; anima solo si `working` y la pestaña está visible; `prefers-reduced-motion` → sin
  animación), `AccountRack`, `QueuePanel`, `PlansPanel`, `LogPanel`. Clic en un plan o paso → `setActivePlanId`
  y cambia a Chat donde se ve `PlanView`.
- `ui/src/lib/office.ts` (puro, con pruebas): `spriteFrame(role, working, t): Rect[]`, `shade(hex, f)`,
  `eventToLog(ev): { time, agent, text, color } | null`, `deskCount(n)` (mín. 1, máx. 4, etiqueta "×N" si n > 1).
- Selector `Chat | Oficina` en `HudBar`; preferencia en localStorage (try/catch); `?vista=oficina` la abre.

**Accesibilidad y tamaños**
- Escena `aria-hidden`; la información está en texto en tarjetas y paneles. Etiquetas en reposo con contraste
  AA (≥ 4.5:1 sobre el fondo). `prefers-reduced-motion` respetado.
- ≥ 1280 px: como la maqueta. 900–1280 px: paneles debajo de la escena. < 900 px: escena escalada para caber.

## Errores
Si `/api/office/state` falla, la vista muestra la última foto con un aviso "sin conexión con el servidor" y
reintenta con el siguiente evento o cada 10 s. Un evento desconocido se ignora en el log.

## Pruebas
Vitest: `buildOfficeState` (cada regla de "trabaja cuando", escritorios ×N, tokens por adaptador, cola ordenada y
truncada, ventanas de 8 s/20 s con `now` inyectado), ruta (200 y forma), `spriteFrame` (accesorio por rol; en
reposo sin texto en monitor y ojos cerrados), `eventToLog`, `deskCount`. `npm run build:ui`. Verificación en vivo:
abrir la Oficina, lanzar un plan y ver al JEFE trabajar, luego a los trabajadores, y el log/cola actualizarse;
recargar a mitad del plan y ver el estado correcto.

## Fuera de alcance
Arrastrar personajes, sonidos, pausar la oficina, editar la escena, música (la referencia tiene "Pause office" y
música: no se incluyen), fuentes pixel descargadas.
