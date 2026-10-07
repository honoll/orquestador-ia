import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgySession, createLineSplitter, type AgyProc } from "../../src/voice/assistant/agy-session.js";

const CONV = "c-1";
const init = JSON.stringify({ event: "init", conversation_id: CONV, init: { model: "gemini-3.8-flash-low" } });
const userStep = JSON.stringify({ event: "step_update", step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "user_input" } });
const delta = (t: string) =>
  JSON.stringify({ event: "step_update", step_update: { conversation_id: CONV, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: t } });
const ok = (response: string) =>
  JSON.stringify({
    event: "result",
    result: { conversation_id: CONV, status: "SUCCESS", response, duration_seconds: 2.18, num_turns: 1, usage: { input_tokens: 11636, output_tokens: 29, total_tokens: 11665 } },
  });
const err = (error: string) => JSON.stringify({ event: "result", result: { status: "ERROR", response: "", error } });

class FakeProc implements AgyProc {
  written: string[] = [];
  lineCb: (l: string) => void = () => {};
  exitCb: (c: number | null) => void = () => {};
  killed = 0;
  ended = 0;
  stdin = {
    write: (s: string) => {
      this.written.push(s);
    },
    end: () => {
      this.ended++;
    },
  };
  onLine(cb: (l: string) => void) {
    this.lineCb = cb;
  }
  onExit(cb: (c: number | null) => void) {
    this.exitCb = cb;
  }
  kill() {
    this.killed++;
  }
  emit(...lines: string[]) {
    for (const l of lines) this.lineCb(l);
  }
}

function setup(extra: { turnTimeoutMs?: number } = {}) {
  const procs: FakeProc[] = [];
  const spawn = vi.fn(() => {
    const p = new FakeProc();
    procs.push(p);
    return p;
  });
  const session = createAgySession({ spawn, now: () => Date.parse("2026-10-06T12:00:00Z"), ...extra });
  return { procs, spawn, session };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("createAgySession", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("no lanza el proceso hasta el primer send", () => {
    const { spawn, session } = setup();
    expect(spawn).not.toHaveBeenCalled();
    expect(session.alive()).toBe(false);
  });

  it("dos turnos en el mismo proceso, con deltas en orden y tokens", async () => {
    const { procs, spawn, session } = setup();
    const d1: string[] = [];
    const p1 = session.send("Hola", (d) => d1.push(d));
    await tick();
    const proc = procs[0];
    expect(JSON.parse(proc.written[0])).toEqual({ event: "user", message: { content: "Hola" } });
    proc.emit(init, userStep, delta("El"), delta(" mar"), ok("El mar\n"));
    const r1 = await p1;
    expect(r1).toMatchObject({ ok: true, text: "El mar\n", quota: false, retryNotBefore: null, inputTokens: 11636, outputTokens: 29 });
    expect(d1).toEqual(["El", " mar"]);

    const d2: string[] = [];
    const p2 = session.send("Otra", (d) => d2.push(d));
    await tick();
    expect(proc.written).toHaveLength(2);
    proc.emit(delta("Si"), ok("Si"));
    expect((await p2).text).toBe("Si");
    expect(d2).toEqual(["Si"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(session.alive()).toBe(true);
  });

  it("usa los deltas unidos si el result no trae response", async () => {
    const { procs, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit(delta("a"), delta("b"), JSON.stringify({ event: "result", result: { status: "SUCCESS", usage: { input_tokens: 1, output_tokens: 2 } } }));
    expect((await p).text).toBe("ab");
  });

  it("error de cuota: quota true y retryNotBefore", async () => {
    const { procs, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit(err("RESOURCE_EXHAUSTED: quota exceeded, reset in 2h"));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.quota).toBe(true);
    expect(r.retryNotBefore).toBe("2026-10-06T14:00:00.000Z");
    expect(r.error).toContain("RESOURCE_EXHAUSTED");
  });

  it("error que no es de cuota", async () => {
    const { procs, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit(err("algo falló"));
    expect(await p).toMatchObject({ ok: false, quota: false, retryNotBefore: null, error: "algo falló" });
  });

  it("timeout: error, mata el proceso y el siguiente send relanza", async () => {
    const { procs, spawn, session } = setup({ turnTimeoutMs: 1000 });
    const p = session.send("x", () => {});
    await tick();
    vi.advanceTimersByTime(1000);
    const r = await p;
    expect(r).toMatchObject({ ok: false, error: "agy dejó de responder" });
    expect(procs[0].killed).toBe(1);
    expect(session.alive()).toBe(false);
    const p2 = session.send("y", () => {});
    await tick();
    expect(spawn).toHaveBeenCalledTimes(2);
    procs[1].emit(ok("listo"));
    expect((await p2).ok).toBe(true);
  });

  it("el proceso sale a media respuesta: error y relanza en el siguiente send", async () => {
    const { procs, spawn, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit(delta("par"));
    procs[0].exitCb(1);
    expect(await p).toMatchObject({ ok: false, error: "agy dejó de responder" });
    expect(session.alive()).toBe(false);
    const p2 = session.send("y", () => {});
    await tick();
    expect(spawn).toHaveBeenCalledTimes(2);
    procs[1].emit(ok("ok"));
    await p2;
  });

  it("serializa turnos concurrentes", async () => {
    const { procs, session } = setup();
    const pa = session.send("A", () => {});
    const pb = session.send("B", () => {});
    await tick();
    expect(procs[0].written).toHaveLength(1);
    procs[0].emit(ok("RA"));
    expect((await pa).text).toBe("RA");
    await tick();
    expect(procs[0].written).toHaveLength(2);
    expect(JSON.parse(procs[0].written[1]).message.content).toBe("B");
    procs[0].emit(ok("RB"));
    expect((await pb).text).toBe("RB");
  });

  it("ignora líneas no JSON o vacías", async () => {
    const { procs, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit("basura", "", "{roto", ok("fin"));
    expect((await p).text).toBe("fin");
  });

  it("sin agy devuelve agy no encontrado", async () => {
    const session = createAgySession({ spawn: () => null });
    expect(await session.send("x", () => {})).toMatchObject({ ok: false, error: "agy no encontrado", quota: false });
  });

  it("si spawn lanza, devuelve error sin lanzar", async () => {
    const session = createAgySession({
      spawn: () => {
        throw new Error("boom");
      },
    });
    const r = await session.send("x", () => {});
    expect(r.ok).toBe(false);
  });

  it("close cierra stdin y mata a los 2 s si sigue vivo", async () => {
    const { procs, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit(ok("a"));
    await p;
    session.close();
    expect(procs[0].ended).toBe(1);
    expect(procs[0].killed).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(procs[0].killed).toBe(1);
  });

  it("close no mata si el proceso ya salió", async () => {
    const { procs, session } = setup();
    const p = session.send("x", () => {});
    await tick();
    procs[0].emit(ok("a"));
    await p;
    session.close();
    procs[0].exitCb(0);
    vi.advanceTimersByTime(2000);
    expect(procs[0].killed).toBe(0);
  });
});

describe("createLineSplitter", () => {
  it("junta chunks partidos y entrega líneas completas", () => {
    const lines: string[] = [];
    const push = createLineSplitter((l) => lines.push(l));
    push('{"a":');
    push('1}\n{"b":2}\n{"c"');
    push(":3}\r\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});
