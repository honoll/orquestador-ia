import { useEffect, useRef } from "react";
import { CONV_IDLE_MS, type ConvPhase } from "../lib/conversation";
import { useConversationSession, type ConversationResult } from "../lib/use-conversation";

export type { ConversationResult };

const PHASE_LABEL: Record<ConvPhase, string> = {
  starting: "Preparando…",
  listening: "Escuchando",
  transcribing: "Transcribiendo",
  thinking: "Pensando",
  speaking: "Hablando",
  ending: "Terminando…",
  ended: "Terminada",
  error: "No se pudo continuar",
};

// Botón pixel: gris reposo · azul escuchando · morado pensando · verde hablando.
const IDLE = "border-edge-strong bg-surface-2 text-text-secondary";
const PHASE_STYLE: Record<ConvPhase, string> = {
  starting: IDLE,
  listening: "border-blue bg-[#13314f] text-white motion-safe:animate-pulse",
  transcribing: "border-accent bg-[#2e2560] text-white",
  thinking: "border-accent bg-[#2e2560] text-white motion-safe:animate-pulse",
  speaking: "border-ok bg-[#0f2e24] text-white",
  ending: IDLE,
  ended: IDLE,
  error: "border-err bg-surface-2 text-err",
};

/** Vista de pantalla completa de «Platicar»; la lógica vive en useConversationSession. */
export function ConversationView({
  projectId,
  useMemory,
  onClose,
}: {
  projectId: string | null;
  useMemory: boolean;
  onClose: (result: ConversationResult) => void;
}) {
  const circleRef = useRef<HTMLButtonElement>(null);
  const talk = useConversationSession({ projectId, useMemory, onClose, onStarted: () => circleRef.current?.focus() });
  const { start, lines, bargeIn, notice } = talk;

  useEffect(() => { start(); }, [start]);

  const phase = talk.phase;
  const idleMin = Math.round(CONV_IDLE_MS / 60000);
  const active = phase === "speaking" || phase === "thinking";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Plática por voz"
      className="px-grid fixed inset-0 z-50 flex flex-col items-center bg-surface-0 px-4 py-6 overflow-y-auto"
    >
      <div className="flex w-full max-w-md flex-1 flex-col items-center gap-5">
        <h2 className="font-pixel text-[13px] text-text-secondary">PLATICAR</h2>

        <button
          ref={circleRef}
          type="button"
          onClick={() => talk.interrupt()}
          disabled={phase === "ending" || phase === "ended" || phase === "error"}
          aria-label={active ? "Interrumpir al asistente" : PHASE_LABEL[phase]}
          title={active ? "Clic para interrumpir (también Esc o espacio)" : undefined}
          className={`mt-4 flex h-44 w-44 shrink-0 items-center justify-center border-[3px] p-3 text-center font-pixel text-[14px] shadow-[3px_3px_0_#000] active:enabled:translate-x-[2px] active:enabled:translate-y-[2px] active:enabled:shadow-[1px_1px_0_#000] disabled:cursor-not-allowed sm:h-52 sm:w-52 ${PHASE_STYLE[phase]}`}
        >
          {PHASE_LABEL[phase].toUpperCase()}
        </button>

        <p role="status" aria-live="polite" className="sr-only">
          {PHASE_LABEL[phase]}
        </p>

        {phase === "error" ? (
          <div className="w-full text-center">
            <p role="alert" className="break-words border-[3px] border-err bg-err/10 px-3 py-2 text-sm text-err">{talk.error}</p>
            {talk.approvalPlanId && (
              <button
                type="button"
                onClick={talk.approve}
                className="px-btn mt-4 mr-2 min-h-11 border-warn! px-5 text-warn!"
              >
                ABRIR PLAN PARA APROBAR
              </button>
            )}
            <button
              type="button"
              onClick={() => talk.dismiss()}
              className="px-btn mt-4 min-h-11 px-5"
            >
              CERRAR
            </button>
          </div>
        ) : (
          <>
            <p className="text-center text-xs text-text-secondary">
              Esc o espacio para interrumpir · se cierra solo tras {idleMin} min sin voz
            </p>

            {talk.approvalPlanId && (
              <button
                type="button"
                onClick={talk.approve}
                disabled={phase === "ending"}
                className="px-btn min-h-11 w-full border-warn! bg-[#2a2108]! px-4 text-warn! disabled:opacity-40"
              >
                ABRIR PLAN PARA APROBAR
              </button>
            )}

            {notice && (
              <p role="alert" className="w-full break-words border-[3px] border-err bg-err/10 px-3 py-1 text-center text-xs text-err">{notice}</p>
            )}

            <ul className="w-full space-y-2" aria-label="Últimas frases">
              {lines.map((l) => (
                <li key={l.id} className={`px-panel px-3 py-2 text-sm text-text-primary ${l.who === "tu" ? "border-[#4c3d85]! bg-[#1d1733]!" : ""}`}>
                  <span className="mr-2 font-pixel text-[11px] text-text-secondary">
                    {l.who === "tu" ? "TÚ" : "ASISTENTE"}
                  </span>
                  {l.text}
                </li>
              ))}
            </ul>

            <div className="mt-auto flex w-full flex-wrap items-center justify-between gap-3 pt-4">
              <button
                type="button"
                role="switch"
                aria-checked={bargeIn}
                aria-label="Interrumpir con la voz"
                title="Permite cortar al asistente hablándole; usa audífonos para evitar el eco"
                onClick={() => {
                  talk.setBargeIn(!bargeIn);
                  // El espacio debe seguir interrumpiendo, no volver a alternar este interruptor.
                  circleRef.current?.focus();
                }}
                className={`px-btn min-h-11 px-3 ${bargeIn ? "px-btn-pri" : ""}`}
              >
                interrumpir con la voz: {bargeIn ? "sí" : "no"}
              </button>
              <button
                type="button"
                onClick={() => talk.end()}
                disabled={phase === "ending" || phase === "starting"}
                aria-label="Terminar la plática"
                className="px-btn min-h-11 px-5 hover:enabled:border-err! hover:enabled:text-err!"
              >
                TERMINAR
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
