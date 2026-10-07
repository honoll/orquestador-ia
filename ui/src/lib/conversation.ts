// Máquina de estados pura del modo "Platicar" + cola de reproducción por frases.
// Sin React ni DOM: se prueba en node.

export type ConvPhase =
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ending"
  | "ended"
  | "error";

export type ConvEvent =
  | { type: "started" }
  | { type: "speechStart" }
  | { type: "speechEnd" }
  | { type: "transcribed"; text: string }
  | { type: "discarded" }
  | { type: "replyStarted" }
  | { type: "speakQueued" }
  | { type: "speakIdle" }
  | { type: "turnDone"; hasAudio: boolean }
  | { type: "interrupt" }
  | { type: "announce" }
  | { type: "idleTimeout" }
  | { type: "end" }
  | { type: "ended" }
  | { type: "fail"; message: string };

export type ConvState = {
  phase: ConvPhase;
  micOpen: boolean;
  error: string | null;
  lastSpeechAt: number;
  /** El turno actual ya terminó de llegar (turnDone). */
  turnDone: boolean;
  /** La cola de reproducción está vacía. */
  queueIdle: boolean;
};

export const CONV_IDLE_MS = 180_000;

export function initialConv(now: number): ConvState {
  return { phase: "starting", micOpen: false, error: null, lastSpeechAt: now, turnDone: false, queueIdle: true };
}

function micFor(phase: ConvPhase, bargeIn: boolean): boolean {
  return phase === "listening" || (phase === "speaking" && bargeIn);
}

export function convReducer(
  s: ConvState,
  e: ConvEvent,
  now: number,
  opts: { bargeIn: boolean },
): ConvState {
  if (s.phase === "ended" || s.phase === "error") return s;
  const p0 = s.phase;
  const to = (phase: ConvPhase, extra: Partial<ConvState> = {}): ConvState => ({
    ...s,
    ...(phase === "listening" && p0 !== "listening" ? { lastSpeechAt: now } : {}),
    ...extra,
    phase,
    micOpen: micFor(phase, opts.bargeIn),
  });
  const p = s.phase;
  switch (e.type) {
    case "started":
      return p === "starting" ? to("listening") : s;
    case "speechStart":
      if (p === "listening") return to("listening", { lastSpeechAt: now });
      if (p === "speaking" && opts.bargeIn) return to("listening", { lastSpeechAt: now });
      return s;
    case "speechEnd":
      return p === "listening" ? to("transcribing", { lastSpeechAt: now }) : s;
    case "transcribed":
      return p === "transcribing" ? to("thinking", { turnDone: false, queueIdle: true }) : s;
    case "discarded":
      return p === "transcribing" ? to("listening") : s;
    case "replyStarted":
      return p === "thinking" || p === "speaking" ? to("speaking") : s;
    case "speakQueued":
      return p === "thinking" || p === "speaking" ? to("speaking", { queueIdle: false }) : s;
    case "speakIdle":
      if (p !== "speaking") return s;
      return s.turnDone ? to("listening", { queueIdle: true }) : to("speaking", { queueIdle: true });
    case "turnDone":
      if (p !== "thinking" && p !== "speaking") return s;
      if (!e.hasAudio || s.queueIdle) return to("listening", { turnDone: true });
      return to("speaking", { turnDone: true });
    case "interrupt":
      return p === "speaking" || p === "thinking" ? to("listening", { turnDone: true, queueIdle: true }) : s;
    case "announce":
      return p === "listening" ? to("speaking", { turnDone: true, queueIdle: false }) : s;
    case "idleTimeout":
      return p === "listening" && now - s.lastSpeechAt >= CONV_IDLE_MS ? to("ending") : s;
    case "end":
      return p === "ending" ? s : to("ending");
    case "ended":
      return to("ended");
    case "fail":
      return { ...s, phase: "error", micOpen: false, error: e.message };
  }
}

/** Tope de una frase del usuario (el servidor rechaza audio de más de 120 s). */
export const MAX_SPEECH_MS = 60_000;

