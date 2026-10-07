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
};

export const CONV_IDLE_MS = 180_000;

export function initialConv(now: number): ConvState {
  return { phase: "starting", micOpen: false, error: null, lastSpeechAt: now };
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
  const to = (phase: ConvPhase, extra: Partial<ConvState> = {}): ConvState => ({
    ...s,
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
      return p === "transcribing" ? to("thinking") : s;
    case "discarded":
      return p === "transcribing" ? to("listening") : s;
    case "replyStarted":
    case "speakQueued":
      return p === "thinking" || p === "speaking" ? to("speaking") : s;
    case "speakIdle":
      return p === "speaking" ? to("listening") : s;
    case "turnDone":
      if (p !== "thinking" && p !== "speaking") return s;
      return e.hasAudio ? to("speaking") : to("listening");
    case "interrupt":
      return p === "speaking" || p === "thinking" ? to("listening") : s;
    case "announce":
      return p === "listening" ? to("speaking") : s;
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

export function createSpeechQueue(deps: {
  speak: (text: string, signal: AbortSignal) => Promise<void>;
}): {
  enqueue(sentence: string): void;
  stop(): void;
  idle(): boolean;
  onIdle(cb: () => void): void;
} {
  let pending: string[] = [];
  let running = false;
  let controller: AbortController | null = null;
  let generation = 0;
  let idleCb: (() => void) | null = null;

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    const gen = generation;
    while (pending.length > 0 && gen === generation) {
      const text = pending.shift() as string;
      const ctl = new AbortController();
      controller = ctl;
      try {
        await deps.speak(text, ctl.signal);
      } catch {
        // una frase fallida no detiene las siguientes
      }
      if (controller === ctl) controller = null;
    }
    if (gen === generation) {
      running = false;
      idleCb?.();
    }
  }

  return {
    enqueue(sentence) {
      pending.push(sentence);
      void pump();
    },
    stop() {
      generation++;
      pending = [];
      controller?.abort();
      controller = null;
      running = false;
    },
    idle: () => !running && pending.length === 0,
    onIdle(cb) {
      idleCb = cb;
    },
  };
}
