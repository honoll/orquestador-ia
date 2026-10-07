export interface MemoryStatusData {
  vaultPath: string;
  vaultName: string;
  notes: number;
  chunks: number;
  lastIndexedAt: string | null;
  ollama: { ok: boolean; modelAvailable: boolean };
  model: string;
  indexing: boolean;
}

export async function fetchMemoryStatus(): Promise<MemoryStatusData> {
  const r = await fetch("/api/memory/status");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** Enlace obsidian:// a una nota de la bóveda (ruta relativa, con o sin .md). */
export function obsidianUrl(vaultName: string, notePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(notePath.replace(/\.md$/i, ""))}`;
}
