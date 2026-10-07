import path from "node:path";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { memoryConfig } from "../../memory/config.js";
import { createOllamaEmbedder, ollamaHealth } from "../../memory/ollama.js";
import { indexVault, isIndexing, type IndexReport } from "../../memory/vault-index.js";
import { broadcast } from "../ws.js";

const app = new Hono();

app.get("/status", async (c) => {
  const cfg = memoryConfig();
  const [notes] = await db.select({ n: sql<number>`count(*)`, last: sql<string | null>`max(${schema.vaultNotes.indexedAt})` }).from(schema.vaultNotes);
  const [chunks] = await db.select({ n: sql<number>`count(*)` }).from(schema.vaultChunks);
  const ollama = await ollamaHealth({ url: cfg.ollamaUrl, model: cfg.model }).catch(() => ({ ok: false, modelAvailable: false }));
  return c.json({
    vaultPath: cfg.vaultPath,
    vaultName: path.basename(cfg.vaultPath),
    notes: Number(notes?.n ?? 0),
    chunks: Number(chunks?.n ?? 0),
    lastIndexedAt: notes?.last ?? null,
    ollama,
    model: cfg.model,
    indexing: isIndexing(),
  });
});

app.post("/reindex", (c) => {
  if (isIndexing()) return c.json({ error: "Ya se está indexando la memoria" }, 409);
  const cfg = memoryConfig();
  const failed: IndexReport = { scanned: 0, updated: 0, removed: 0, chunks: 0, failed: true };
  void indexVault({ vaultPath: cfg.vaultPath, embedder: createOllamaEmbedder(cfg), model: cfg.model })
    .catch((): IndexReport => failed)
    .then((report) => broadcast({ type: "memory:indexed", report, timestamp: new Date().toISOString() } as never));
  return c.json({ started: true }, 202);
});

export default app;
