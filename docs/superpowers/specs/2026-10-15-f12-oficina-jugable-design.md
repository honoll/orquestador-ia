# F12 — Oficina jugable · diseño

Fecha: 2026-10-15 · Estado: aprobado en conversación · Base: F11 (roles). Orden de integración:
F7 → F8 → F10 → F11 → F12 → F9. Prototipos aprobados:
`docs/superpowers/specs/assets/f12-oficina-jugable-prototipo.html` (jugable: elevador, clic para caminar, cuadros) y
`docs/superpowers/specs/assets/f12-zonas-por-rol.html` (zonas y cubículos por rol).

## Qué es
La vista Oficina (F8) pasa a ser un **mundo jugable desde arriba, estilo Pokémon**: el usuario controla a **su
personaje**, recorre **pisos** unidos por un **elevador**, y al acercarse a un agente aparece un **cuadro de diálogo**
con lo que está haciendo en vivo. Cada rol (F11) tiene su **zona** con cubículos y mobiliario propio; los agentes
**caminan** a la zona del rol que están ejecutando y vuelven a la **sala de descanso** al terminar.

## Decisiones aprobadas
1. **Cámara y mundo:** vista superior con baldosas de 16×16 escaladas (×3 por defecto, ajustable al ancho), mapas por
   piso definidos como datos (texto/JSON en el repo), colisiones por baldosa.
2. **Pisos** (iniciales, editables como datos): 1 · Dirección y Recepción (Jefe, Guardia, Recepción, Biblio, sala de
   descanso); 2 · Desarrollo y Pruebas (cubículos DEV, laboratorio QA); 3 · Estudio y Biblioteca (IMAGEN, INVESTIGADOR,
   LECTOR, REDACTOR). Elevador en cada piso; menú con clic o teclas 1–N.
3. **Control:** **clic para caminar** (ruta BFS que rodea paredes y muebles; clic en un agente o mueble → camina a una
   casilla vecina libre) y también flechas/WASD. Caminata en 4 direcciones con 2–4 cuadros.
4. **Cuadro de diálogo** (estilo Pokémon, abajo) al estar a 1 casilla (incluye diagonal) de un agente: nombre, rol,
   cuenta, estado, tarea/paso actual, modelo, tokens, avance, y botones "abrir plan" / "ver log". Datos de
   `GET /api/office/state` + eventos WS (F8/F10/F11).
5. **Movimiento de agentes:** al tomar un paso, el personaje de esa cuenta camina (ruta BFS, incluido elevador como
   transición) a un cubículo libre de la zona del rol; al terminar regresa a la sala de descanso. Jefe, Guardia,
   Biblio y Recepción tienen puesto fijo. Si la animación no alcanza (eventos muy seguidos), se teletransporta.
6. **Sprites — ambas opciones:**
   - **Originales estilo Pokémon (en el repo):** una criatura por rol y una para el jugador (p. ej. zorro DEV, búho
     INVESTIGADOR, camaleón IMAGEN…), hojas 4 direcciones × 3 cuadros, 16×16 o 32×32, paleta propia. Arte original.
   - **Skins propias del usuario (fuera del repo):** carpeta `C:\tools\sprites\` (configurable con `OFFICE_SPRITES_DIR`);
     el servidor la sirve en `/sprites/*` (solo esa carpeta, sin path traversal, solo imágenes). Un archivo
     `sprites.json` en esa carpeta asigna sprite por agente/rol/jugador con el formato de la hoja (tamaño de cuadro,
     filas por dirección, cuadros). Lo que el usuario ponga ahí es responsabilidad suya; **el orquestador no busca,
     descarga ni incluye sprites de terceros, y esa carpeta nunca entra a git**. Sin skin → sprite original.
7. **Accesibilidad y respaldo:** el mundo jugable es una vista adicional; la información sigue en texto (tarjetas,
   cola, planes, log) y por teclado. `prefers-reduced-motion` → sin caminatas animadas (cambios instantáneos).

## Arquitectura (resumen)
- `ui/src/office/world/` — motor mínimo propio en TypeScript + canvas: mapas (`maps/*.json`), baldosas, colisiones,
  BFS, cámara, bucle de animación (`requestAnimationFrame`, pausa con pestaña oculta), entidades (jugador, agentes,
  elevador), cuadro de diálogo (DOM superpuesto para accesibilidad).
- `ui/src/office/sprites/` — hojas originales (PNG generadas por script desde datos de píxeles, o dibujadas en canvas)
  y cargador de skins (`/sprites/sprites.json`).
- Servidor: ruta estática segura `/sprites/*` y `GET /api/office/sprites` (lee `sprites.json` validado).
- Sin dependencias nuevas.

## Pruebas
Lógica pura con vitest: BFS (rodea obstáculos, casilla vecina libre, sin ruta), mapeo de estado → posición/zona por
rol, selección de cubículo libre, validación de `sprites.json`, ruta estática sin traversal. Visual: capturas por piso;
recorrido con clic y elevador; agente que cambia de zona al tomar un paso real.

## Fuera de alcance
Multijugador, editor de mapas en la app, sonido/música, sprites de terceros incluidos en el repo.