/**
 * Temporizador de frase máxima: arranca con speechStart y, si la frase no terminó a tiempo, avisa
 * (onExpire) para forzar el cierre. cancel() al terminar, en misfire, al interrumpir y al desmontar.
 */
export function createMaxSpeechTimer(deps: {
  onExpire: () => void;
  ms?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}): { start(): void; cancel(): void; armed(): boolean } {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const ms = deps.ms ?? MAX_SPEECH_MS;
  let handle: unknown = null;
  let armed = false;
  return {
    start() {
      // Un segundo speechStart dentro de la misma frase no reinicia el reloj.
      if (armed) return;
      armed = true;
      handle = setTimer(() => {
        armed = false;
        handle = null;
        deps.onExpire();
      }, ms);
    },
    cancel() {
      if (handle !== null) clearTimer(handle);
      handle = null;
      armed = false;
    },
    armed: () => armed,
  };
}

type QueueDeps<T> =
  | { speak: (text: string, signal: AbortSignal) => Promise<void> }
  | {
      /** Pide el audio de una frase (se adelanta mientras suena la anterior). */
      fetch: (text: string, signal: AbortSignal) => Promise<T>;
      /** Reproduce lo ya pedido; debe resolver al terminar o al abortarse. */
      play: (item: T, signal: AbortSignal) => Promise<void>;
      /** Máximo de frases pedidas por adelantado (en vuelo o listas) además de la que toca ahora. Por defecto 1: con la que se espera, 2 pedidos en vuelo como mucho. */
      maxAhead?: number;
    };

/**
 * Cola de reproducción por frases con prefetch: el audio de la frase n+1 se pide mientras suena la n,
 * pero siempre se reproduce en orden de llegada aunque los pedidos terminen desordenados.
 * La forma antigua { speak } sigue funcionando (sin prefetch).
 */
export function createSpeechQueue<T = string>(deps: QueueDeps<T>): {
  enqueue(sentence: string): void;
  stop(): void;
  idle(): boolean;
  onIdle(cb: () => void): void;
} {
  const fetchFn = ("fetch" in deps ? deps.fetch : async (t: string) => t as unknown as T) as (
    text: string,
    signal: AbortSignal,
  ) => Promise<T>;
  const playFn =
    "play" in deps
      ? deps.play
      : (item: T, signal: AbortSignal) => deps.speak(item as unknown as string, signal);
  const maxAhead = "fetch" in deps ? Math.max(1, deps.maxAhead ?? 1) : 1;

  type Item = { text: string; ctl: AbortController; p: Promise<T> | null };
  let pending: Item[] = [];
  let current: Item | null = null;
  let running = false;
  let generation = 0;
  let idleCb: (() => void) | null = null;

  // Pide por adelantado las primeras maxAhead frases pendientes.
  function prefetch(): void {
    for (const it of pending.slice(0, maxAhead)) {
      if (it.p) continue;
      const p = fetchFn(it.text, it.ctl.signal);
      p.catch(() => {}); // el error se maneja al esperar la frase
      it.p = p;
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    const gen = generation;
    while (pending.length > 0 && gen === generation) {
      prefetch();
      const item = pending.shift() as Item;
      current = item;
      prefetch(); // la frase que sigue se pide mientras esta suena
      try {
        const value = await (item.p as Promise<T>);
        if (gen !== generation) break;
        await playFn(value, item.ctl.signal);
      } catch {
        // una frase fallida no detiene las siguientes
      }
      if (current === item) current = null;
    }
    if (gen === generation) {
      running = false;
      idleCb?.();
    }
  }

  return {
    enqueue(sentence) {
      pending.push({ text: sentence, ctl: new AbortController(), p: null });
      if (running) prefetch();
      void pump();
    },
    stop() {
      generation++;
      for (const it of pending) it.ctl.abort();
      current?.ctl.abort();
      pending = [];
      current = null;
      running = false;
    },
    idle: () => !running && pending.length === 0,
    onIdle(cb) {
      idleCb = cb;
    },
  };
}
