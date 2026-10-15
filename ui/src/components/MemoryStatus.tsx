import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useWs } from "../context/WebSocketProvider";
import { fetchMemoryStatus, type MemoryStatusData } from "../lib/memory-api";

const btn =
  "px-btn text-left";

export function MemoryStatus() {
  const { lastEvent } = useWs();
  const { data, refetch } = useQuery<MemoryStatusData>({
    queryKey: ["memory-status"],
    queryFn: fetchMemoryStatus,
    refetchInterval: 60_000,
  });
  const reindex = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/memory/reindex", { method: "POST" });
      if (!r.ok && r.status !== 409) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    },
    onSettled: () => { void refetch(); },
  });

  useEffect(() => {
    if ((lastEvent as { type?: string } | null)?.type === "memory:indexed") void refetch();
  }, [lastEvent, refetch]);

  if (!data) return null;
  const busy = data.indexing || reindex.isPending;
  const when = data.lastIndexedAt ? new Date(data.lastIndexedAt).toLocaleString("es-MX") : "nunca";

  let line: string;
  let warn = false;
  if (!data.ollama.ok) { line = "Ollama no disponible: la memoria será limitada (solo notas del proyecto)"; warn = true; }
  else if (!data.ollama.modelAvailable) { line = `Falta el modelo ${data.model} en Ollama (ollama pull ${data.model})`; warn = true; }
  else line = `memoria: ${data.notes} notas · ${data.chunks} trozos · actualizado ${when}`;

  return (
    <section aria-labelledby="memoria-titulo" className="space-y-1 border-t-[3px] border-edge px-4 py-3 text-xs text-text-secondary">
      <h2 id="memoria-titulo" className="break-words font-pixel text-[11px] uppercase text-text-tertiary">memoria (Cerebro)</h2>
      <p role="status" className={`break-words ${warn ? "border-2 border-warn px-1.5 text-warn" : "text-text-secondary"}`}>{line}</p>
      <button type="button" className={btn} disabled={busy} aria-busy={busy} onClick={() => reindex.mutate()}>
        {busy ? "indexando…" : "reindexar"}
      </button>
      {reindex.isError && <p role="alert" className="break-words border-2 border-err px-1.5 text-err">{(reindex.error as Error).message}</p>}
    </section>
  );
}
