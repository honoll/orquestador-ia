import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateEscenario, readEscenario, type Escenario } from "../../src/server/escenario.js";
import { ESCENARIO, MAPA } from "../fixtures/escenario-sintetico.js";
import { createOfficeEscenarioRoute, createEscenarioFilesRoute } from "../../src/server/routes/escenario.js";

const leer = (m: unknown = MAPA) => () => structuredClone(m);
const conPiso = (cambio: Record<string, unknown>) => ({ pisos: [{ ...structuredClone(ESCENARIO.pisos[0]), ...cambio }] });
const aviso = (raw: unknown, mapa: unknown = MAPA) => {
  const r = validateEscenario(raw, leer(mapa));
  expect(r.pisos).toEqual([]);
  return r.warnings.join(" | ");
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "escenario-")); });

describe("validateEscenario", () => {
  it("escenario válido: mete los datos del mapa en el piso e ignora campos extra", () => {
    const r = validateEscenario(structuredClone(ESCENARIO), leer());
    expect(r.warnings).toEqual([]);
    expect(r.pisos).toHaveLength(1);
    const p = r.pisos[0];
    expect(p).toMatchObject({ nombre: "PISO 1 · PRUEBA", ancho: 12, alto: 6, atlas: "gTileset_Prueba", elevador: [10, 1], llegada: [10, 2], salida: [9, 2] });
    expect(p.bloques).toHaveLength(72);
    expect(p).not.toHaveProperty("objetos");
    expect(p.zonas.find((z) => z.id === "dev")).toEqual({ id: "dev", etiqueta: "DEV", color: "#60a5fa", x: 2, y: 1, w: 1, h: 1, puestos: [[2, 1]], fijos: {} });
    expect(p.zonas.find((z) => z.id === "oficina")!.fijos.codex).toEqual([6, 3]);
  });

  it("estructura: no objeto, sin pisos, más de 9 pisos", () => {
    expect(aviso([])).toContain("escenario.json: debe ser un objeto");
    expect(aviso({ pisos: [] })).toContain("pisos: de 1 a 9");
    expect(aviso({ pisos: Array(10).fill(ESCENARIO.pisos[0]) })).toContain("pisos: de 1 a 9");
  });

  it("mapa: nombre raro, tamaño, bloques y atlas", () => {
    expect(aviso(conPiso({ mapa: "../x.json" }))).toContain("pisos[0].mapa: nombre de archivo inválido");
    expect(aviso(ESCENARIO, { ...MAPA, ancho: 65 })).toContain("ancho/alto 1–64");
    expect(aviso(ESCENARIO, { ...MAPA, bloques: MAPA.bloques.slice(1) })).toContain("bloques debe tener ancho×alto");
    expect(aviso(ESCENARIO, { ...MAPA, bloques: [...MAPA.bloques.slice(1), 70000] })).toContain("enteros 0–65535");
    expect(aviso(ESCENARIO, { ...MAPA, atlas: "a.b" })).toContain("atlas inválido");
  });

  it("casillas fuera del mapa y salida mal puesta", () => {
    expect(aviso(conPiso({ elevador: [12, 1] }))).toContain("pisos[0].elevador: casilla fuera del mapa");
    expect(aviso(conPiso({ llegada: [1] }))).toContain("pisos[0].llegada: casilla fuera del mapa");
    const sinSalida = conPiso({});
    delete (sinSalida.pisos[0] as { salida?: unknown }).salida;
    expect(aviso(sinSalida)).toContain("falta salida");
    const dos = { pisos: [structuredClone(ESCENARIO.pisos[0]), { ...structuredClone(ESCENARIO.pisos[0]), zonas: [] }] };
    expect(aviso(dos)).toContain("pisos[1].salida: solo en el piso 1");
  });

  it("zonas: id, repetidas, color, rectángulo, puestos fuera de su zona, faltantes", () => {
    // Las zonas del fixture son de dos formas (con puestos / con fijos): como registros sueltos para poder mutarlas.
    const z = () => structuredClone(ESCENARIO.pisos[0].zonas) as Array<Record<string, unknown>>;
    const con = (f: (zs: ReturnType<typeof z>) => void) => { const zs = z(); f(zs); return conPiso({ zonas: zs }); };
    expect(aviso(con((zs) => { zs[0].id = "Sala!"; }))).toContain("pisos[0].zonas[0].id");
    expect(aviso(con((zs) => { zs[1].id = "descanso"; }))).toContain('"descanso" repetido');
    expect(aviso(con((zs) => { zs[0].color = "rojo"; }))).toContain("color: #rrggbb");
    expect(aviso(con((zs) => { zs[0].w = 20; }))).toContain("rectángulo fuera del mapa");
    expect(aviso(con((zs) => { zs[0].puestos = [[5, 4]]; }))).toContain("pisos[0].zonas[0].puestos[0]: fuera de su zona");
    expect(aviso(con((zs) => { zs.splice(2, 1); }))).toContain('falta la zona "qa"');
  });

  it("fijos: desconocido, repetido, faltante, fuera de su zona", () => {
    const of = () => structuredClone(ESCENARIO.pisos[0].zonas) as Array<Record<string, unknown>>;
    const con = (fijos: Record<string, unknown>) => { const zs = of(); zs[7].fijos = fijos; return conPiso({ zonas: zs }); };
    const base = (ESCENARIO.pisos[0].zonas[7] as { fijos: Record<string, number[]> }).fijos;
    expect(aviso(con({ ...base, gato: [7, 3] }))).toContain('fijo desconocido "gato"');
    expect(aviso(JSON.parse(JSON.stringify(con(base)).replace('"jefe":[1,3]', '"__proto__":[1,3]')))).toContain('fijo desconocido "__proto__"');
    const sinCodex = { ...base };
    delete sinCodex.codex;
    expect(aviso(con(sinCodex))).toContain('falta el fijo "codex"');
    expect(aviso(con({ ...base, jefe: [1, 1] }))).toContain("fijos.jefe: fuera de su zona");
    const dos = { pisos: [structuredClone(ESCENARIO.pisos[0]), { ...structuredClone(ESCENARIO.pisos[0]), salida: undefined, zonas: [{ id: "x", etiqueta: "X", color: "#000000", x: 1, y: 1, w: 2, h: 2, fijos: { jefe: [1, 1] } }] }] };
    delete (dos.pisos[1] as { salida?: unknown }).salida;
    expect(aviso(dos)).toContain('fijo "jefe" repetido');
  });
});

