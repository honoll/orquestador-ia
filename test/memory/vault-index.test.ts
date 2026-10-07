import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrationDone } from "../../src/db/migrate.js";
import { db, schema } from "../../src/db/index.js";
import { indexVault, encodeVector, decodeVector, EMBED_BATCH } from "../../src/memory/vault-index.js";
import type { Embedder } from "../../src/memory/ollama.js";

beforeAll(async () => { await migrationDone; });

let vault: string;
const write = (rel: string, content: string) => {
  const p = path.join(vault, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};

function fakeEmbedder(dim = 8) {
  const batches: number[] = [];
  const fn: Embedder = async (texts) => {
    batches.push(texts.length);
    return texts.map((t) => {
      const v = new Array(dim).fill(0);
      for (const w of t.toLowerCase().split(/\s+/)) {
        let h = 0;
        for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
        v[h % dim] += 1;
      }
      return v;
    });
  };
  return { fn, batches };
}

beforeEach(async () => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  write("a.md", "---\ntags: [x]\n---\n# A\nHola mundo");
  write("sub/b.md", "# B\nOtra nota sobre gatos");
  write("c.md", "Nota C sin encabezado");
  write(".obsidian/cfg.md", "no indexar");
  write("adjuntos/z.md", "no indexar");
  await db.delete(schema.vaultChunks);
  await db.delete(schema.vaultNotes);
  await db.delete(schema.vaultMeta);
});
afterEach(() => { fs.rmSync(vault, { recursive: true, force: true }); });

const notes = () => db.select().from(schema.vaultNotes);
const chunks = () => db.select().from(schema.vaultChunks);

describe("indexVault", () => {
  it("primera indexacion", async () => {
    const e = fakeEmbedder();
    const r = await indexVault({ vaultPath: vault, embedder: e.fn });
    expect(r).toMatchObject({ scanned: 3, updated: 3, removed: 0, failed: false });
    expect((await notes()).map((n) => n.path).sort()).toEqual(["a.md", "c.md", "sub/b.md"]);
    expect((await chunks()).length).toBe(r.chunks);
    expect(r.chunks).toBeGreaterThanOrEqual(3);
    expect(e.batches.every((n) => n <= EMBED_BATCH)).toBe(true);
    expect((await notes()).find((n) => n.path === "sub/b.md")!.title).toBe("b");
  });

  it("segunda indexacion sin cambios no llama al embedder", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
    const e = fakeEmbedder();
    const r = await indexVault({ vaultPath: vault, embedder: e.fn });
    expect(r).toMatchObject({ scanned: 3, updated: 0, removed: 0, failed: false });
    expect(e.batches.length).toBe(0);
  });

  it("nota modificada: solo esa se reprocesa y sus trozos viejos desaparecen", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
    const p = write("a.md", "# A\nTexto totalmente nuevo");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(p, future, future);
    const e = fakeEmbedder();
    const r = await indexVault({ vaultPath: vault, embedder: e.fn });
    expect(r.updated).toBe(1);
    const aChunks = (await chunks()).filter((c) => c.path === "a.md");
    expect(aChunks.length).toBeGreaterThan(0);
    expect(aChunks.some((c) => c.text.includes("Hola mundo"))).toBe(false);
    expect(aChunks.some((c) => c.text.includes("totalmente nuevo"))).toBe(true);
  });

  it("nota borrada: removed y sin filas", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
    fs.rmSync(path.join(vault, "c.md"));
    const r = await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
    expect(r.removed).toBe(1);
    expect((await notes()).some((n) => n.path === "c.md")).toBe(false);
    expect((await chunks()).some((c) => c.path === "c.md")).toBe(false);
  });

  it("embedder null: failed, conserva lo indexado y deja pendientes las no procesadas", async () => {
    const ok = fakeEmbedder();
    await indexVault({ vaultPath: vault, embedder: ok.fn });
    const before = (await chunks()).length;
    const future = new Date(Date.now() + 120_000);
    for (const rel of ["a.md", "c.md"]) fs.utimesSync(path.join(vault, rel), future, future);
    const r = await indexVault({ vaultPath: vault, embedder: async () => null });
    expect(r.failed).toBe(true);
    expect(r.updated).toBe(0);
    expect((await chunks()).length).toBe(before);
    const again = await indexVault({ vaultPath: vault, embedder: ok.fn });
    expect(again).toMatchObject({ updated: 2, failed: false });
  });
});

