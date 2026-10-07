import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { migrationDone } from "../db/migrate.js";
import { parseFrontmatter, chunkNote } from "./markdown.js";
import type { Embedder } from "./ollama.js";

export const EMBED_BATCH = 16;

export interface IndexReport { scanned: number; updated: number; removed: number; chunks: number; failed: boolean }

const EXCLUDED_DIRS = new Set(["adjuntos", "attachments", "_resources"]);

export function encodeVector(v: number[]): string {
  const f = new Float32Array(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

export function decodeVector(s: string): Float32Array {
  const buf = Buffer.from(s, "base64");
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

interface NoteFile { rel: string; abs: string; mtimeMs: number | null }
interface Walk { files: NoteFile[]; skippedDirs: string[] }

function walk(root: string, dir = root, out: Walk = { files: [], skippedDirs: [] }): Walk {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    out.skippedDirs.push(path.relative(root, dir).split(path.sep).join("/"));
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith(".") || EXCLUDED_DIRS.has(e.name)) continue;
      walk(root, abs, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      let mtimeMs: number | null = null;
      try { mtimeMs = Math.floor(fs.statSync(abs).mtimeMs); } catch { /* se omite */ }
      out.files.push({ rel: path.relative(root, abs).split(path.sep).join("/"), abs, mtimeMs });
    }
  }
  return out;
}

async function embedAll(embedder: Embedder, texts: string[]): Promise<number[][] | null> {
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const part = await embedder(texts.slice(i, i + EMBED_BATCH));
    if (!part || part.length !== Math.min(EMBED_BATCH, texts.length - i)) return null;
    all.push(...part);
  }
  return all;
}

let inFlight: Promise<IndexReport> | null = null;

/** true mientras hay una corrida de indexado en curso. */
export function isIndexing(): boolean { return inFlight !== null; }

/** Indexa la bóveda; si ya hay una corrida en curso devuelve esa misma promesa. */
export function indexVault(opts: { vaultPath: string; embedder: Embedder }): Promise<IndexReport> {
  if (inFlight) return inFlight;
  const p = runIndex(opts).finally(() => { if (inFlight === p) inFlight = null; });
  inFlight = p;
  return p;
}

async function runIndex(opts: { vaultPath: string; embedder: Embedder }): Promise<IndexReport> {
  await migrationDone;
  try {
    if (!fs.statSync(opts.vaultPath).isDirectory()) throw new Error("no es carpeta");
  } catch {
    return { scanned: 0, updated: 0, removed: 0, chunks: 0, failed: true };
  }
  const { files, skippedDirs } = walk(opts.vaultPath);
  const report: IndexReport = { scanned: files.length, updated: 0, removed: 0, chunks: 0, failed: false };

  const known = await db.select().from(schema.vaultNotes);
  const knownMtime = new Map(known.map((n) => [n.path, n.mtimeMs]));
  const present = new Set(files.map((f) => f.rel));

  for (const n of known) {
    if (present.has(n.path)) continue;
    if (skippedDirs.some((d) => d === "" || n.path.startsWith(d + "/"))) continue;
    await db.transaction(async (tx) => {
      await tx.delete(schema.vaultChunks).where(eq(schema.vaultChunks.path, n.path));
      await tx.delete(schema.vaultNotes).where(eq(schema.vaultNotes.path, n.path));
    });
    report.removed++;
  }

  for (const f of files) {
    if (f.mtimeMs === null || knownMtime.get(f.rel) === f.mtimeMs) continue;
    const title = path.basename(f.rel, path.extname(f.rel));
    let raw: string;
    try { raw = fs.readFileSync(f.abs, "utf8"); } catch { continue; }
    const { data, body } = parseFrontmatter(raw);
    const chunks = chunkNote(title, body);
    const embeddings = await embedAll(opts.embedder, chunks.map((c) => `${c.heading}\n${c.text}`));
    if (!embeddings) { report.failed = true; break; }

    await db.transaction(async (tx) => {
      await tx.delete(schema.vaultChunks).where(eq(schema.vaultChunks.path, f.rel));
      await tx.delete(schema.vaultNotes).where(eq(schema.vaultNotes.path, f.rel));
      await tx.insert(schema.vaultNotes).values({
        path: f.rel,
        title,
        mtimeMs: f.mtimeMs as number,
        frontmatter: JSON.stringify(data),
        indexedAt: new Date().toISOString(),
      });
      if (chunks.length > 0) {
        await tx.insert(schema.vaultChunks).values(chunks.map((c, i) => ({
          id: randomUUID(),
          path: f.rel,
          heading: c.heading,
          chunkIndex: c.index,
          text: c.text,
          embedding: encodeVector(embeddings[i]),
        })));
      }
    });
    report.updated++;
    report.chunks += chunks.length;
  }
  return report;
}
