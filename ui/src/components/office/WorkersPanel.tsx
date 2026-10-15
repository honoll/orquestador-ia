import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Panel } from "./QueuePanel";

// Sin rutas de llaves en la UI: el servidor las devuelve, aquí ni se tipan ni se muestran.
interface Worker { id: string; accountLabel: string; port: number; enabled: boolean; healthy: boolean | null }

export function WorkersPanel() {
  const qc = useQueryClient();
  const { data: workers = [] } = useQuery({
    queryKey: ["agy-workers"],
    queryFn: async (): Promise<Worker[]> => {
      const r = await fetch("/api/agy-workers");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });
  const [probed, setProbed] = useState<Record<string, boolean | "wait">>({});
  const [error, setError] = useState<string | null>(null);
  const probe = async (id: string) => {
    setProbed((p) => ({ ...p, [id]: "wait" }));
    const ok = await fetch(`/api/agy-workers/${id}/health`).then((r) => r.ok).catch(() => false);
    setProbed((p) => ({ ...p, [id]: ok }));
  };
  const toggle = async (w: Worker) => {
    setError(null);
    const ok = await fetch(`/api/agy-workers/${w.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !w.enabled }) }).then((r) => r.ok).catch(() => false);
    if (!ok) setError(`No se pudo cambiar ${w.accountLabel}`);
    void qc.invalidateQueries({ queryKey: ["agy-workers"] }); // el checkbox sigue al servidor: si falló, vuelve solo
  };
  return (
    <Panel title="TRABAJADORES DE AGY">
      {error && <p role="alert" className="mb-1 text-err">{error}</p>}
      {workers.length === 0 ? <p className="text-text-secondary">sin trabajadores</p> : (
        <ul>
          {workers.map((w) => {
            const h = probed[w.id] ?? w.healthy;
            const txt = h === "wait" ? "probando…" : h === true ? "ok" : h === false ? "caído" : "desconocido";
            return (
              <li key={w.id} className="flex items-center gap-2 border-t border-white/[.03] py-1">
                <span className="min-w-0 flex-1 truncate" title={`${w.accountLabel} · puerto ${w.port}`}>{w.accountLabel} <span className="text-text-secondary">:{w.port}</span></span>
                <span className={h === true ? "text-ok" : h === false ? "text-err" : "text-text-secondary"}>{txt}</span>
                <button type="button" className="rounded bg-surface-3 px-1.5 py-px hover:bg-surface-2" onClick={() => void probe(w.id)} aria-label={`Probar ${w.accountLabel}`}>probar</button>
                <label className="flex items-center gap-1 text-text-secondary">
                  <input type="checkbox" checked={w.enabled} onChange={() => void toggle(w)} aria-label={`Habilitar ${w.accountLabel}`} />on
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
