// Helpers puros de voz (sin DOM ni React) para poder probarlos con vitest.

export type WhisperState = "stopped" | "starting" | "warming" | "ready" | "failed";

export interface VoiceStatus {
  whisper: { available: boolean; state: WhisperState };
  piper: { available: boolean; voice: string };
  duck?: { supported: boolean; enabled: boolean };
}

/** Duración máxima de una grabación (el servidor rechaza más de 120 s). */
export const MAX_RECORDING_MS = 115_000;
/** Menos que esto se considera un toque accidental. */
export const MIN_RECORDING_MS = 400;

/** Agrega el texto dictado al existente, separado por un espacio. No toca el texto si no hay nada que agregar. */
export function appendTranscript(existing: string, transcript: string): string {
  const add = transcript.trim();
  if (!add) return existing;
  if (!existing.trim()) return add;
  return /\s$/.test(existing) ? existing + add : `${existing} ${add}`;
}

/** 0:07, 1:05. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Mensaje en español para un error de getUserMedia / MediaRecorder. */
export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "No hay permiso para usar el micrófono. Permítelo en el candado de la barra de direcciones.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No se encontró ningún micrófono.";
    case "NotReadableError":
    case "AbortError":
      return "El micrófono está ocupado por otra aplicación.";
    default:
      return "No se pudo grabar el audio.";
  }
}

/** Por qué no se puede dictar, o null si se puede. */
export function dictationUnavailableReason(status: VoiceStatus | undefined, loading: boolean): string | null {
  if (loading) return "Comprobando la voz local…";
  if (!status) return "No se pudo consultar el estado de la voz local.";
  if (!status.whisper.available) return "Dictado no disponible: falta whisper.cpp o su modelo en el servidor.";
  return null;
}

/** Por qué no se puede escuchar, o null si se puede. */
export function speechUnavailableReason(status: VoiceStatus | undefined, loading: boolean): string | null {
  if (loading) return "Comprobando la voz local…";
  if (!status) return "No se pudo consultar el estado de la voz local.";
  if (!status.piper.available) return "Lectura no disponible: falta Piper o su voz en el servidor.";
  return null;
}

/** Texto de estado mientras se transcribe. */
export function transcribingLabel(state: WhisperState | undefined): string {
  return state === "starting" || state === "warming"
    ? "preparando Whisper (puede tardar ~40 s la primera vez)…"
    : "transcribiendo…";
}

/** Primer tipo de audio que el navegador sabe grabar, preferido webm. */
export function pickMimeType(isSupported: (t: string) => boolean): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm"].find((t) => isSupported(t));
}

export const AUTO_READ_KEY = "orquestador.leerAutomaticamente";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Lee la preferencia; cualquier fallo del almacenamiento equivale a "desactivado". */
export function readAutoRead(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(AUTO_READ_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeAutoRead(storage: StorageLike | null | undefined, on: boolean): void {
  try {
    storage?.setItem(AUTO_READ_KEY, on ? "1" : "0");
  } catch {
    /* almacenamiento bloqueado: la preferencia vive solo en memoria */
  }
}
