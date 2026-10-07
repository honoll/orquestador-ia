import { describe, it, expect } from "vitest";
import {
  initialConv,
  convReducer,
  CONV_IDLE_MS,
  createSpeechQueue,
  createMaxSpeechTimer,
  MAX_SPEECH_MS,
  type ConvState,
  type ConvEvent,
} from "../../ui/src/lib/conversation.js";

const on = { bargeIn: false };
const barge = { bargeIn: true };
const st = (phase: ConvState["phase"], extra: Partial<ConvState> = {}): ConvState => ({
  phase,
  micOpen: false,
  error: null,
  lastSpeechAt: 0,
  turnDone: false,
  queueIdle: true,
  ...extra,
});
const step = (s: ConvState, e: ConvEvent, now = 1, o = on) => convReducer(s, e, now, o);

describe("convReducer", () => {
  it("estado inicial", () => {
    expect(initialConv(5)).toEqual({
      phase: "starting",
      micOpen: false,
      error: null,
      lastSpeechAt: 5,
      turnDone: false,
      queueIdle: true,
    });
  });

  it("started -> listening con micrófono abierto", () => {
    const s = step(initialConv(0), { type: "started" });
    expect(s.phase).toBe("listening");
    expect(s.micOpen).toBe(true);
  });

  it("speechEnd en listening -> transcribing (mic cerrado)", () => {
    const s = step(st("listening", { micOpen: true }), { type: "speechEnd" }, 10);
    expect(s.phase).toBe("transcribing");
    expect(s.micOpen).toBe(false);
    expect(s.lastSpeechAt).toBe(10);
  });

  it("speechStart en listening actualiza lastSpeechAt", () => {
    const s = step(st("listening", { micOpen: true }), { type: "speechStart" }, 42);
    expect(s.phase).toBe("listening");
    expect(s.lastSpeechAt).toBe(42);
  });

  it("transcribed -> thinking; discarded -> listening", () => {
    expect(step(st("transcribing"), { type: "transcribed", text: "hola" }).phase).toBe("thinking");
    const d = step(st("transcribing"), { type: "discarded" });
    expect(d.phase).toBe("listening");
    expect(d.micOpen).toBe(true);
  });

  it("replyStarted / speakQueued -> speaking", () => {
    expect(step(st("thinking"), { type: "replyStarted" }).phase).toBe("speaking");
    expect(step(st("thinking"), { type: "speakQueued" }).phase).toBe("speaking");
    expect(step(st("speaking"), { type: "speakQueued" }).phase).toBe("speaking");
  });

  it("micOpen en speaking solo con bargeIn", () => {
    expect(step(st("thinking"), { type: "replyStarted" }, 1, on).micOpen).toBe(false);
    expect(step(st("thinking"), { type: "replyStarted" }, 1, barge).micOpen).toBe(true);
  });

  it("turnDone sin audio -> listening; con audio en cola sigue y speakIdle -> listening", () => {
    expect(step(st("thinking"), { type: "turnDone", hasAudio: false }).phase).toBe("listening");
    const q = step(st("thinking"), { type: "speakQueued" });
    expect(q.queueIdle).toBe(false);
    const a = step(q, { type: "turnDone", hasAudio: true });
    expect(a.phase).toBe("speaking");
    const b = step(a, { type: "speakIdle" });
    expect(b.phase).toBe("listening");
    expect(b.micOpen).toBe(true);
  });

  it("speakIdle antes de turnDone se queda en speaking; turnDone después -> listening", () => {
    let s = step(st("thinking"), { type: "speakQueued" });
    s = step(s, { type: "speakIdle" });
    expect(s.phase).toBe("speaking");
    expect(s.micOpen).toBe(false);
    s = step(s, { type: "turnDone", hasAudio: true });
    expect(s.phase).toBe("listening");
    expect(s.micOpen).toBe(true);
  });

  it("vaciado a mitad de respuesta: idle, queued, idle, turnDone -> listening", () => {
    let s = step(st("thinking"), { type: "speakQueued" });
    s = step(s, { type: "speakIdle" });
    s = step(s, { type: "speakQueued" });
    expect(s.phase).toBe("speaking");
    expect(s.queueIdle).toBe(false);
    s = step(s, { type: "speakIdle" });
    expect(s.phase).toBe("speaking");
    s = step(s, { type: "turnDone", hasAudio: true });
    expect(s.phase).toBe("listening");
  });

  it("transcribed reinicia las banderas del turno", () => {
    const s = step(st("transcribing", { turnDone: true, queueIdle: false }), { type: "transcribed", text: "x" });
    expect(s).toMatchObject({ phase: "thinking", turnDone: false, queueIdle: true });
  });

  it("entrar a listening reinicia el reloj de inactividad", () => {
    const s = step(st("speaking", { lastSpeechAt: 0, turnDone: true }), { type: "speakIdle" }, 99_000);
    expect(s.lastSpeechAt).toBe(99_000);
  });

  it("started -> announce -> speakIdle -> listening", () => {
    let s = step(initialConv(0), { type: "started" });
    s = step(s, { type: "announce" });
    expect(s.phase).toBe("speaking");
    s = step(s, { type: "speakIdle" });
    expect(s.phase).toBe("listening");
  });

  it("interrupt en thinking -> announce -> speakIdle -> listening", () => {
    let s = step(st("thinking"), { type: "interrupt" });
    expect(s.turnDone).toBe(true);
    s = step(s, { type: "announce" });
    s = step(s, { type: "speakIdle" });
    expect(s.phase).toBe("listening");
  });

  it("announce desde listening -> speaking", () => {
    expect(step(st("listening", { micOpen: true }), { type: "announce" }).phase).toBe("speaking");
  });

  it("interrupt en speaking/thinking -> listening", () => {
    expect(step(st("speaking"), { type: "interrupt" }).phase).toBe("listening");
    expect(step(st("thinking"), { type: "interrupt" }).phase).toBe("listening");
    expect(step(st("transcribing"), { type: "interrupt" }).phase).toBe("transcribing");
  });

  it("speechStart en speaking: interrumpe solo con bargeIn", () => {
    expect(step(st("speaking"), { type: "speechStart" }, 1, on).phase).toBe("speaking");
    expect(step(st("speaking"), { type: "speechStart" }, 1, barge).phase).toBe("listening");
  });

  it("idleTimeout solo tras CONV_IDLE_MS sin hablar", () => {
    expect(CONV_IDLE_MS).toBe(180_000);
    const s = st("listening", { micOpen: true, lastSpeechAt: 1000 });
    expect(step(s, { type: "idleTimeout" }, 1000 + CONV_IDLE_MS - 1).phase).toBe("listening");
    const e = step(s, { type: "idleTimeout" }, 1000 + CONV_IDLE_MS);
    expect(e.phase).toBe("ending");
    expect(e.micOpen).toBe(false);
  });

  it("end -> ending, ended -> ended", () => {
    expect(step(st("listening", { micOpen: true }), { type: "end" }).phase).toBe("ending");
    const e = step(st("ending"), { type: "ended" });
    expect(e.phase).toBe("ended");
    expect(e.micOpen).toBe(false);
  });

  it("fail -> error con mensaje y mic cerrado", () => {
    const s = step(st("listening", { micOpen: true }), { type: "fail", message: "sin mic" });
    expect(s).toMatchObject({ phase: "error", error: "sin mic", micOpen: false });
  });

  it("estados terminales ignoran eventos", () => {
    const e = st("ended");
    expect(step(e, { type: "speechStart" })).toEqual(e);
    const er = st("error", { error: "x" });
    expect(step(er, { type: "started" })).toEqual(er);
  });

  it("eventos fuera de fase se ignoran", () => {
    const s = st("thinking");
    expect(step(s, { type: "speechEnd" })).toEqual(s);
  });
});