describe("readEscenario", () => {
  it("sin carpeta o sin escenario.json → vacío sin avisos", () => {
    expect(readEscenario(path.join(dir, "no"))).toEqual({ pisos: [], warnings: [] });
    expect(readEscenario(dir)).toEqual({ pisos: [], warnings: [] });
  });

  it("lee la carpeta; JSON roto, mapa faltante o demasiado grande → aviso", () => {
    fs.writeFileSync(path.join(dir, "escenario.json"), JSON.stringify(ESCENARIO));
    expect(readEscenario(dir).warnings).toEqual(["prueba.json: no existe o está fuera de la carpeta"]);
    fs.writeFileSync(path.join(dir, "prueba.json"), JSON.stringify(MAPA));
    const ok = readEscenario(dir);
    expect(ok.warnings).toEqual([]);
    expect(ok.pisos[0].atlas).toBe("gTileset_Prueba");
    fs.writeFileSync(path.join(dir, "prueba.json"), " ".repeat(256 * 1024 + 1));
    expect(readEscenario(dir).warnings).toEqual(["prueba.json: pesa más de 256 KB"]);
    fs.writeFileSync(path.join(dir, "escenario.json"), "{roto");
    expect(readEscenario(dir).warnings).toEqual(["escenario.json: no es JSON"]);
  });

  it("acepta JSON con BOM al inicio (editores de Windows)", () => {
    fs.writeFileSync(path.join(dir, "escenario.json"), "\uFEFF" + JSON.stringify(ESCENARIO));
    fs.writeFileSync(path.join(dir, "prueba.json"), "\uFEFF" + JSON.stringify(MAPA));
    const r = readEscenario(dir);
    expect(r.warnings).toEqual([]);
    expect(r.pisos).toHaveLength(1);
  });
});

describe("rutas del escenario", () => {
  it("/api/office/escenario lee la carpeta; /escenario solo sirve PNG de adentro con nosniff y CSP", async () => {
    expect(await (await createOfficeEscenarioRoute(dir).request("/")).json()).toEqual({ pisos: [], warnings: [] });
    fs.writeFileSync(path.join(dir, "escenario.json"), JSON.stringify(ESCENARIO));
    fs.writeFileSync(path.join(dir, "prueba.json"), JSON.stringify(MAPA));
    fs.writeFileSync(path.join(dir, "gTileset_Prueba-abajo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const body = (await (await createOfficeEscenarioRoute(dir).request("/")).json()) as Escenario;
    expect(body.warnings).toEqual([]);
    expect(body.pisos[0].atlas).toBe("gTileset_Prueba");
    const r = await createEscenarioFilesRoute(dir).request("/gTileset_Prueba-abajo.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toBe("sandbox");
    for (const bad of ["/prueba.json", "/escenario.json", "/..%2Fx.png", "/falta.png"]) expect((await createEscenarioFilesRoute(dir).request(bad)).status, bad).toBe(404);
  });
});
