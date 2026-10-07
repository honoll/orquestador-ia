# F6 — Asistente de voz conversacional · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: F5 en `main` (merge af3b7a0)

## Mediciones previas (spike 2026-10-06)
- `agy` con `gemini-3.8-flash-low`, proceso nuevo por pregunta: primer texto ~4 s, total 6–12 s.
- **Un solo proceso `agy` con varias entradas `{"event":"user",…}` por stdin** (stream-json): turno 1 ≈ 7.6 s,
  turnos siguientes ≈ 2.4 s, y conserva el contexto (respondió bien "¿de qué te pregunté primero?"). Cada turno termina
  con un evento `result` (`status: SUCCESS`, `response`); el texto llega antes en eventos `step_update`
  (`step_type: agent_response`). Al escribir el NDJSON desde PowerShell se cuela un BOM (`﻿`) y agy lo rechaza:
  escribir siempre desde Node.
- Latencia estimada de punta a punta: silencio de fin de frase ~0.8 s + Whisper ~0.4 s + agy ~2.4 s + primera oración
  de Piper ~0.5 s ≈ **4 s**.
- Equipo del usuario: bocina Alexa por Bluetooth (retraso variable) y micrófono Blue Snowball (capta el cuarto) → alto
  riesgo de eco.

## Decisiones aprobadas
1. **Modo conversación sin manos (A).** Botón "Platicar" en el chat abre una vista con un círculo de estado
   (escuchando / pensando / hablando) y la transcripción en vivo. Al entrar se abre y calienta la sesión de agy.
   Se sale con "Terminar", diciendo una frase de cierre ("ya, gracias", "terminamos") o tras **3 min** sin voz.
2. **Ciclo de turno:** Silero VAD en el navegador detecta inicio y fin de voz (fin = ~0.8 s de silencio; voz mínima
   ~300 ms; frase máxima 60 s) → Whisper (F5) → se descartan transcripciones vacías y alucinaciones típicas de Whisper
   sobre ruido ("Gracias por ver el video", "Subtítulos por…", etc.) → agy contesta en pedazos → Piper empieza con la
   primera oración completa y encadena las siguientes → vuelve a escuchar.
3. **Interrupción (B + interruptor):** mientras el asistente habla, el micrófono **no escucha**; **Esc**, **espacio** o
   clic en el círculo lo interrumpen (corta el audio y la cola) y pasa a escuchar. Interruptor **"interrumpir con la
   voz"** (apagado por defecto, guardado en localStorage con try/catch): el VAD sigue activo al hablar con umbral más
   alto; se calibra en vivo con la Alexa + Snowball.
4. **Volumen de otras apps:** razón nueva de ducking `conversation` mientras el modo está abierto (todo menos el
   navegador, como `speak`), con lease renovable como F5. Se restaura al salir.
5. **Estilo:** español de México, respuestas de 2–3 oraciones, sin markdown ni listas largas; si algo es largo ofrece
   dejarlo escrito en el chat.
6. **Cerebro (agy) — modelo rápido por Antigravity (A):** un proceso `agy` persistente por sesión con
   `gemini-3.8-flash-low`, en una carpeta temporal vacía, **solo lectura** (sin `--dangerously-skip-permissions`), sin
   la llave de JEV (`withoutOrchestratorSecrets`). Usa la cuenta activa y registra el uso en `agy_usage` con fuente
   `voice`. Cuota agotada → lo dice en voz y cierra el modo; nunca cambia de cuenta. Si el proceso muere, se reabre una
   vez (perdiendo contexto de agy pero reinyectando los últimos turnos como texto); si vuelve a fallar, aviso y salida.
7. **Memoria por turno:** consulta = la frase del usuario; máximo **3** notas con `MEMORY_MIN_SCORE` 0.55 y ~6 000
   caracteres; solo si hay notas que pasen el umbral; cercadas como datos con nonce y pasadas por `redactSecrets`.
8. **Planes por voz con confirmación:** agy puede terminar su respuesta con una marca
   `<<<ACCION plan {"pedido": "...", "proyecto": "..."}>>>` (se quita antes de hablar) y preguntar "¿lo arranco?".
   El servidor guarda la acción pendiente y **solo** la ejecuta si la **siguiente frase del usuario** es un sí claro
   (lista cerrada: "sí", "dale", "arráncalo", "hazlo", "va", "órale"… sin negación); cualquier otra frase la descarta.
   El proyecto debe existir en la base (se le da a agy la lista de proyectos); si no, pregunta cuál. El plan sigue el
   flujo normal (tier JEV, Opus, guardia). Trivial y normal: crear + `run-all`. Crítico: se crea y avisa que hay que
   aprobarlo en pantalla. Al terminar/pausarse/fallar un plan iniciado por voz, si el modo sigue abierto se anuncia en
   voz con el resumen corto.
9. **Qué se guarda (B):** cada turno se guarda como conversación normal del chat (adaptador `agy`), visible y
   continuable. Al cerrar, si hubo ≥ 2 turnos, agy escribe un resumen en la misma sesión y se crea una nota nueva
   `Cerebro/Orquestador/Platicas/AAAA-MM-DD-HHmm-<tema>.md` (`tipo: platica-orquestador`, `estado`, `actualizado`,
   `tags`, enlaces a los planes lanzados), con `redactSecrets` y las mismas reglas de escritura que las notas de plan
   (solo archivos nuevos, `flag: "wx"`). Se indexa como el resto, marcada de menor confianza y con tope de 2 por turno.

## Seguridad
- Las notas de memoria, los resultados de planes y lo que diga agy son datos: ninguna acción se ejecuta sin la
  confirmación hablada del usuario evaluada en el servidor.
- agy en solo lectura y en carpeta vacía; las rutas `/api/voice/assistant/*` pasan el `originGuard` de F5.
- Privacidad: frases transcritas y extractos de memoria van a Google (agy); el resumen de la plática se queda en la
  bóveda local.

## Errores
Whisper caído → aviso en pantalla y sigue escuchando. agy caído → un reintento y luego salida con aviso. Piper caído
→ la respuesta queda escrita. Micrófono sin permiso → mensaje claro y no entra al modo.

## Pruebas
Pruebas puras: máquina de estados del modo, parser de marcas de acción, detector de "sí", armado de oraciones en
streaming, memoria por turno, nota de plática. agy simulado (nunca se lanzan exes reales). En vivo: plática de 3 turnos
con agy real midiendo latencias; un plan lanzado por voz; prueba de eco Piper → Alexa → Snowball para calibrar el
interruptor.

## Dependencia nueva
Silero VAD en el navegador (p. ej. `@ricky0123/vad-web` + `onnxruntime-web`): antes de instalar se informa nombre,
origen y tamaño exactos para aprobación.

## Fuera de alcance
Palabra clave siempre escuchando; agy con herramientas (archivos/web); voz en los trabajadores; varias sesiones de voz
a la vez.