function fakeSpeak() {
  const calls: { text: string; signal: AbortSignal; resolve: () => void }[] = [];
  const speak = (text: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      calls.push({ text, signal, resolve });
      signal.addEventListener("abort", () => resolve());
    });
  return { calls, speak };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSpeechQueue", () => {
  it("reproduce en orden, una a la vez, y llama onIdle al vaciarse", async () => {
    const f = fakeSpeak();
    const q = createSpeechQueue({ speak: f.speak });
    let idles = 0;
    q.onIdle(() => idles++);
    expect(q.idle()).toBe(true);
    q.enqueue("uno");
    q.enqueue("dos");
    await tick();
    expect(q.idle()).toBe(false);
    expect(f.calls.map((c) => c.text)).toEqual(["uno"]);
    f.calls[0].resolve();
    await tick();
    expect(f.calls.map((c) => c.text)).toEqual(["uno", "dos"]);
    expect(idles).toBe(0);
    f.calls[1].resolve();
    await tick();
    expect(idles).toBe(1);
    expect(q.idle()).toBe(true);
  });

  it("stop aborta la actual, vacía la cola y no llama onIdle", async () => {
    const f = fakeSpeak();
    const q = createSpeechQueue({ speak: f.speak });
    let idles = 0;
    q.onIdle(() => idles++);
    q.enqueue("uno");
    q.enqueue("dos");
    await tick();
    q.stop();
    await tick();
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(q.idle()).toBe(true);
    expect(idles).toBe(0);
  });

  it("sigue con la siguiente si speak falla", async () => {
    const calls: string[] = [];
    const q = createSpeechQueue({
      speak: async (t) => {
        calls.push(t);
        if (t === "a") throw new Error("boom");
      },
    });
    let idles = 0;
    q.onIdle(() => idles++);
    q.enqueue("a");
    q.enqueue("b");
    await tick();
    expect(calls).toEqual(["a", "b"]);
    expect(idles).toBe(1);
  });

  it("se puede encolar de nuevo tras stop", async () => {
    const f = fakeSpeak();
    const q = createSpeechQueue({ speak: f.speak });
    q.enqueue("uno");
    await tick();
    q.stop();
    await tick();
    q.enqueue("tres");
    await tick();
    expect(f.calls.map((c) => c.text)).toEqual(["uno", "tres"]);
    expect(f.calls[1].signal.aborted).toBe(false);
  });
});

