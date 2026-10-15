import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWs } from "../../context/WebSocketProvider";
import { useAppState } from "../../context/AppStateContext";
import { MODE_KEY, readOfficeMode, refreshesOffice, type OfficeMode } from "../../lib/office-view";
import { AgentCards } from "./AgentCards";
import { OfficeScene } from "./OfficeScene";
import { QueuePanel } from "./QueuePanel";
import { PlansPanel } from "./PlansPanel";
import { LogPanel } from "./LogPanel";
import { WorkersPanel } from "./WorkersPanel";
import { OfficeWorld } from "./OfficeWorld";
import { WorldDialog, type DialogHandle } from "./WorldDialog";
import { AccountRack } from "./AccountRack";
import { OfficeTalkPanel } from "./OfficeTalkPanel";
import type { WorldAgent } from "../../office/world/placement";

import type { OfficeState } from "../../lib/office-state";

// Espejo de los tipos del servidor: viven en lib/office-state.ts; se reexportan aquí.
export type { AgentState, AgySeat, QueueItem, PlanSummary, OfficeState } from "../../lib/office-state";

function storedMode(): OfficeMode {
  try { return readOfficeMode(localStorage.getItem(MODE_KEY)); } catch { return "mundo"; }
}

async function fetchOffice(): Promise<OfficeState> {
  const res = await fetch("/api/office/state");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function OfficeView() {
  const qc = useQueryClient();
  const { subscribe, officeLog } = useWs();
  const { setActivePlanId, setView, talkActive } = useAppState();
  const [mode, setModeState] = useState<OfficeMode>(storedMode);
  const [near, setNear] = useState<WorldAgent | null>(null);
  const dialog = useRef<DialogHandle>(null);
  const setMode = (m: OfficeMode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* sin almacenamiento: solo esta sesión */ }
  };
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
      {/* Cambiar de modo desmontaría el panel de Platicar con la plática abierta: se bloquea como el selector de vista. */}
      <div role="group" aria-label="Modo de la Oficina" className="flex items-center gap-1 px-3 pb-2 text-[11px]">
        {(["mundo", "escritorios"] as const).map((m, i) => (
          <span key={m} className="flex items-center gap-1">
            {i > 0 && <span aria-hidden="true" className="text-text-tertiary">·</span>}
            <button
              aria-pressed={mode === m}
              disabled={talkActive && mode !== m}
              title={talkActive && mode !== m ? "Termina la plática para cambiar de modo" : undefined}
              className={`rounded px-1.5 py-0.5 disabled:opacity-50 ${mode === m ? "bg-white/10 text-text-primary" : "text-text-secondary hover:text-text-primary"}`}
              onClick={() => setMode(m)}
            >{m}</button>
          </span>
        ))}
      </div>
      <div className="grid gap-2.5 px-3 pb-3 @min-[1060px]:grid-cols-[minmax(0,1fr)_300px]">
        {mode === "mundo" ? (
          <OfficeWorld state={data} onNear={setNear} onAdvance={() => dialog.current?.advance()}>
            {near && <WorldDialog key={near.key} ref={dialog} agent={near} log={officeLog} onOpenPlan={openPlan} />}
          </OfficeWorld>
        ) : (
          <OfficeScene agents={agents} queue={queue} />
        )}
        <div className="grid content-start gap-2.5 @min-[700px]:grid-cols-3 @min-[1060px]:grid-cols-1">
          {mode === "mundo" && <><AccountRack /><OfficeTalkPanel /></>}
          <QueuePanel queue={queue} onOpen={openPlan} />
          <WorkersPanel />
          <PlansPanel plans={data?.plans ?? []} onOpen={openPlan} />
          <LogPanel entries={officeLog} />
        </div>
      </div>
    </div>
  );
}
