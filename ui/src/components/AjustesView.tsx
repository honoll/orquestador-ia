import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AccountsPanel } from "./AccountsPanel";
import { WorkerIsolationNotice } from "./WorkerIsolationNotice";
import { MemoryStatus } from "./MemoryStatus";
import { ClaudeProfiles } from "./ClaudeProfiles";
import { WorkersPanel } from "./office/WorkersPanel";

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section aria-label={titulo} className="px-panel bg-surface-1 p-3">
      <h2 className="mb-2 font-pixel text-[12px] text-text-secondary">{titulo}</h2>
      {children}
    </section>
  );
}

function Caveman() {
  const { data } = useQuery({
    queryKey: ["caveman-status"],
    queryFn: () => fetch("/api/caveman/status").then((r) => r.json() as Promise<{ active: boolean; mode: string }>),
  });
  if (!data?.active) return null;
  return <p className="mt-2 text-text-secondary">caveman activo: {data.mode}</p>;
}

/** Vista AJUSTES (F15): lo que antes vivía en la barra lateral, sin reescribirlo. */
export function AjustesView() {
  return (
    <div className="@container h-full overflow-y-auto bg-surface-0 p-3 text-text-primary">
      <div className="grid gap-3 @3xl:grid-cols-2">
        <Seccion titulo="CUENTAS DE ANTIGRAVITY"><AccountsPanel /></Seccion>
        <WorkersPanel />
        <Seccion titulo="CLAUDE"><ClaudeProfiles /><Caveman /></Seccion>
        <Seccion titulo="CODEX"><WorkerIsolationNotice /></Seccion>
        <Seccion titulo="MEMORIA"><MemoryStatus /></Seccion>
      </div>
    </div>
  );
}
