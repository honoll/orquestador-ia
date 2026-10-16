// Datos validados: todo asiento se alcanza desde el elevador (test/ui/world-path.test.ts).
import type { FloorMap } from "./types";

export let FLOORS: readonly FloorMap[] = [
  {
    piso: 1, nombre: "PISO 1 · DIRECCIÓN Y RECEPCIÓN", fondo: "#1b1b22", elevador: [15, 1], llegada: [15, 2], salida: [8, 13],
    filas: [
      "##############################",
      "#*.............E............*#",
      "#.....===............===...B.#",
      "#......s..............s....B.#",
      "#............................#",
      "#.....===............===.....#",
      "#......s..............s......#",
      "#######d###########d##########",
      "#............................#",
      "#*...........................#",
      "#..SSSS......SSS......SSSS...#",
      "#..ssss......sss......ssss...#",
      "#............................#",
      "#.......p....................#",
      "#*..........................*#",
      "##############################",
    ],
    zonas: [
      { id: "direccion", etiqueta: "DIRECCIÓN", color: "#a78bfa", x: 1, y: 1, w: 12, h: 6, fijos: { jefe: [7, 3], guardia: [7, 6] } },
      { id: "recepcion", etiqueta: "RECEPCIÓN Y MEMORIA", color: "#fb923c", x: 17, y: 1, w: 12, h: 6, fijos: { recepcion: [22, 3], biblio: [22, 6] } },
      { id: "descanso", etiqueta: "SALA DE DESCANSO", color: "#a1a1aa", x: 1, y: 8, w: 28, h: 7 },
    ],
  },
  {
    piso: 2, nombre: "PISO 2 · DESARROLLO Y PRUEBAS", fondo: "#16202a", elevador: [15, 1], llegada: [15, 2],
    filas: [
      "##############################",
      "#*.............E............*#",
      "#............................#",
      "#.|s.|s.|s.|....######d#######",
      "#.|==|==|==|....#..........*.#",
      "#.----------....#..=s=..=s=..#",
      "#...............#............#",
      "#.|s.|s.|s.|....#..=s=.......#",
      "#.|==|==|==|....#............#",
      "#.----------....#....B.B.....#",
      "#...............#............#",
      "#......|s.|s.|..#............#",
      "#......|==|==|..#............#",
      "#*.....-------..#...........*#",
      "##############################",
    ],
    zonas: [
      { id: "dev", etiqueta: "DEV · CUBÍCULOS", color: "#60a5fa", x: 1, y: 3, w: 15, h: 7 },
      { id: "agentes", etiqueta: "CLAUDE Y CODEX", color: "#e879f9", x: 1, y: 10, w: 15, h: 4, fijos: { claude: [8, 11], codex: [11, 11] } },
      { id: "qa", etiqueta: "QA · LABORATORIO", color: "#34d399", x: 17, y: 4, w: 12, h: 10 },
    ],
  },
  {
    piso: 3, nombre: "PISO 3 · ESTUDIO Y BIBLIOTECA", fondo: "#221a1a", elevador: [15, 1], llegada: [15, 2],
    filas: [
      "##############################",
      "#*.............E............*#",
      "#............................#",
      "######d#######..######d#######",
      "#.==...==....#..#.B.B..B.B...#",
      "#..s....s....#..#............#",
      "#............#..#..==...==...#",
      "#*...........#..#...s....s..*#",
      "######d#######..######d#######",
      "#.==...==....#..#..==...==...#",
      "#..s....s....#..#...s....s...#",
      "#*...........#..#..........*.#",
      "##############################",
    ],
    zonas: [
      { id: "imagen", etiqueta: "IMAGEN · ESTUDIO", color: "#fb923c", x: 1, y: 4, w: 12, h: 4 },
      { id: "investigador", etiqueta: "INVESTIGADOR · BIBLIOTECA", color: "#f472b6", x: 17, y: 4, w: 12, h: 4 },
      { id: "lector", etiqueta: "LECTOR · SALA DE LECTURA", color: "#fbbf24", x: 1, y: 9, w: 12, h: 3 },
      { id: "redactor", etiqueta: "REDACTOR", color: "#e879f9", x: 17, y: 9, w: 12, h: 3 },
    ],
  },
];

export const floorOf = (piso: number): FloorMap => FLOORS[piso - 1];

/** Reemplaza los pisos (escenario propio, F13) antes de montar el mundo; los módulos leen FLOORS en cada uso. */
export function setFloors(f: readonly FloorMap[]): void { FLOORS = f; }
