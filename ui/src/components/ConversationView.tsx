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

const PHASE_STYLE: Record<ConvPhase, string> = {
  starting: "border-edge-strong text-text-secondary",
  listening: "border-accent text-accent animate-pulse",
  transcribing: "border-edge-strong text-text-primary",
  thinking: "border-edge-strong text-text-primary animate-pulse",
  speaking: "border-ok text-ok",
  ending: "border-edge-strong text-text-secondary",
  ended: "border-edge-strong text-text-secondary",
  error: "border-err text-err",
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
      className="fixed inset-0 z-50 flex flex-col items-center bg-surface-0 px-4 py-6 overflow-y-auto"
    >
      <div className="flex w-full max-w-md flex-1 flex-col items-center gap-5">
        <h2 className="font-mono text-xs uppercase tracking-widest text-text-secondary">Platicar</h2>

        <button
          ref={circleRef}
          type="button"
          onClick={() => talk.interrupt()}
          disabled={phase === "ending" || phase === "ended" || phase === "error"}
          aria-label={active ? "Interrumpir al asistente" : PHASE_LABEL[phase]}
          title={active ? "Clic para interrumpir (también Esc o espacio)" : undefined}
          className={`mt-4 flex h-44 w-44 shrink-0 items-center justify-center rounded-full border-2 bg-surface-1 text-center font-mono text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:h-52 sm:w-52 ${PHASE_STYLE[phase]}`}
        >
          {PHASE_LABEL[phase]}
        </button>

        <p role="status" aria-live="polite" className="sr-only">
          {PHASE_LABEL[phase]}
        </p>

        {phase === "error" ? (
          <div className="w-full text-center">
            <p role="alert" className="break-words font-mono text-xs text-err">{talk.error}</p>
            <button
              type="button"
              onClick={() => talk.dismiss()}
              className="mt-4 min-h-11 rounded-lg border border-edge-strong px-5 font-mono text-xs text-text-primary hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <>
            <p className="text-center font-mono text-[11px] text-text-secondary">
              Esc o espacio para interrumpir · se cierra solo tras {idleMin} min sin voz
            </p>

            {notice && (
              <p role="alert" className="w-full break-words text-center font-mono text-[11px] text-err">{notice}</p>
            )}

            <ul className="w-full space-y-2" aria-label="Últimas frases">
              {lines.map((l) => (
                <li key={l.id} className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm leading-relaxed text-text-primary">
                  <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-text-secondary">
                    {l.who === "tu" ? "tú" : "asistente"}
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
                className={`min-h-11 rounded-lg px-3 font-mono text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  bargeIn ? "text-accent" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                interrumpir con la voz: {bargeIn ? "sí" : "no"}
              </button>
              <button
                type="button"
                onClick={() => talk.end()}
                disabled={phase === "ending" || phase === "starting"}
                aria-label="Terminar la plática"
                className="min-h-11 rounded-lg border border-edge-strong px-5 font-mono text-xs text-text-primary transition-colors hover:text-err focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
              >
                Terminar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
