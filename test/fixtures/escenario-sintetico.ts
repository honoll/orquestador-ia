// Escenario sintético para pruebas (sin datos de Esmeralda): 12×6, borde con colisión, interior libre.
export const ANCHO = 12, ALTO = 6;
const borde = (x: number, y: number) => x === 0 || y === 0 || x === ANCHO - 1 || y === ALTO - 1;
// 1025 = colisión 1 + metatile 1; 2 = metatile 2 sin colisión.
export const MAPA = {
  ancho: ANCHO, alto: ALTO, atlas: "gTileset_Prueba", objetos: [],
  bloques: Array.from({ length: ANCHO * ALTO }, (_, i) => (borde(i % ANCHO, Math.floor(i / ANCHO)) ? 1025 : 2)),
};
const ROLES = ["descanso", "dev", "qa", "imagen", "investigador", "lector", "redactor"];
export const ESCENARIO = {
  pisos: [{
    mapa: "prueba.json", nombre: "PISO 1 · PRUEBA", elevador: [10, 1], llegada: [10, 2], salida: [9, 2],
    zonas: [
      ...ROLES.map((id, i) => ({ id, etiqueta: id.toUpperCase(), color: "#60a5fa", x: 1 + i, y: 1, w: 1, h: 1, puestos: [[1 + i, 1]] })),
      {
        id: "oficina", etiqueta: "OFICINA", color: "#a78bfa", x: 1, y: 3, w: 10, h: 2,
        fijos: { jefe: [1, 3], guardia: [2, 3], recepcion: [3, 3], biblio: [4, 3], claude: [5, 3], codex: [6, 3] },
      },
    ],
  }],
};
