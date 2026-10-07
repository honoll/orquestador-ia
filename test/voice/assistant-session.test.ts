import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";

const { migrationDone } = await import("../../src/db/migrate.js");
const { db, schema } = await import("../../src/db/index.js");
const { broadcast, onBroadcast } = await import("../../src/server/ws.js");
const session = await import("../../src/voice/assistant/session.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");

type Res = {
  ok?: boolean; text?: string; error?: string; quota?: boolean; inputTokens?: number; outputTokens?: number;
};
const full = (r: Res) => ({
  ok: r.ok ?? true, text: r.text ?? "", ...(r.error ? { error: r.error } : {}), quota: r.quota ?? false,
  retryNotBefore: null, inputTokens: r.inputTokens ?? 10, outputTokens: r.outputTokens ?? 5, startedAt: 1,
});

function fakeAgyFactory(script: Res[] | ((msg: string, n: number) => Res)) {
  const sent: string[] = [];
  const made: { closed: boolean; sent: string[] }[] = [];
  const factory = () => {
    const mine = { closed: false, sent: [] as string[] };
    made.push(mine);
    return {
      send: async (text: string, onDelta: (d: string) => void) => {
        sent.push(text);
        mine.sent.push(text);
        const n = sent.length - 1;
        const r = typeof script === "function" ? script(text, n) : (script[n] ?? { text: "ok" });
        if (r.ok !== false && r.text) onDelta(r.text);
        return full(r);
      },
      alive: () => !mine.closed,
      close: () => {
        mine.closed = true;
      },
    };
  };
  return { factory, sent, made };
}

let events: any[] = [];
let off: () => void;
const types = (t: string) => events.filter((e) => e.type === t);
const waitFor = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 5));
  }
};

beforeAll(async () => {
  await migrationDone;
});

beforeEach(async () => {
  events = [];
  off = onBroadcast((e) => events.push(e));
  await db.delete(schema.agyUsage);
  await db.delete(schema.runs);
  await db.delete(schema.tasks);
  await db.delete(schema.agyAccounts);
  await db.delete(schema.projects);
  await createAccount("cuenta-test");
  await db.insert(schema.projects).values({ id: "p1", name: "Orquestador-IA", path: "C:/x/orq" });
});

afterEach(async () => {
  session.shutdownAssistant();
  off();
  vi.useRealTimers();
  // Deja terminar escrituras en segundo plano (calentamiento) antes de limpiar tablas.
  await new Promise((r) => setTimeout(r, 40));
});

const turnDone = (turnId: string) => waitFor(() => types("voice:assistant:turn-done").some((e) => e.turnId === turnId));
async function say(sid: string, text: string) {
  const r = await session.assistantTurn(sid, text);
  if ("error" in r) throw new Error(r.error);
  await turnDone(r.turnId);
  return types("voice:assistant:turn-done").find((e) => e.turnId === r.turnId);
}

function setup(over: { script?: Res[] | ((msg: string, n: number) => Res); [k: string]: any } = {}) {
  const agy = fakeAgyFactory(over.script ?? [{ text: "Listo." }]);
  const createPlan = vi.fn(async () => ({ id: "plan-1" }));
  const startPlan = vi.fn(async () => "started" as const);
  const retrieve = vi.fn(async () => ({ notes: [], source: "none" as const }));
  const writeNote = vi.fn((..._a: unknown[]) => "Orquestador/Platicas/nota.md");
  const deps = { agy: agy.factory, createPlan, startPlan, retrieve, writeNote, ...over } as any;
  delete deps.script;
  return { agy, createPlan, startPlan, retrieve, writeNote, deps };
}

