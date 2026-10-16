export type Tile = readonly [x: number, y: number];
export interface Zone { id: string; etiqueta: string; color: string; x: number; y: number; w: number; h: number; fijos?: Record<string, Tile> }
export interface FloorMap {
  piso: number; nombre: string; fondo: string;
  filas: readonly string[]; zonas: readonly Zone[];
  elevador: Tile; llegada: Tile; // llegada = casilla donde aparece quien sale del elevador
  salida?: Tile; // aparición del jugador (solo piso 1)
  gen3?: { ancho: number; bloques: readonly number[]; atlas: string }; // piso de un escenario propio (F13)
}