describe("createSpeechQueue con prefetch", () => {
  function setup(maxAhead?: number) {
    const fetches: { text: string; signal: AbortSignal; resolve: (v: string) => void }[] = [];
    const plays: { item: string; signal: AbortSignal; resolve: () => void }[] = [];
    const q = createSpeechQueue<string>({
      fetch: (text, signal) =>
        new Promise<string>((resolve) => {
          fetches.push({ text, signal, resolve });
        }),
      play: (item, signal) =>
        new Promise<void>((resolve) => {
          plays.push({ item, signal, resolve });
          signal.addEventListener("abort", () => resolve());
        }),
      maxAhead,
    });
    return { q, fetches, plays };
  }

  it("pide la frase n+1 antes de que termine de sonar la n", async () => {
    const { q, fetches, plays } = setup();
    q.enqueue("uno");
    q.enqueue("dos");
    await tick();
    expect(fetches.map((f) => f.text)).toEqual(["uno", "dos"]);
    fetches[0].resolve("audio-uno");
    await tick();
    expect(plays.map((p) => p.item)).toEqual(["audio-uno"]);
    // dos ya se pidió y sigue sonando uno
    expect(fetches.map((f) => f.text)).toContain("dos");
    fetches[1].resolve("audio-dos");
    await tick();
    expect(plays).toHaveLength(1);
    plays[0].resolve();
    await tick();
    expect(plays.map((p) => p.item)).toEqual(["audio-uno", "audio-dos"]);
  });

  it("mantiene el orden aunque los pedidos terminen desordenados", async () => {
    const { q, fetches, plays } = setup();
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    await tick();
    fetches[1].resolve("B");
    await tick();
    expect(plays).toHaveLength(0);
    fetches[0].resolve("A");
    await tick();
    expect(plays.map((p) => p.item)).toEqual(["A"]);
    plays[0].resolve();
    await tick();
    expect(plays.map((p) => p.item)).toEqual(["A", "B"]);
    plays[1].resolve();
    await tick();
    fetches[2].resolve("C");
    await tick();
    expect(plays.map((p) => p.item)).toEqual(["A", "B", "C"]);
  });

  it("como mucho 2 pedidos en vuelo (el de la frase actual y 1 adelantado)", async () => {
    const { q, fetches } = setup();
    for (const t of ["1", "2", "3", "4"]) q.enqueue(t);
    await tick();
    expect(fetches.map((f) => f.text)).toEqual(["1", "2"]);
    fetches[0].resolve("A");
    await tick();
    // suena 1; solo 2 está adelantado
    expect(fetches.map((f) => f.text)).toEqual(["1", "2"]);
  });

  it("stop aborta todos los pedidos y la reproducción, y no reproduce nada más", async () => {
    const { q, fetches, plays } = setup();
    let idles = 0;
    q.onIdle(() => idles++);
    q.enqueue("a");
    q.enqueue("b");
    q.enqueue("c");
    await tick();
    fetches[0].resolve("A");
    await tick();
    expect(plays).toHaveLength(1);
    q.stop();
    await tick();
    expect(fetches.every((f) => f.signal.aborted)).toBe(true);
    expect(plays[0].signal.aborted).toBe(true);
    fetches[1].resolve("B");
    fetches[2]?.resolve("C");
    await tick();
    expect(plays).toHaveLength(1);
    expect(q.idle()).toBe(true);
    expect(idles).toBe(0);
  });

  it("un pedido fallido se salta y sigue con la siguiente", async () => {
    const played: string[] = [];
    const q = createSpeechQueue<string>({
      fetch: async (t) => {
        if (t === "mala") throw new Error("503");
        return t;
      },
      play: async (i) => {
        played.push(i);
      },
    });
    let idles = 0;
    q.onIdle(() => idles++);
    q.enqueue("mala");
    q.enqueue("buena");
    await tick();
    expect(played).toEqual(["buena"]);
    expect(idles).toBe(1);
  });
});

