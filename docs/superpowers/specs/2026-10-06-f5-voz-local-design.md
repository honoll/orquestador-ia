# F5 — Voz local · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: F3b en `main` (merge 7dd79f5)

## Decisiones aprobadas
1. **Oídos: whisper.cpp** (`whisper-server`, build Windows CUDA 12.4 de la release b5454) con el modelo
   `ggml-large-v3-turbo-q5_0.bin`. Si el build CUDA no usa la RTX 5070 (Blackwell), se usa el build CPU
   `whisper-bin-x64.zip`. El orquestador lanza `whisper-server` en `127.0.0.1` la primera vez que se necesita y lo
   deja con el modelo cargado; se apaga con el servidor. El audio del navegador se convierte a WAV 16 kHz mono con
   `ffmpeg` y se transcribe en español.
2. **Boca: Piper** (`piper_windows_amd64`, 2023.11.14-2) con la voz **`es_MX-claude-high`** (alternativa
   `es_MX-ald-medium`). Se quita el markdown; modo resumen = primeras 2–3 oraciones.
3. **Interacción (A, revisar antes de enviar):** botón "mantén para hablar" en el chat y en `/plan`; el texto
   transcrito se escribe en la caja para revisarlo y enviarlo a mano. Botón "escuchar" en respuestas y síntesis;
   interruptor "leer en voz alta automáticamente" (lee el resumen corto al terminar).
4. **Instalación** en `C:\tools\voz\` (fuera de AppData por la virtualización MSIX).
5. **Verificación en vivo** sin hablar: Piper genera una frase en español → Whisper la transcribe → se compara;
   después el usuario prueba el micrófono.

## Fuera de alcance
Manos libres (envío automático), detección de palabra clave, voz en los trabajadores.