describe("startAssistant", () => {
  it("sin cuenta activa: error 409", async () => {
    await db.delete(schema.agyAccounts);
    const { deps } = setup();
    await expect(session.startAssistant({ projectId: null }, deps)).rejects.toMatchObject({ status: 409 });
    expect(session.activeAssistant()).toBeNull();
  });

  it("calentamiento con proyectos, sin emitir ni guardar; registra uso 'voice'", async () => {
    const { deps, agy } = setup();
    const { sessionId, conversationId } = await session.startAssistant({ projectId: "p1" }, deps);
    expect(session.activeAssistant()).toEqual({ sessionId, conversationId });
    await waitFor(() => agy.sent.length === 1);
    expect(agy.sent[0]).toContain("Orquestador-IA");
    expect(agy.sent[0].endsWith("\n\nResponde solo: Listo.")).toBe(true);
    await waitFor(() => types("accounts:changed").length > 0);
    const usage = await db.select().from(schema.agyUsage);
    expect(usage[0].source).toBe("voice");
    expect(types("voice:assistant:delta")).toHaveLength(0);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
  });

  it("una sesión nueva cierra la previa", async () => {
    const { deps, agy } = setup();
    const a = await session.startAssistant({ projectId: null }, deps);
    const b = await session.startAssistant({ projectId: null }, deps);
    expect(b.sessionId).not.toBe(a.sessionId);
    expect(types("voice:assistant:ended").some((e) => e.sessionId === a.sessionId && e.reason === "user")).toBe(true);
    expect(agy.made[0].closed).toBe(true);
  });
});