describe("createMaxSpeechTimer", () => {
  function fake() {
    const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
    return {
      timers,
      setTimer: (fn: () => void, ms: number) => {
        const t = { fn, ms, id: timers.length, live: true };
        timers.push(t);
        return t.id;
      },
      clearTimer: (h: unknown) => {
        timers[h as number].live = false;
      },
    };
  }
  it("vence a los 60 s si la frase no terminó", () => {
    const f = fake();
    let n = 0;
    const t = createMaxSpeechTimer({ onExpire: () => n++, ...f });
    t.start();
    expect(f.timers[0].ms).toBe(MAX_SPEECH_MS);
    expect(MAX_SPEECH_MS).toBe(60_000);
    expect(t.armed()).toBe(true);
    f.timers[0].fn();
    expect(n).toBe(1);
    expect(t.armed()).toBe(false);
  });
  it("cancel (speechEnd, misfire, interrupt) lo desarma", () => {
    const f = fake();
    const t = createMaxSpeechTimer({ onExpire: () => {}, ...f });
    t.start();
    t.cancel();
    expect(f.timers[0].live).toBe(false);
    expect(t.armed()).toBe(false);
  });
  it("un segundo start dentro de la frase no reinicia el reloj", () => {
    const f = fake();
    const t = createMaxSpeechTimer({ onExpire: () => {}, ...f });
    t.start();
    t.start();
    expect(f.timers).toHaveLength(1);
  });
});
