import { describe, it, expect } from "vitest";
import {
  initialConv,
  convReducer,
  CONV_IDLE_MS,
  createSpeechQueue,
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
  ...extra,
});
const step = (s: ConvState, e: ConvEvent, now = 1, o = on) => convReducer(s, e, now, o);

describe("convReducer", () => {
  it("estado inicial", () => {
    expect(initialConv(5)).toEqual({ phase: "starting", micOpen: false, error: null, lastSpeechAt: 5 });
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

  it("turnDone sin audio -> listening; con audio sigue y speakIdle -> listening", () => {
    expect(step(st("thinking"), { type: "turnDone", hasAudio: false }).phase).toBe("listening");
    const a = step(st("thinking"), { type: "turnDone", hasAudio: true });
    expect(a.phase).toBe("speaking");
    const b = step(a, { type: "speakIdle" });
    expect(b.phase).toBe("listening");
    expect(b.micOpen).toBe(true);
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
