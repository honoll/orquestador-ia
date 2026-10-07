import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  micErrorMessage,
  pickMimeType,
  readAutoRead,
  writeAutoRead,
  type VoiceStatus,
} from "./voice-utils";
import { duckLease, setDuckAvailability } from "./duck";

// ─── API ───────────────────────────────────────────────────────────────────────

async function errorFrom(r: Response): Promise<string> {
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${r.status}`;
}

export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const r = await fetch("/api/voice/status");
  if (!r.ok) throw new Error(await errorFrom(r));
  const status = (await r.json()) as VoiceStatus;
  setDuckAvailability(status.duck);
  return status;
}

export function useVoiceStatus() {
  const q = useQuery<VoiceStatus>({
    queryKey: ["voice-status"],
    queryFn: fetchVoiceStatus,
    refetchInterval: 30_000,
    retry: false,
  });
  return { status: q.data, loading: q.isLoading };
}

export async function transcribe(blob: Blob, signal?: AbortSignal): Promise<string> {
  const r = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
    signal,
  });
  if (!r.ok) throw new Error(await errorFrom(r));
  return ((await r.json()) as { text: string }).text;
}

export async function fetchSpeech(text: string, summary: boolean, signal?: AbortSignal): Promise<Blob> {
  const r = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, summary }),
    signal,
  });
  if (!r.ok) throw new Error(await errorFrom(r));
  return r.blob();
}

// ─── Reproductor único ─────────────────────────────────────────────────────────

export interface SpeechState {
  /** Identificador de lo que se está pidiendo/reproduciendo, o null. */
  id: string | null;
  phase: "idle" | "loading" | "playing";
  /** Quién inició la reproducción en curso (para que apagar la lectura automática no corte una manual). */
  origin: "auto" | "manual" | null;
  /** Error de la última reproducción y de qué id fue. */
  error: { id: string; message: string } | null;
}

let speech: SpeechState = { id: null, phase: "idle", origin: null, error: null };
const speechListeners = new Set<() => void>();
let abort: AbortController | null = null;
let audio: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
/** Ids ya leídos automáticamente (evita repetir si un efecto se vuelve a ejecutar). */
const autoRead = new Set<string>();

function setSpeech(next: SpeechState) {
  speech = next;
  speechListeners.forEach((l) => l());
}

function cleanupAudio() {
  duckLease("speak").stop();
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.onplaying = null;
    audio.onpause = null;
    audio.pause();
    audio.removeAttribute("src");
    audio = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
}

export function stopSpeech() {
  abort?.abort();
  abort = null;
  cleanupAudio();
  setSpeech({ ...speech, id: null, phase: "idle", origin: null });
}

/** Reproduce `text`; detiene cualquier otra reproducción. Una sola a la vez. */
export async function playSpeech(id: string, text: string, summary: boolean, origin: "auto" | "manual" = "manual") {
  stopSpeech();
  const ctrl = new AbortController();
  abort = ctrl;
  setSpeech({ id, phase: "loading", origin, error: null });
  const fail = (message: string) => {
    cleanupAudio();
    setSpeech({ id: null, phase: "idle", origin: null, error: { id, message } });
  };
  try {
    const blob = await fetchSpeech(text, summary, ctrl.signal);
    if (ctrl.signal.aborted) return;
    objectUrl = URL.createObjectURL(blob);
    audio = new Audio(objectUrl);
    audio.onended = () => {
      if (abort === ctrl) abort = null;
      cleanupAudio();
      setSpeech({ ...speech, id: null, phase: "idle", origin: null });
    };
    audio.onerror = () => fail("No se pudo reproducir el audio.");
    audio.onplaying = () => {
      if (!ctrl.signal.aborted) duckLease("speak").start();
    };
    audio.onpause = () => duckLease("speak").stop();
    await audio.play();
    if (ctrl.signal.aborted) return;
    setSpeech({ id, phase: "playing", origin, error: null });
  } catch (err) {
    if (ctrl.signal.aborted) return;
    const name = (err as { name?: string }).name;
    fail(
      name === "NotAllowedError"
        ? "El navegador bloqueó la reproducción automática; usa el botón «escuchar»."
        : `No se pudo leer en voz alta: ${(err as Error).message}`,
    );
  }
}

/**
 * Una frase del modo «Platicar»: usa el mismo reproductor único, pero SIN lease `speak` (el lease
 * `conversation` ya cubre el ducking y `speak` excluiría al navegador). Resuelve al terminar o al abortar.
 */
export async function playSentence(text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  stopSpeech();
  const ctrl = new AbortController();
  abort = ctrl;
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const blob = await fetchSpeech(text, false, ctrl.signal);
    if (ctrl.signal.aborted) return;
    objectUrl = URL.createObjectURL(blob);
    const a = new Audio(objectUrl);
    audio = a;
    setSpeech({ id: "conversation", phase: "playing", origin: "manual", error: null });
    await new Promise<void>((resolve, reject) => {
      a.onended = () => resolve();
      a.onerror = () => reject(new Error("No se pudo reproducir el audio."));
      ctrl.signal.addEventListener("abort", () => resolve(), { once: true });
      a.play().catch(reject);
    });
  } catch (err) {
    if (!ctrl.signal.aborted) throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Si otra reproducción tomó el reproductor, no se toca.
    if (abort === ctrl) {
      abort = null;
      cleanupAudio();
      setSpeech({ ...speech, id: null, phase: "idle", origin: null });
    }
  }
}

/** Botón «escuchar»: si ya suena (o carga) este id lo detiene; si no, lo reproduce. */
export function toggleSpeech(id: string, text: string, summary: boolean) {
  if (speech.id === id && speech.phase !== "idle") stopSpeech();
  else void playSpeech(id, text, summary);
}

/**
 * Lectura automática: solo una vez por `dedupeKey`, y solo si está activada.
 * `playId` es el mismo id que usa el SpeakButton de esa respuesta, para que el botón
 * refleje, detenga y muestre los errores de la lectura automática.
 */
export function autoSpeak(playId: string, text: string, dedupeKey: string = playId) {
  if (!getAutoRead() || autoRead.has(dedupeKey) || !text.trim()) return;
  autoRead.add(dedupeKey);
  void playSpeech(playId, text, true, "auto");
}

export function useSpeech(): SpeechState {
  return useSyncExternalStore(
    (l) => {
      speechListeners.add(l);
      return () => speechListeners.delete(l);
    },
    () => speech,
  );
}

// ─── Interruptor de lectura automática ─────────────────────────────────────────

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let autoReadOn = readAutoRead(safeStorage());
const autoReadListeners = new Set<() => void>();

export function getAutoRead(): boolean {
  return autoReadOn;
}

export function setAutoRead(on: boolean) {
  autoReadOn = on;
  writeAutoRead(safeStorage(), on);
  if (!on && speech.origin === "auto") stopSpeech();
  autoReadListeners.forEach((l) => l());
}

export function useAutoRead(): boolean {
  return useSyncExternalStore(
    (l) => {
      autoReadListeners.add(l);
      return () => autoReadListeners.delete(l);
    },
    getAutoRead,
  );
}

// ─── Grabadora ─────────────────────────────────────────────────────────────────

export type RecorderPhase = "idle" | "recording" | "transcribing";

export function useVoiceRecorder(onText: (text: string) => void) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAt = useRef(0);
  const wantStop = useRef(false);
  const starting = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const mounted = useRef(true);

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    duckLease("mic").stop();
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abortRef.current?.abort();
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        rec.onstop = null;
        rec.stop();
      }
      release();
    };
  }, [release]);

  const stop = useCallback(() => {
    wantStop.current = true;
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
  }, []);

  const start = useCallback(async () => {
    if (starting.current || recorderRef.current) return;
    starting.current = true;
    wantStop.current = false;
    setError(null);
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      starting.current = false;
      setError("Este navegador no permite grabar audio.");
      return;
    }
    let stream: MediaStream;
    const askedAt = Date.now();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      starting.current = false;
      if (mounted.current) setError(micErrorMessage(err));
      return;
    }
    starting.current = false;
    if (!mounted.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    if (wantStop.current && Date.now() - askedAt > MIN_RECORDING_MS) {
      // El diálogo de permiso hizo que se soltara el botón: no es una grabación "corta".
      stream.getTracks().forEach((t) => t.stop());
      setError("Permiso concedido; mantén presionado de nuevo para dictar.");
      return;
    }
    streamRef.current = stream;
    let rec: MediaRecorder;
    try {
      const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch (err) {
      release();
      setError(micErrorMessage(err));
      return;
    }
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onerror = () => {
      // Tras `error` llega `stop`: se ignora para no transcribir ni pisar el mensaje.
      rec.onstop = null;
      release();
      recorderRef.current = null;
      setPhase("idle");
      setError("Falló la grabación del audio.");
    };
    rec.onstop = () => {
      const duration = Date.now() - startedAt.current;
      const type = rec.mimeType || "audio/webm";
      release();
      recorderRef.current = null;
      if (!mounted.current) return;
      if (duration < MIN_RECORDING_MS || chunks.length === 0) {
        setPhase("idle");
        setError("Grabación muy corta: mantén presionado mientras hablas.");
        return;
      }
      setPhase("transcribing");
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      transcribe(new Blob(chunks, { type }), ctrl.signal)
        .then((text) => {
          if (!mounted.current) return;
          if (!text.trim()) setError("No se entendió nada; intenta de nuevo.");
          else onTextRef.current(text);
        })
        .catch((err: Error) => {
          if (ctrl.signal.aborted || !mounted.current) return;
          setError(`No se pudo transcribir: ${err.message}`);
        })
        .finally(() => {
          if (abortRef.current === ctrl) abortRef.current = null;
          if (mounted.current) setPhase("idle");
        });
    };
    recorderRef.current = rec;
    startedAt.current = Date.now();
    setElapsed(0);
    setPhase("recording");
    try {
      rec.start();
    } catch (err) {
      rec.onstop = null;
      release();
      recorderRef.current = null;
      setPhase("idle");
      setError(micErrorMessage(err));
      return;
    }
    // Ducking solo cuando la grabación realmente arrancó; sin esperar la respuesta del servidor.
    duckLease("mic").start();
    timer.current = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= MAX_RECORDING_MS) stop();
    }, 200);
    // Si se soltó el botón mientras se pedía el permiso, termina de inmediato.
    if (wantStop.current) stop();
  }, [release, stop]);

  const clearError = useCallback(() => setError(null), []);

  return { phase, elapsed, error, start, stop, clearError };
}