describe("assistantTurn", () => {
  it("turno normal: deltas, turn-done, task + run guardados", async () => {
    const { deps } = setup({ script: [{ text: "Listo." }, { text: "Hola Alejandro." }] });
    const { sessionId, conversationId } = await session.startAssistant({ projectId: "p1" }, deps);
    const done = await say(sessionId, "Hola");
    expect(done).toMatchObject({ sessionId, speech: "Hola Alejandro.", hasAction: false });
    expect(types("voice:assistant:delta")[0]).toMatchObject({ sessionId, delta: "Hola Alejandro." });
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.conversationId, conversationId));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ adapter: "agy", prompt: "Hola", title: "Hola", status: "succeeded", projectId: "p1" });
    const runs = await db.select().from(schema.runs).where(eq(schema.runs.taskId, tasks[0].id));
    expect(runs[0]).toMatchObject({ status: "succeeded", summary: "Hola Alejandro.", result: "Hola Alejandro." });
    expect(runs[0].finishedAt).toBeTruthy();
    expect(types("run:status").length).toBeGreaterThan(0);
  });

  it("turno concurrente: 409", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = {
      send: async (_t: string, _d: (s: string) => void) => {
        await gate;
        return full({ text: "x" });
      },
      alive: () => true,
      close: () => {},
    };
    const { deps } = setup({ agy: () => slow as any });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const first = await session.assistantTurn(sessionId, "uno");
    expect("turnId" in first).toBe(true);
    const second = await session.assistantTurn(sessionId, "dos");
    expect(second).toMatchObject({ status: 409 });
    release();
  });

  it("sesión desconocida: 404", async () => {
    expect(await session.assistantTurn("nope", "hola")).toMatchObject({ status: 404 });
  });

  it("memoria solo si es semantic y hay notas", async () => {
    const note = { path: "a.md", title: "A", score: 0.7, excerpt: "dato útil", isProject: false, generated: false };
    const retrieve = vi.fn(async () => ({ notes: [note], source: "semantic" as const })) as any;
    const { deps, agy } = setup({ retrieve });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "qué sabes de A");
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ query: "qué sabes de A", topNotes: 3, budgetChars: 6000 }));
    expect(agy.sent[1]).toContain("dato útil");

    const retrieve2 = vi.fn(async () => ({ notes: [note], source: "project-only" as const })) as any;
    const s2 = setup({ retrieve: retrieve2 });
    const b = await session.startAssistant({ projectId: null }, s2.deps);
    await say(b.sessionId, "otra cosa");
    expect(s2.agy.sent[1]).toBe("otra cosa");
  });

  it("la memoria que falla o tarda no bloquea el turno", async () => {
    const retrieve = vi.fn(async () => {
      throw new Error("boom");
    }) as any;
    const { deps, agy } = setup({ retrieve });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "hola");
    expect(d.speech).toBeTruthy();
    expect(agy.sent[1]).toBe("hola");
  });

  it("acción propuesta; 'sí, dale' crea el plan con el pedido y lo arranca tras plan:ready", async () => {
    const reply = 'Puedo revisarlo. ¿Lo arranco? <<<ACCION plan {"pedido":"Revisa el login","proyecto":"orquestador-ia"}>>>';
    const { deps, createPlan, startPlan, agy } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "no debería usarse" }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d1 = await say(sessionId, "revisa el login");
    expect(d1.hasAction).toBe(true);
    expect(d1.speech).not.toContain("<<<");

    const r = await session.assistantTurn(sessionId, "sí, dale");
    if ("error" in r) throw new Error(r.error);
    await waitFor(() => createPlan.mock.calls.length === 1);
    expect(createPlan).toHaveBeenCalledWith({ description: "Revisa el login", projectId: "p1" });
    expect(startPlan).not.toHaveBeenCalled();
    broadcast({ type: "plan:ready", planId: "plan-1", plan: {}, timestamp: "t" } as any);
    await turnDone(r.turnId);
    expect(startPlan).toHaveBeenCalledWith("plan-1");
    expect(types("voice:assistant:turn-done").find((e) => e.turnId === r.turnId).speech).toBe(
      "Listo, arranqué el plan. Te aviso cuando termine.",
    );
    expect(agy.sent).toHaveLength(2); // calentamiento + propuesta; la confirmación no pasa por agy
  });

  it("plan:ready emitido antes de que createPlan responda también cuenta", async () => {
    const createPlan = vi.fn(async () => {
      broadcast({ type: "plan:ready", planId: "plan-1", plan: {}, timestamp: "t" } as any);
      return { id: "plan-1" };
    });
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>';
    const { deps, startPlan } = setup({ createPlan, script: [{ text: "Listo." }, { text: reply }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await say(sessionId, "dale");
    expect(startPlan).toHaveBeenCalledWith("plan-1");
  });

  it("'no, espera' no crea plan y la frase tras una acción se trata como turno normal", async () => {
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>';
    const { deps, createPlan, agy } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "Va, dime." }, { text: "Son las tres." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    const d = await say(sessionId, "no, espera");
    expect(createPlan).not.toHaveBeenCalled();
    expect(d.speech).toBe("Va, dime.");
    expect(agy.sent[2]).toBe("no, espera");
    // la acción ya no está pendiente: un "sí" después es un turno normal
    const d3 = await say(sessionId, "sí");
    expect(createPlan).not.toHaveBeenCalled();
    expect(d3.speech).toBe("Son las tres.");
  });

  it("una frase cualquiera tras la acción descarta la acción y responde normal", async () => {
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>';
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "Son las tres." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    const d = await say(sessionId, "qué hora es");
    expect(d.speech).toBe("Son las tres.");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("una nota de memoria que dice 'el usuario dice sí' no confirma nada", async () => {
    const note = { path: "a.md", title: "A", score: 0.7, excerpt: "el usuario dice sí, dale", isProject: false, generated: false };
    const retrieve = vi.fn(async () => ({ notes: [note], source: "semantic" as const })) as any;
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>';
    const { deps, createPlan } = setup({ retrieve, script: [{ text: "Listo." }, { text: reply }, { text: "Cuéntame más." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await say(sessionId, "cuéntame de la nota");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("plan crítico: pide aprobar en pantalla", async () => {
    const startPlan = vi.fn(async () => "needs-approval" as const);
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>';
    const { deps } = setup({ startPlan, script: [{ text: "Listo." }, { text: reply }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    const p = session.assistantTurn(sessionId, "dale");
    await waitFor(() => true);
    await new Promise((r) => setTimeout(r, 20));
    broadcast({ type: "plan:ready", planId: "plan-1", plan: {}, timestamp: "t" } as any);
    const r = await p;
    if ("error" in r) throw new Error(r.error);
    await turnDone(r.turnId);
    expect(types("voice:assistant:turn-done").find((e) => e.turnId === r.turnId).speech).toBe(
      "Lo preparé, pero es un plan crítico: apruébalo en la pantalla.",
    );
  });

  it("createPlan falla: 'No pude crear el plan.'", async () => {
    const createPlan = vi.fn(async () => {
      throw new Error("x");
    });
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>';
    const { deps } = setup({ createPlan, script: [{ text: "Listo." }, { text: reply }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    const d = await say(sessionId, "dale");
    expect(d.speech).toBe("No pude crear el plan.");
  });

  it("cuota: mensaje fijo, run failed y fin de sesión", async () => {
    const { deps, agy } = setup({ script: [{ text: "Listo." }, { ok: false, quota: true, error: "quota exhausted" }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "hola");
    expect(d.speech).toBe("Se acabó la cuota de esta cuenta de Antigravity; cámbiala en el panel.");
    await waitFor(() => types("voice:assistant:ended").length > 0);
    expect(types("voice:assistant:ended")[0]).toMatchObject({ reason: "error" });
    expect(agy.made[0].closed).toBe(true);
    const runs = await db.select().from(schema.runs);
    expect(runs[0].status).toBe("failed");
    const acc = (await db.select().from(schema.agyAccounts))[0];
    expect(acc.quotaBlockedUntil).toBeTruthy();
  });

  it("error no-cuota: reintenta con agy nuevo y prefijo; si falla otra vez, mensaje y fin", async () => {
    const { deps, agy } = setup({
      script: (msg, n) => (n === 0 ? { text: "Listo." } : n === 1 ? { text: "Primera." } : { ok: false, error: "se cayó" }),
    });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "primero");
    const d = await say(sessionId, "segundo");
    expect(d.speech).toBe("Perdí la conexión con Antigravity.");
    expect(agy.made.length).toBe(2);
    expect(agy.made[0].closed).toBe(true);
    const retryMsg = agy.made[1].sent[0];
    expect(retryMsg).toContain("primero");
    expect(retryMsg).toContain("Primera.");
    expect(retryMsg).toContain("segundo");
    await waitFor(() => types("voice:assistant:ended").length > 0);
  });

  it("error no-cuota con reintento exitoso responde normal", async () => {
    let calls = 0;
    const { deps } = setup({
      script: (_m, _n) => {
        calls++;
        return calls === 2 ? { ok: false, error: "x" } : { text: calls === 1 ? "Listo." : "Ya sí." };
      },
    });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "hola");
    expect(d.speech).toBe("Ya sí.");
    expect(d.error).toBeUndefined();
    expect(types("voice:assistant:ended")).toHaveLength(0);
  });

  it("frase de cierre: responde y termina", async () => {
    const { deps, agy } = setup();
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "ya gracias");
    expect(d.speech).toBe("¡Hasta luego!");
    await waitFor(() => types("voice:assistant:ended").length > 0);
    expect(types("voice:assistant:ended")[0]).toMatchObject({ reason: "phrase" });
    expect(agy.made[0].closed).toBe(true);
    expect(session.activeAssistant()).toBeNull();
  });
});

describe("anuncios de planes", () => {
  async function withPlan(script: Res[] = [{ text: "Listo." }, { text: '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":null}>>>' }]) {
    const { deps, ...rest } = setup({ script });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    const p = session.assistantTurn(sessionId, "dale");
    await new Promise((r) => setTimeout(r, 20));
    broadcast({ type: "plan:ready", planId: "plan-1", plan: {}, timestamp: "t" } as any);
    const r = await p;
    if ("error" in r) throw new Error(r.error);
    await turnDone(r.turnId);
    return { sessionId, ...rest };
  }

  it("completado: lee el resumen de la síntesis", async () => {
    const { sessionId } = await withPlan();
    broadcast({ type: "plan:synthesis", planId: "plan-1", status: "succeeded", synthesis: "Todo quedó bien. Se cambió el login. Hay tres archivos.", timestamp: "t" } as any);
    broadcast({ type: "plan:done", planId: "plan-1", status: "completed", timestamp: "t" } as any);
    const a = types("voice:assistant:announce");
    expect(a).toHaveLength(1);
    expect(a[0].sessionId).toBe(sessionId);
    expect(a[0].text.startsWith("El plan terminó: Todo quedó bien.")).toBe(true);
  });

  it("pausado y fallido", async () => {
    await withPlan();
    broadcast({ type: "plan:done", planId: "plan-1", status: "pending", paused: "quota", timestamp: "t" } as any);
    broadcast({ type: "plan:done", planId: "plan-1", status: "pending", paused: "budget", timestamp: "t" } as any);
    broadcast({ type: "plan:done", planId: "plan-1", status: "pending", paused: "guard", timestamp: "t" } as any);
    broadcast({ type: "plan:done", planId: "plan-1", status: "failed", timestamp: "t" } as any);
    expect(types("voice:assistant:announce").map((e) => e.text)).toEqual([
      "El plan se pausó por cuota; revísalo en la pantalla.",
      "El plan se pausó por presupuesto; revísalo en la pantalla.",
      "El plan se pausó por guardia; revísalo en la pantalla.",
      "El plan falló; revísalo en la pantalla.",
    ]);
  });

  it("ignora planes que no son de la sesión", async () => {
    await withPlan();
    broadcast({ type: "plan:done", planId: "otro", status: "failed", timestamp: "t" } as any);
    expect(types("voice:assistant:announce")).toHaveLength(0);
  });
});

describe("endAssistant y nota", () => {
  it("con 1 turno no escribe nota; con 2 sí (con resumen de agy y planes)", async () => {
    const one = setup();
    const a = await session.startAssistant({ projectId: null }, one.deps);
    await say(a.sessionId, "hola");
    expect(await session.endAssistant(a.sessionId, "user")).toEqual({ notePath: null });
    expect(one.writeNote).not.toHaveBeenCalled();

    const two = setup({ script: [{ text: "Listo." }, { text: "Uno." }, { text: "Dos." }, { text: "Hablamos de dos cosas." }] });
    const b = await session.startAssistant({ projectId: "p1" }, two.deps);
    await say(b.sessionId, "primero");
    await say(b.sessionId, "segundo");
    const r = await session.endAssistant(b.sessionId, "user");
    expect(r).toEqual({ notePath: "Orquestador/Platicas/nota.md" });
    const [vault, dir, input] = two.writeNote.mock.calls[0] as any[];
    expect(typeof vault).toBe("string");
    expect(dir).toBe("Orquestador/Platicas");
    expect(input.summary).toBe("Hablamos de dos cosas.");
    expect(input.turns).toEqual([{ user: "primero", assistant: "Uno." }, { user: "segundo", assistant: "Dos." }]);
    expect(input.projectName).toBe("Orquestador-IA");
    expect(two.agy.sent[3]).toContain("Resume esta plática en 3 a 5 oraciones");
    expect(types("voice:assistant:ended").at(-1)).toMatchObject({ reason: "user", notePath: "Orquestador/Platicas/nota.md" });
    expect(two.agy.made[0].closed).toBe(true);
  });

  it("si agy falla al resumir, usa las primeras frases del usuario; si writeNote lanza, notePath null", async () => {
    const writeNote = vi.fn((..._a: unknown[]): string => {
      throw new Error("disco");
    });
    const { deps } = setup({ writeNote, script: (_m, n) => (n >= 3 ? { ok: false, error: "x" } : { text: "R." }) });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "primero");
    await say(sessionId, "segundo");
    const r = await session.endAssistant(sessionId, "user");
    expect(r).toEqual({ notePath: null });
    const input = writeNote.mock.calls[0][2] as any;
    expect(input.summary).toContain("primero");
    expect(input.summary).toContain("segundo");
    expect(types("voice:assistant:ended").at(-1)).toMatchObject({ notePath: null });
  });

  it("es idempotente", async () => {
    const { deps } = setup();
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await session.endAssistant(sessionId, "user");
    expect(await session.endAssistant(sessionId, "user")).toEqual({ notePath: null });
    expect(types("voice:assistant:ended")).toHaveLength(1);
  });

  it("inactividad de 10 min termina la sesión", async () => {
    vi.useFakeTimers();
    const { deps } = setup();
    await session.startAssistant({ projectId: null }, deps);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 10);
    expect(types("voice:assistant:ended")[0]).toMatchObject({ reason: "idle" });
    expect(session.activeAssistant()).toBeNull();
  });
});
