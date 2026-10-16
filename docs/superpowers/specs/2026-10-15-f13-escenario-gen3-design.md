# F13 — Escenario propio (mapas gen3) para la Oficina · diseño

Fecha: 2026-10-15 · Estado: aprobado en conversación · Base: `main` (e2b48d1 + a966d73). Rama: `f13-escenario-gen3`.

## Qué es
La Oficina jugable (F12) puede dibujar sus pisos con **mapas de tiles externos** en lugar de las rejillas por código.
Igual que las skins (`C:\tools\sprites`), el escenario vive **fuera del repo** y el repo solo lleva el código que lo
lee. Uso inmediato: 6 pisos hechos con mapas de Pokémon Esmeralda (paquete `OneDrive\Desktop\sprites-libre-uso`,
que trae un LICENSE CC0 pero es arte de Game Freak/Nintendo → **solo local, nunca en git**).

Sala limpia (regla de F12): el código se escribe desde el formato de datos observado en el paquete; no se abre ni
copia código de pokeemerald ni de `C:\GAMES_N_SHIT\`.

## Decisiones aprobadas
1. **Un mapa por área**, cada uno es un "piso" del elevador de hoy (6 pisos):

   | Piso | Mapa | Zonas |
   |---|---|---|
   | 1 | Devon Corp 1F | recepción (fijos: recepción, biblio) · guardia en la entrada |
   | 2 | Devon Corp 2F | dev (6 escritorios) · imagen (mesa de dibujo) |
   | 3 | Devon Corp 3F | dirección (fijo: jefe) · agentes (fijos: claude, codex en los sillones) |
   | 4 | Laboratorio de Birch | qa (máquina y escritorios de abajo) · investigador (libreros y escritorios de arriba) |
   | 5 | Escuela Pokémon | lector (pupitres) · redactor (escritorio del maestro) |
   | 6 | Centro Pokémon 1F | descanso |

   El jugador aparece en el piso 1. Las zonas, puestos y la casilla del elevador (una escalera o tapete de cada mapa)
   se escriben a mano en `escenario.json` mirando cada mapa.
2. **Se mueve con el elevador de F12** (no con las puertas/warps del juego): mismo menú, ahora con N pisos.
3. **Enfoque A — la UI convierte al cargar.** Sin dependencias nuevas, sin paso de build.

## Formato de datos (fuera del repo)
Carpeta `OFFICE_ESCENARIO_DIR` (default `C:\tools\escenario`):
- `escenario.json`:
  ```json
  { "pisos": [ { "mapa": "devon_1f.json", "nombre": "DEVON 1F · RECEPCIÓN",
                 "elevador": [x, y], "llegada": [x, y], "salida": [x, y],
                 "zonas": [ { "id": "recepcion", "etiqueta": "RECEPCIÓN", "color": "#fb923c",
                              "x": 0, "y": 0, "w": 1, "h": 1,
                              "puestos": [[x, y]], "fijos": { "recepcion": [x, y] } } ] } ] }
  ```
  `salida` solo en el piso 1. `fijos` usa las mismas claves que F12 (jefe, guardia, recepcion, biblio, claude, codex).
- Un JSON por mapa, copiado tal cual del paquete: `ancho`, `alto`, `bloques` (uint16 por casilla: bits 0–9 metatile,
  10–11 colisión, 12–15 elevación) y `atlas` (nombre del tileset). Los demás campos se ignoran.
- Por cada atlas, `<atlas>-abajo.png` y `<atlas>-arriba.png` (guion y no punto: la regex de nombres admite una sola extensión): 256 px de ancho, metatiles de 16×16 en filas de 16,
  indexados por el metatile del bloque. `abajo` va bajo los personajes, `arriba` encima.

Copiar los mapas/atlas con nombres legibles y escribir `escenario.json` es trabajo local de esta fase (como las
skins), no código del repo.

## Arquitectura
**Servidor — `src/server/escenario.ts`** (patrón de `sprites.ts`):
- `readEscenario(dir)` lee `escenario.json` (≤ 64 KB) y cada mapa (≤ 256 KB), valida y devuelve
  `{ pisos: [...], warnings }` con los datos del mapa ya metidos en cada piso (`ancho`, `alto`, `bloques`, `atlas`).
- Validación: 1–9 pisos; nombres de archivo con la regex de `SPRITE_FILE` (json/png); `ancho`/`alto` 1–64;
  `bloques.length === ancho×alto` y enteros 0–65535; toda casilla (elevador, llegada, salida, puestos, fijos) y
  rectángulo de zona dentro del mapa; ids de zona `[a-z0-9-]{1,32}` sin repetir; deben existir (en algún piso) `descanso` y las 6 zonas de rol que
  usa `placement.ts` (`dev`, `qa`, `imagen`, `investigador`, `lector`, `redactor`); las demás zonas solo agrupan
  fijos; los 6 fijos presentes exactamente una vez en todo el escenario. Si algo falla → `{ pisos: [],
  warnings }` (sin escenario a medias).
- Carpeta inexistente → `{ pisos: [], warnings: [] }`.
- Rutas: `GET /api/office/escenario` (JSON) y `GET /escenario/<archivo>.png` con la misma resolución segura que
  `resolveSpriteFile` (realpath dentro de la carpeta), que se generaliza para recibir la carpeta y la extensión.

**UI:**
- `office/world/gen3.ts` (puro, con pruebas): `toFloorMap(piso, n)` → `FloorMap`. Fila por fila: colisión ≠ 0 → `#`,
  libre → `.`; luego puestos → `s`, elevador → `E`. Agrega `gen3: { ancho, bloques, atlas }` al `FloorMap`.
