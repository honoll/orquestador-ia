import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppState } from "../../context/AppStateContext";
import { useConversationSession } from "../../lib/use-conversation";
import { talkLabel } from "../../lib/office-view";

const IDLE = "#8b8b94";
const ON = "#60a5fa";

function Mic() {
  return (
    <svg className="h-9 w-7 shrink-0" viewBox="0 0 7 9" shapeRendering="crispEdges" fill="currentColor" aria-hidden="true">
      <rect x="2" y="0" width="3" height="5" /><rect x="0" y="3" width="1" height="2" /><rect x="6" y="3" width="1" height="2" />
      <rect x="1" y="5" width="5" height="1" /><rect x="3" y="6" width="1" height="2" /><rect x="1" y="8" width="5" height="1" />
    </svg>
  );
}

/** «Platicar» dentro de la Oficina: gris en reposo, azul con la plática abierta. */
export function OfficeTalkPanel() {
  const qc = useQueryClient();
  const { selectedProjectId, setActivePlanId, setView, setConversation } = useAppState();
  const [saved, setSaved] = useState(false);
  const talk = useConversationSession({
    projectId: selectedProjectId,
    onClose: (r) => {
      if (r.conversationId) {
        setConversation(r.conversationId);
        void qc.invalidateQueries({ queryKey: ["conversations"] });
      }
      if (r.notePath) setSaved(true);
      // Plan de voz que espera aprobación: se abre en el chat como lo hace «Platicar».
      if (r.approvalPlanId) {
        void qc.invalidateQueries({ queryKey: ["plans"] });
        setActivePlanId(r.approvalPlanId);
        setView("chat");
      }
    },
  });
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 5000);
    return () => clearTimeout(t);
  }, [saved]);

  const { active, phase } = talk;
  const color = active ? ON : IDLE;
  const error = active ? talk.notice : phase === "error" ? talk.error : null;
  const lines = talk.lines.slice(-2);

  return (
    <div
      className="rounded border-2 bg-[#0b0b0f] p-2.5 transition-shadow"
      style={{ borderColor: active ? ON : "#22222a", color, boxShadow: active ? `0 0 14px ${ON}55` : undefined }}
    >
      <button
        type="button"
        aria-label="Platicar con el asistente por voz"
        aria-pressed={active}
        title={active ? "Clic para interrumpir (también Esc o espacio)" : undefined}
        onClick={() => (active ? talk.interrupt() : (setSaved(false), talk.start()))}
        className="block w-full text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#60a5fa]"
      >
        <div className="mb-2.5 text-xs font-bold tracking-[.22em]">RECEPCIÓN · PLATICAR</div>
        <div className="flex items-center gap-3">
          <span className={active && phase === "listening" ? "motion-safe:animate-pulse" : undefined}><Mic /></span>
          <span role="status" aria-live="polite" className="font-bold tracking-[.14em]">{talkLabel(phase, active)}</span>
        </div>
        {active && lines.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-[11px] text-text-primary">
            {lines.map((l) => (
              <li key={l.id} className="truncate">
                <span style={{ color: IDLE }}>{l.who === "tu" ? "Tú: " : "Asistente: "}</span>{l.text}
              </li>
            ))}
          </ul>
        )}
      </button>
      {error && <p role="alert" className="mt-2 break-words text-[11px] text-err">{error}</p>}
      {saved && !active && <p role="status" className="mt-2 text-[11px] text-ok">Nota guardada en Cerebro</p>}
      {active && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px]">
          <label className="flex cursor-pointer items-center gap-1.5" title="Permite cortar al asistente hablándole; usa audífonos para evitar el eco">
            <input type="checkbox" checked={talk.bargeIn} onChange={(e) => talk.setBargeIn(e.target.checked)} className="accent-[#60a5fa]" />
            interrumpir con la voz
          </label>
          <button
            type="button"
            onClick={talk.end}
            disabled={phase === "ending" || phase === "starting"}
            className="border-2 border-current px-2 py-0.5 hover:text-err focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#60a5fa] disabled:opacity-40"
          >
            terminar
          </button>
        </div>
      )}
    </div>
  );
}
