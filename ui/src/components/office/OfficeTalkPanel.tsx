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
  const { selectedProjectId, setConversation } = useAppState();
  const [saved, setSaved] = useState(false);
  const [useMemory, setUseMemory] = useState(false);
  const talk = useConversationSession({
    projectId: selectedProjectId,
    useMemory,
    onClose: (r) => {
      if (r.conversationId) {
        setConversation(r.conversationId);
        void qc.invalidateQueries({ queryKey: ["conversations"] });
      }
      if (r.notePath) setSaved(true);
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
      className="border-3 bg-[#0b0b0f] p-2.5 font-sans"
      style={{ borderColor: active ? ON : "var(--color-edge)", color, boxShadow: active ? `3px 3px 0 #000, 0 0 0 2px ${ON}55` : "3px 3px 0 #000" }}
    >
      <button
        type="button"
        aria-label="Platicar con el asistente por voz"
        aria-pressed={active}
        title={active ? "Clic para interrumpir (también Esc o espacio)" : undefined}
        onClick={() => (active ? talk.interrupt() : (setSaved(false), talk.start()))}
        className="block w-full text-left focus-visible:outline-[#60a5fa]"
      >
        <div className="mb-2.5 font-pixel text-[11px]">RECEPCIÓN · PLATICAR</div>
        <div className="flex items-center gap-3">
          <span className={active && phase === "listening" ? "motion-safe:animate-pulse" : undefined}><Mic /></span>
          <span role="status" aria-live="polite" className="font-pixel text-[12px]">{talkLabel(phase, active)}</span>
        </div>
        {active && lines.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs text-text-primary">
            {lines.map((l) => (
              <li key={l.id} className="truncate">
                <span style={{ color: IDLE }}>{l.who === "tu" ? "Tú: " : "Asistente: "}</span>{l.text}
              </li>
            ))}
          </ul>
        )}
      </button>
      {talk.approvalPlanId && (
        <button
          type="button"
          onClick={talk.approve}
          disabled={phase === "ending"}
          className="px-btn mt-2 w-full border-warn! bg-[#2a2108]! text-warn! focus-visible:outline-[#60a5fa]"
        >
          ABRIR PLAN PARA APROBAR
        </button>
      )}
      {error && <p role="alert" className="px-panel mt-2 break-words border-err! px-2 py-1 text-xs text-err">{error}</p>}
      {saved && !active && <p role="status" className="mt-2 text-xs text-ok">Nota guardada en Cerebro</p>}
      {!active && (
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs" title="Usa notas de Cerebro (Ollama, solo CPU) en la plática">
          <input type="checkbox" checked={useMemory} onChange={(e) => setUseMemory(e.target.checked)} className="h-4 w-4 accent-[#60a5fa]" />
          usar memoria
        </label>
      )}
      {active && (
        <div className="mt-2 flex items-center justify-between gap-2 text-xs">
          <label className="flex cursor-pointer items-center gap-1.5" title="Permite cortar al asistente hablándole; usa audífonos para evitar el eco">
            <input type="checkbox" checked={talk.bargeIn} onChange={(e) => talk.setBargeIn(e.target.checked)} className="h-4 w-4 accent-[#60a5fa]" />
            interrumpir con la voz
          </label>
          <button
            type="button"
            onClick={talk.end}
            disabled={phase === "ending" || phase === "starting"}
            className="px-btn hover:text-err focus-visible:outline-[#60a5fa]"
          >
            TERMINAR
          </button>
        </div>
      )}
    </div>
  );
}
