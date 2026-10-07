import { useVoiceRecorder, useVoiceStatus } from "../lib/voice";
import { dictationUnavailableReason, formatElapsed, transcribingLabel } from "../lib/voice-utils";

/**
 * «Mantén para hablar»: graba mientras está presionado (puntero o Espacio/Enter)
 * y al soltar inserta el texto transcrito en la caja; nunca envía.
 */
export function MicButton({ onText, disabled = false }: { onText: (text: string) => void; disabled?: boolean }) {
  const { status, loading } = useVoiceStatus();
  const { phase, elapsed, error, start, stop } = useVoiceRecorder(onText);
  const unavailable = dictationUnavailableReason(status, loading);
  const off = disabled || unavailable !== null || phase === "transcribing";
  const recording = phase === "recording";

  const label = recording ? "Grabando… suelta para transcribir" : "Mantén presionado para dictar";
  const title = unavailable ?? (disabled ? "No disponible en este momento" : label);

  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <button
        type="button"
        disabled={off}
        aria-pressed={recording}
        aria-label={label}
        title={title}
        onPointerDown={(e) => {
          if (e.button !== 0 || off) return;
          e.preventDefault();
          void start();
        }}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if ((e.key === " " || e.key === "Enter") && !off) {
            e.preventDefault();
            if (!e.repeat) void start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            stop();
          }
        }}
        onBlur={stop}
        className={`min-h-6 min-w-6 select-none touch-none rounded-sm border px-1.5 font-mono text-sm leading-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-30 ${
          recording ? "border-err text-err" : "border-edge text-text-tertiary hover:text-text-secondary"
        }`}
      >
        <span aria-hidden="true">{recording ? "●" : "🎤"}</span>
      </button>
      <span role="status" aria-live="polite" className="font-mono text-[10px] text-text-secondary">
        {recording && <span className="text-err">grabando {formatElapsed(elapsed)}</span>}
        {phase === "transcribing" && transcribingLabel(status?.whisper.state)}
      </span>
      {error && (
        <span role="alert" className="max-w-64 break-words font-mono text-[10px] text-err">{error}</span>
      )}
    </span>
  );
}
