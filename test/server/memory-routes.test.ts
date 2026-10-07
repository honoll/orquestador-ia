import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  indexVault: vi.fn(),
  isIndexing: vi.fn(() => false),
  health: vi.fn(async () => ({ ok: true, modelAvailable: true })),
  broadcast: vi.fn(),
}));
vi.mock("../../src/memory/vault-index.js", () => ({ indexVault: h.indexVault, isIndexing: h.isIndexing }));
vi.mock("../../src/memory/ollama.js", () => ({ ollamaHealth: h.health, createOllamaEmbedder: () => async () => null }));
vi.mock("../../src/server/ws.js", () => ({ broadcast: h.broadcast, addClient: vi.fn(), removeClient: vi.fn() }));

const { default: memoryRoute } = await import("../../src/server/routes/memory.js");
const { db, schema } = await import("../../src/db/index.js");
const { migrationDone } = await import("../../src/db/migrate.js");

beforeEach(async () => {
  await migrationDone;
  h.indexVault.mockReset();
  h.isIndexing.mockReset().mockReturnValue(false);
  h.broadcast.mockReset();
  h.health.mockReset().mockResolvedValue({ ok: true, modelAvailable: true });
  await db.delete(schema.vaultChunks);
  await db.delete(schema.vaultNotes);
});

describe("GET /status", () => {
  it("sin notas: contadores en 0 y lastIndexedAt null", async () => {
    const body = await (await memoryRoute.request("/status")).json() as Record<string, unknown>;
    expect(body.notes).toBe(0);
    expect(body.chunks).toBe(0);
    expect(body.lastIndexedAt).toBeNull();
    expect(body.indexing).toBe(false);
    expect(body.ollama).toEqual({ ok: true, modelAvailable: true });
    expect(typeof body.vaultPath).toBe("string");
    expect(typeof body.vaultName).toBe("string");
    expect(typeof body.model).toBe("string");
  });
  it("cuenta notas y trozos y devuelve el indexed_at más reciente", async () => {
    await db.insert(schema.vaultNotes).values([
      { path: "a.md", title: "a", mtimeMs: 1, frontmatter: "{}", indexedAt: "2026-10-01T00:00:00.000Z" },
      { path: "b.md", title: "b", mtimeMs: 1, frontmatter: "{}", indexedAt: "2026-10-05T00:00:00.000Z" },
    ]);
    await db.insert(schema.vaultChunks).values([
      { id: "1", path: "a.md", heading: "h", chunkIndex: 0, text: "t", embedding: "x" },
      { id: "2", path: "a.md", heading: "h", chunkIndex: 1, text: "t", embedding: "x" },
      { id: "3", path: "b.md", heading: "h", chunkIndex: 0, text: "t", embedding: "x" },
    ]);
    const body = await (await memoryRoute.request("/status")).json() as Record<string, unknown>;
    expect(body.notes).toBe(2);
    expect(body.chunks).toBe(3);
    expect(body.lastIndexedAt).toBe("2026-10-05T00:00:00.000Z");
  });
  it("refleja Ollama caído e indexando", async () => {
    h.health.mockResolvedValueOnce({ ok: false, modelAvailable: false });
    h.isIndexing.mockReturnValue(true);
    const body = await (await memoryRoute.request("/status")).json() as { ollama: unknown; indexing: boolean };
    expect(body.ollama).toEqual({ ok: false, modelAvailable: false });
    expect(body.indexing).toBe(true);
  });
});

describe("POST /reindex", () => {
  it("409 si ya está indexando y no lanza otra corrida", async () => {
    h.isIndexing.mockReturnValue(true);
    const res = await memoryRoute.request("/reindex", { method: "POST" });
    expect(res.status).toBe(409);
    expect(h.indexVault).not.toHaveBeenCalled();
  });
  it("202 e indexa en segundo plano; al terminar emite memory:indexed con el reporte", async () => {
    const report = { scanned: 3, updated: 1, removed: 0, chunks: 4, failed: false };
    h.indexVault.mockResolvedValueOnce(report);
    const res = await memoryRoute.request("/reindex", { method: "POST" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalled());
    expect(h.broadcast.mock.calls[0][0]).toMatchObject({ type: "memory:indexed", report });
  });
  it("si el indexado revienta emite un reporte failed y no lanza", async () => {
    h.indexVault.mockRejectedValueOnce(new Error("boom"));
    const res = await memoryRoute.request("/reindex", { method: "POST" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(h.broadcast).toHaveBeenCalled());
    expect(h.broadcast.mock.calls[0][0].report.failed).toBe(true);
  });
});
