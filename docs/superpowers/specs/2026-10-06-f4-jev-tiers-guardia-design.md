# F4 — JEV para tiers y guardia · diseño

Fecha: 2026-10-06 · Estado: aprobado en conversación · Base: F2 en `main` (merge 8baaf95)

JEV (TypeSafe AI, 15-sep-2026) es un modelo "System One": no genera texto, devuelve decisiones tipadas.
API: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, cuerpo
`{ state, model: "jev-latest", questions }`. Preguntas usadas: **Choice** (`criteria` opción → descripción;
respuesta `choice`, `confidence`, `probabilities`) y **Noul** (respuesta `noul` = probabilidad de "sí").

## Decisiones aprobadas

1. **Cliente propio** (`src/lib/jev.ts`) con `fetch` (sin dependencias), timeout 10 s, un reintento en 429/529,
   nunca lanza: si falla devuelve `null` y el orquestador usa la alternativa. Llave en `.env` (gitignored) que el
   servidor carga con `process.loadEnvFile`; `.env.example` documenta `TYPESAFE_API_KEY`.
2. **Tier del pedido** en `POST /api/plans`, antes de Opus: Choice trivial | normal | critical. Confianza
   **< 0.7** o JEV no disponible → **normal**. Se guarda tier, confianza y fuente (`jev` | `fallback`).
   - **trivial:** sin Opus; plan de un paso `agy` + `gemini-3.8-flash-low`; un Noul decide si escribe; **arranca solo**.
   - **normal:** como hoy (Opus planea; espera "ejecutar").
   - **critical (opción A):** Opus planea + paso final **"review"** con Opus 5.5 en solo lectura que depende de
     todos los pasos hoja; aviso "Plan crítico" y botón **"aprobar y ejecutar"**.
3. **Guardia (opción A: pausar y preguntar)** antes de lanzar cada paso **escritor** no aprobado. Estado = prompt
   original del paso + resultados recortados de sus dependencias + carpeta del proyecto. Tres Noul: git
   (commit/push/historial/remotos), destructivo (borrar/sobrescribir en masa), fuera del proyecto (rutas ajenas o
   config del sistema/usuario). Cualquiera **≥ 0.5** → el paso no se lanza; plan `pending` con
   `pause_reason = guard`; banderas guardadas en el paso; UI "aprobar este paso" (una vez) o "cancelar".
   Editar el prompt anula la aprobación. **Sin JEV:** reglas locales (regex) conservadoras; solo como respaldo
   porque no entienden negaciones.
4. **Privacidad:** prompts de pasos y resultados recortados viajan a TypeSafe; retención no documentada → no usar
   con proyectos de clientes hasta revisarla.

## Fuera de alcance
Detector de inyección y elección de modelo por JEV (posibles después), Obsidian y aislamiento de config de
trabajadores (F3), voz (F5).
