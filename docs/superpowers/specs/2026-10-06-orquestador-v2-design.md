# Orquestador-IA v2 — diseño estratégico

Fecha: 2026-10-06 · Estado: aprobado en conversación (orden de fases F0→F5)

## Visión

Opus 5.5 es el director. Recibe el pedido (texto o voz), consulta la memoria en Obsidian,
clasifica la importancia (JEV), descompone en pasos y le da a cada trabajador
(Antigravity `agy`, Gemini CLI, Codex) un prompt mínimo y específico. Al final Opus une
los resultados en una sola respuesta. Los tokens caros se gastan solo en planear y unir.

```
Usuario (texto/voz) → Opus planea (DAG) → pasos independientes en paralelo
  → cada trabajador recibe solo su paquete de contexto
  → resultados resumidos → Opus une → respuesta (+ voz) → aprendizaje a Obsidian
```

## Restricciones duras (Antigravity)

Base: respuesta de staff de Google en el foro oficial (2026): lanzar el binario oficial
`agy` como proceso hijo local, de un solo usuario, es uso soportado. Prohibido extraer o
reenviar tokens OAuth, o llamar a los endpoints de Antigravity directamente.

- Solo el binario oficial `agy`, sin modificar, como proceso hijo.
- El orquestador **nunca** lee, copia ni reenvía credenciales; no llama a endpoints de Google.
- Una cuenta activa a la vez. El cambio de cuenta lo decide y ejecuta el usuario; el
  orquestador solo avisa. **No hay rotación automática al agotar cuota.**
- No se usan switchers de terceros (agyp, agym, agy-switch, etc.): leen cuota con tokens
  contra endpoints internos.

## Fases

### F0 — Rescate y base
- Actualizar modelos (Opus 5.5 planner/sintetizador; versiones vigentes de Gemini y Codex).
- Quitar rutas de la laptop (`C:\Users\sidel\orquestador-ia`) de docs y código.
- Agregar tests (vitest) y linter; el proyecto hoy no tiene ninguno.
- Spike `agy`: instalarlo; confirmar `agy -p --output-format json`; averiguar si acepta
  carpetas de sesión aisladas por cuenta sin tocar credenciales; buscar comando oficial
  de uso/cuota. El resultado del spike se documenta y decide el diseño de F1.

### F1 — Antigravity y cuentas
- Adaptador `agy` (4 archivos: index/detect/execute/parse) registrado en el registry.
- Panel de cuentas: "Iniciar sesión" (corre el `agy login` oficial), "Usar esta",
  barra de uso por cuenta y hora de reinicio.
- Uso: si `agy` tiene comando oficial, se usa; si no, **estimación** local (tokens
  contados por cuenta desde la salida JSON + errores de cuota con su hora de reinicio).
  La UI lo etiqueta como estimado.
- Si el spike muestra que no hay aislamiento por carpeta, cambiar de cuenta = logout +
  login oficial.

### F2 — Opus como director
- Planes como DAG (dependencias entre pasos); pasos independientes en paralelo.
- Un git worktree por trabajador que edita código.
- Paso final obligatorio de síntesis por Opus.
- Presupuesto de tokens por plan; costo/tokens visibles por paso.

### F3 — Memoria Obsidian
- Carpeta propia dentro de la bóveda Cerebro; sin secretos.
- Antes de planear: recuperar notas relevantes (texto + etiquetas; embeddings con
  Ollama solo si hace falta).
- Al terminar: Opus escribe decisiones y aprendizajes.
- Reemplaza la inyección de las últimas 20 vueltas de historial.

### F4 — JEV (tiers de importancia)
- **Pendiente de definición por el usuario** (qué es JEV y qué clasifica). No se diseña
  hasta tenerla.

### F5 — Voz local
- Oídos: faster-whisper local, push-to-talk en la UI.
- Boca: Piper o Kokoro local, lee el resumen corto de la síntesis final.

### HUD/UI (transversal, crece con cada fase)
- Barra superior: cuenta `agy` activa + uso, tokens de la sesión, estado de voz, tier JEV.
- Vista del plan como grafo con agentes en paralelo en vivo.
- Panel de memoria: notas inyectadas por paso.

## Riesgos
| Riesgo | Mitigación |
|---|---|
| Baneo de cuentas Antigravity | Solo `agy` oficial, sin tokens, sin rotación automática; probar primero con cuenta desechable |
| Cuota familiar compartida entre miembros | El medidor lo mostrará en la práctica; no asumir cuota por miembro |
| Choques de archivos en paralelo | Worktree por trabajador |
| Uso real de cuota no legible legítimamente | Estimación etiquetada como tal |

## Fuera de alcance
- Rotación automática de cuentas, proxies, extracción de credenciales.
- Multiusuario / acceso remoto (sigue siendo local, `127.0.0.1`).
