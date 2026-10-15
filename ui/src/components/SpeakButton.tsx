import { setAutoRead, toggleSpeech, useAutoRead, useSpeech, useVoiceStatus } from "../lib/voice";
import { speechUnavailableReason } from "../lib/voice-utils";

/** «escuchar» / «detener»: lee el texto completo (sin resumen) con Piper. */
export function SpeakButton({ id, text }: { id: string; text: string }) {
  const { status, loading } = useVoiceStatus();
  const speech = useSpeech();
  const unavailable = speechUnavailableReason(status, loading);
  const active = speech.id === id && speech.phase !== "idle";
  const error = speech.error?.id === id ? speech.error.message : null;
  const empty = !text.trim();

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={(unavailable !== null || empty) && !active}
        aria-pressed={active}
        aria-label={active ? "Detener la lectura en voz alta" : "Escuchar esta respuesta"}
        title={unavailable ?? (active ? "Detener la lectura" : "Escuchar esta respuesta")}
        onClick={() => toggleSpeech(id, text, false)}
        className={`px-btn min-h-6 px-2 ${active ? "px-btn-pri" : ""}`}
      >
        {active ? (speech.phase === "loading" ? "preparando… (detener)" : "detener") : "escuchar"}
      </button>
      {error && <span role="alert" className="break-words text-xs text-err">{error}</span>}
    </span>
  );
}

/** Interruptor «leer en voz alta automáticamente» (lee el resumen corto). */
export function AutoReadToggle() {
  const on = useAutoRead();
  const { status, loading } = useVoiceStatus();
  const unavailable = speechUnavailableReason(status, loading);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label="Leer en voz alta automáticamente"
      disabled={unavailable !== null}
      title={unavailable ?? "Lee en voz alta un resumen corto cuando termina una respuesta o un plan"}
      onClick={() => setAutoRead(!on)}
      className={`px-btn min-h-6 px-1.5 ${on ? "px-btn-pri" : ""}`}
    >
      leer en voz alta: {on ? "sí" : "no"}
    </button>
  );
}