- `types.ts`: `FloorMap` gana `gen3?` opcional.
- `maps.ts`: `FLOORS` pasa a `export let` con `setFloors(f)`; `floorOf` igual. `fetchEscenario()` (junto a
  `fetchSkins`) pide el escenario al abrir la Oficina; si trae pisos, `setFloors(pisos.map(toFloorMap))` antes de
  montar el mundo. Si no, se quedan los 3 pisos de hoy.
- `render.ts`: si `map.gen3` y su atlas cargó, `drawFloor` pinta cada casilla desde `abajo` y `drawUpper` desde
  `arriba` (sin el truco de 8 px). Si el PNG no carga, se usan los tiles por código sobre las mismas `filas`.
- `OfficeWorld.tsx`: `COLS` sale de `map.filas[0].length` del piso actual; `FLOOR_LABELS` sale de los nombres de los
  pisos; el menú del elevador lista N pisos (teclas 1–N siguen funcionando hasta 9).
- `placement.ts`: sin cambios de lógica (ya busca zonas y fijos en `FLOORS`).

## Errores
- Sin carpeta → mundo de F12, sin avisos.
- Escenario inválido → mundo de F12; `warnings` en la respuesta de la API y un `console.warn` en la UI.
- Atlas que no carga → ese piso con tiles por código.
- Puesto inalcanzable desde el elevador → aviso en consola (el agente cae en `freeTileIn`/`llegada` como hoy).

## Pruebas
- `test/server/escenario.test.ts`: validador (válido, tamaños, casillas fuera, fijos faltantes, archivo raro, sin
  carpeta) con un mapa sintético de 6×5 (sin datos de Esmeralda en el repo).
- `test/ui/gen3.test.ts`: colisión → `#`, puestos → `s`, elevador → `E`; todo puesto y fijo alcanzable desde el
  elevador con `findPath`.
- `scripts/check-escenario.ts` (local): corre el validador y la revisión de alcance sobre `C:\tools\escenario`.
- En vivo: los 6 pisos se ven, el jugador camina y choca con muebles, el elevador lleva a los 6, los fijos están en
  su lugar y un paso con rol lleva al agente a su zona.

## Fuera de alcance
Warps/puertas del juego, mapas exteriores, animación de tiles (agua, flores), NPCs de los mapas, editor de
escenarios.