describe("robustez", () => {
  it("raiz inexistente -> failed sin lanzar", async () => {
    const r = await indexVault({ vaultPath: path.join(vault, "no-existe"), embedder: fakeEmbedder().fn });
    expect(r).toMatchObject({ scanned: 0, updated: 0, failed: true });
  });

  it("archivo que desaparece antes de leerse no lanza ni registra su mtime", async () => {
    const e = fakeEmbedder();
    let first = true;
    const embedder: Embedder = async (t) => {
      if (first) { first = false; fs.rmSync(path.join(vault, "sub", "b.md")); fs.rmSync(path.join(vault, "c.md")); }
      return e.fn(t);
    };
    const r = await indexVault({ vaultPath: vault, embedder });
    expect(r.failed).toBe(false);
    const paths = (await notes()).map((n) => n.path);
    expect(paths).toContain("a.md");
    expect(paths.length).toBeLessThan(3);
  });

  it("directorio ilegible: sus notas ya indexadas no se borran", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
    const orig = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation(((d: fs.PathLike, o?: unknown) => {
      if (String(d).endsWith("sub")) throw new Error("EACCES");
      return (orig as unknown as (a: unknown, b: unknown) => unknown)(d, o);
    }) as unknown as typeof fs.readdirSync);
    try {
      const r = await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
      expect(r.removed).toBe(0);
    } finally { spy.mockRestore(); }
    expect((await notes()).some((n) => n.path === "sub/b.md")).toBe(true);
  });

  it("nota con cuerpo vacio: tiene fila y no se reprocesa", async () => {
    fs.rmSync(path.join(vault, "a.md")); fs.rmSync(path.join(vault, "c.md")); fs.rmSync(path.join(vault, "sub"), { recursive: true });
    write("vacia.md", "");
    const r1 = await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn });
    expect(r1.updated).toBe(1);
    expect((await notes()).map((n) => n.path)).toEqual(["vacia.md"]);
    const e = fakeEmbedder();
    const r2 = await indexVault({ vaultPath: vault, embedder: e.fn });
    expect(r2.updated).toBe(0);
    expect(e.batches.length).toBe(0);
  });

  it("llamadas concurrentes comparten la misma ejecucion", async () => {
    const e = fakeEmbedder();
    const p1 = indexVault({ vaultPath: vault, embedder: e.fn });
    const p2 = indexVault({ vaultPath: vault, embedder: e.fn });
    expect(p2).toBe(p1);
    await p1;
    const p3 = indexVault({ vaultPath: vault, embedder: e.fn });
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe("modelo y dimensión del índice", () => {
  const meta = async () => Object.fromEntries((await db.select().from(schema.vaultMeta)).map((r) => [r.key, r.value]));

  it("guarda modelo y dimensión; sin cambios no reindexa", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn, model: "bge-m3" });
    expect(await meta()).toMatchObject({ model: "bge-m3", dim: "8" });
    const e = fakeEmbedder();
    const r = await indexVault({ vaultPath: vault, embedder: e.fn, model: "bge-m3" });
    expect(r.updated).toBe(0);
    expect(e.batches.length).toBe(0);
  });

  it("si cambia el modelo, reindexa todo aunque no cambie ningún archivo", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder().fn, model: "bge-m3" });
    const e = fakeEmbedder();
    const r = await indexVault({ vaultPath: vault, embedder: e.fn, model: "otro-modelo" });
    expect(r).toMatchObject({ scanned: 3, updated: 3, failed: false });
    expect((await meta()).model).toBe("otro-modelo");
  });

  it("si cambia la dimensión, reindexa todo con la nueva", async () => {
    await indexVault({ vaultPath: vault, embedder: fakeEmbedder(8).fn, model: "m" });
    const p = write("a.md", "# A\nTexto cambiado");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(p, future, future);
    const r = await indexVault({ vaultPath: vault, embedder: fakeEmbedder(4).fn, model: "m" });
    expect(r).toMatchObject({ scanned: 3, updated: 3, failed: false });
    const all = await chunks();
    expect(all.length).toBe(r.chunks);
    expect(all.every((c) => decodeVector(c.embedding).length === 4)).toBe(true);
    expect((await meta()).dim).toBe("4");
  });
});

describe("vectores", () => {
  it("encode/decode ida y vuelta", () => {
    const v = [0.5, -1.25, 3, 0];
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(v);
  });
});
