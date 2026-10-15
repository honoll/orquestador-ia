import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWs } from "../../context/WebSocketProvider";
import { useAppState } from "../../context/AppStateContext";
import { refreshesOffice } from "../../lib/office-view";
import { AgentCards } from "./AgentCards";
import { OfficeScene } from "./OfficeScene";
import { QueuePanel } from "./QueuePanel";
import { PlansPanel } from "./PlansPanel";
import { LogPanel } from "./LogPanel";
import { WorkersPanel } from "./WorkersPanel";

// Espejo de src/server/office-state.ts (la UI no importa código del servidor).
export interface AgentState { id: import("../../lib/office").AgentId; working: boolean; desks: number; activity: string; model: string; tokens: number; paused?: boolean; seats?: AgySeat[] }
export interface AgySeat { local: boolean; account: string; pool: string | null; working: boolean; activity: string; model: string | null; role: string | null }
export interface QueueItem { planId: string; stepId: string; stepKey: string | null; description: string; adapter: string; status: "running" | "pending" | "paused"; project: string | null }
export interface PlanSummary { id: string; description: string; status: string; pauseReason: string | null; updatedAt: string }
export interface OfficeState { agents: AgentState[]; queue: QueueItem[]; plans: PlanSummary[]; generatedAt: string }

async function fetchOffice(): Promise<OfficeState> {
  const res = await fetch("/api/office/state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function OfficeView() {
  const qc = useQueryClient();
  const { subscribe, officeLog } = useWs();
  const { setActivePlanId, setView, talkActive } = useAppState();
  const { data, isError } = useQuery({
    queryKey: ["office"],
    queryFn: fetchOffice,
    retry: 1, // que el aviso "sin conexión" no tarde ~7 s
    staleTime: 0, // al volver a la vista no hubo quien escuchara eventos: foto nueva
    refetchInterval: (q) => (q.state.status === "error" ? 10_000 : false),
  });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = subscribe((ev) => {
      // Temporizador que no se reinicia: las ráfagas (deltas de voz) refrescan cada 300 ms como mucho.
      if (refreshesOffice(ev.type) && !timer) {
        timer = setTimeout(() => {
          timer = null;
          void qc.invalidateQueries({ queryKey: ["office"] });
        }, 300);
      }
    });
    return () => { unsub(); if (timer) clearTimeout(timer); };
  }, [subscribe, qc]);

  // Con la plática abierta no se sale de la Oficina (igual que el selector de vista).
  const openPlan = (id: string) => { if (talkActive) return; setActivePlanId(id); setView("chat"); };
  const agents = data?.agents ?? [];
  const queue = data?.queue ?? [];

  return (
    <div className="@container h-full overflow-y-auto bg-surface-0 font-mono text-xs text-text-primary">
      {isError && (
        <p role="alert" className="mx-3 mt-2 rounded border border-err/40 px-2 py-1 text-err">
          sin conexión con el servidor{data ? ` — mostrando la última foto (${new Date(data.generatedAt).toLocaleTimeString("es-MX")})` : ""}
        </p>
      )}
      <AgentCards agents={agents} />
      <div className="grid gap-2.5 px-3 pb-3 @min-[1060px]:grid-cols-[minmax(0,1fr)_300px]">
        <OfficeScene agents={agents} queue={queue} />
        <div className="grid content-start gap-2.5 @min-[700px]:grid-cols-3 @min-[1060px]:grid-cols-1">
          <QueuePanel queue={queue} onOpen={openPlan} />
          <WorkersPanel />
          <PlansPanel plans={data?.plans ?? []} onOpen={openPlan} />
          <LogPanel entries={officeLog} />
        </div>
      </div>
    </div>
  );
}
