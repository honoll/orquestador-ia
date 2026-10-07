import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { WsEvent } from "../../src/lib/types.js";
import type { AssistantDeps } from "../../src/voice/assistant/session.js";
import type { TalkNoteInput } from "../../src/memory/talk-note.js";

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

type Ev = {
  type: string; sessionId?: string; turnId?: string; speech: string; text: string; delta?: string; reason?: string;
  notePath?: string | null; hasAction?: boolean; error?: string; pedido?: string; planId?: string; needsApproval?: boolean;
};
type Deps = AssistantDeps;
type NoteFn = (vault: string, dir: string, input: TalkNoteInput) => string;
const bc = (e: Record<string, unknown>) => broadcast(e as unknown as WsEvent);

let events: Ev[] = [];
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
  off = onBroadcast((e) => events.push(e as unknown as Ev));
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
  return doneOf(r.turnId);
}
function doneOf(turnId: string): Ev {
  const d = types("voice:assistant:turn-done").find((e) => e.turnId === turnId);
  if (!d) throw new Error("sin turn-done");
  return d;
}

type Over = Omit<Partial<Deps>, "writeNote"> & {
  script?: Res[] | ((msg: string, n: number) => Res);
  writeNote?: ReturnType<typeof vi.fn<NoteFn>>;
};
function setup(over: Over = {}) {
  const { script, ...rest } = over;
  const agy = fakeAgyFactory(script ?? [{ text: "Listo." }]);
  const createPlan = vi.fn(async (_i: { description: string; projectId?: string | null }) => ({ id: "plan-1" }));
  const startPlan = vi.fn(async (_id: string, _o?: { requireJev?: boolean }) => "started" as Awaited<ReturnType<NonNullable<Deps["startPlan"]>>>);
  const retrieve = vi.fn(async () => ({ notes: [], source: "none" as const }));
  const writeNote = rest.writeNote ?? vi.fn<NoteFn>(() => "Orquestador/Platicas/nota.md");
  const deps = { agy: agy.factory, createPlan, startPlan, retrieve, ...rest, writeNote } as unknown as Deps;
  return { agy, createPlan, startPlan, retrieve, writeNote, deps };
}
const asRetrieve = (f: unknown) => f as Deps["retrieve"];

const PROPOSE = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":"Orquestador-IA"}>>>';
const announces = () => types("voice:assistant:announce").map((e) => e.text);
const confirm = async (sid: string) => {
  const t0 = types("voice:assistant:turn-done").length;
  const r = await session.assistantTurn(sid, "dale");
  if ("error" in r) throw new Error(r.error);
  await turnDone(r.turnId);
  expect(types("voice:assistant:turn-done").length).toBe(t0 + 1);
  return doneOf(r.turnId);
};
const ready = () => bc({ type: "plan:ready", planId: "plan-1", plan: {}, timestamp: "t" });

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
    const { deps } = setup({ agy: () => slow });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const first = await session.assistantTurn(sessionId, "uno");
    expect("turnId" in first).toBe(true);
    const second = await session.assistantTurn(sessionId, "dos");
    expect(second).toMatchObject({ status: 409 });
    release();
    if ("turnId" in first) await turnDone(first.turnId);
  });

  it("sesión desconocida: 404", async () => {
    expect(await session.assistantTurn("nope", "hola")).toMatchObject({ status: 404 });
  });

  it("memoria solo si es semantic y hay notas", async () => {
    const note = { path: "a.md", title: "A", score: 0.7, excerpt: "dato útil", isProject: false, generated: false };
    const retrieve = vi.fn(async () => ({ notes: [note], source: "semantic" as const }));
    const { deps, agy } = setup({ retrieve: asRetrieve(retrieve) });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "qué sabes de A");
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ query: "qué sabes de A", topNotes: 3, budgetChars: 6000 }));
    expect(agy.sent[1]).toContain("dato útil");

    const retrieve2 = vi.fn(async () => ({ notes: [note], source: "project-only" as const }));
    const s2 = setup({ retrieve: asRetrieve(retrieve2) });
    const b = await session.startAssistant({ projectId: null }, s2.deps);
    await say(b.sessionId, "otra cosa");
    expect(s2.agy.sent[1]).toBe("otra cosa");
  });

  it("la memoria que falla o tarda no bloquea el turno", async () => {
    const retrieve = vi.fn(async () => {
      throw new Error("boom");
    });
    const { deps, agy } = setup({ retrieve: asRetrieve(retrieve) });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "hola");
    expect(d.speech).toBeTruthy();
    expect(agy.sent[1]).toBe("hola");
  });

  it("acción propuesta; 'sí, dale' responde al instante y arranca el plan al llegar plan:ready", async () => {
    const reply = 'Puedo revisarlo. ¿Lo arranco? <<<ACCION plan {"pedido":"Revisa el login","proyecto":"orquestador-ia"}>>>';
    const { deps, createPlan, startPlan, agy } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "no debería usarse" }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d1 = await say(sessionId, "revisa el login");
    expect(d1.hasAction).toBe(true);
    expect(d1.speech).not.toContain("<<<");

    const d2 = await confirm(sessionId); // no espera a plan:ready
    expect(d2.speech).toBe("Va, lo estoy preparando; te aviso cuando arranque.");
    await waitFor(() => createPlan.mock.calls.length === 1);
    expect(createPlan).toHaveBeenCalledWith({ description: "Revisa el login", projectId: "p1" });
    expect(startPlan).not.toHaveBeenCalled();
    // el turno ya terminó: se puede seguir hablando (no hay 409)
    const d3 = await say(sessionId, "qué hora es");
    expect(d3.speech).toBe("no debería usarse");
    ready();
    await waitFor(() => announces().length > 0);
    expect(startPlan).toHaveBeenCalledWith("plan-1", { requireJev: true });
    expect(announces()).toEqual(["Listo, arranqué el plan. Te aviso cuando termine."]);
    expect(agy.sent).toHaveLength(3); // calentamiento + propuesta + "qué hora es"; la confirmación no pasa por agy
  });

  it("plan:ready emitido antes de que createPlan responda también cuenta", async () => {
    const createPlan = vi.fn(async () => {
      ready();
      return { id: "plan-1" };
    });
    const { deps, startPlan } = setup({ createPlan, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await waitFor(() => announces().length > 0);
    expect(startPlan).toHaveBeenCalledWith("plan-1", { requireJev: true });
  });

  it("'no, espera' no crea plan y la frase tras una acción se trata como turno normal", async () => {
    const reply = PROPOSE;
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
    const reply = PROPOSE;
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "Son las tres." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    const d = await say(sessionId, "qué hora es");
    expect(d.speech).toBe("Son las tres.");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("una nota de memoria que dice 'el usuario dice sí' no confirma nada", async () => {
    const note = { path: "a.md", title: "A", score: 0.7, excerpt: "el usuario dice sí, dale", isProject: false, generated: false };
    const retrieve = vi.fn(async () => ({ notes: [note], source: "semantic" as const }));
    const reply = PROPOSE;
    const { deps, createPlan } = setup({ retrieve: asRetrieve(retrieve), script: [{ text: "Listo." }, { text: reply }, { text: "Cuéntame más." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await say(sessionId, "cuéntame de la nota");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("plan crítico: anuncia que se apruebe en pantalla", async () => {
    const startPlan = vi.fn(async () => "needs-approval" as const);
    const { deps } = setup({ startPlan, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await waitFor(() => types("voice:assistant:turn-done").length === 2);
    await new Promise((r) => setTimeout(r, 20));
    ready();
    await waitFor(() => announces().length > 0);
    expect(announces()).toEqual(["Lo preparé, pero es un plan crítico: apruébalo en la pantalla."]);
  });

  it("createPlan falla: anuncia 'No pude crear el plan.'", async () => {
    const createPlan = vi.fn(async () => {
      throw new Error("x");
    });
    const { deps, startPlan } = setup({ createPlan, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await waitFor(() => announces().length > 0);
    expect(announces()).toEqual(["No pude crear el plan."]);
    expect(startPlan).not.toHaveBeenCalled();
  });

  it("plan:error o vencimiento de plan:ready: 'No pude crear el plan.' sin arrancar nada", async () => {
    const a = setup({ script: [{ text: "Listo." }, { text: PROPOSE }] });
    const s1 = await session.startAssistant({ projectId: null }, a.deps);
    await say(s1.sessionId, "haz X");
    await confirm(s1.sessionId);
    await new Promise((r) => setTimeout(r, 20));
    bc({ type: "plan:error", planId: "plan-1", error: "x", timestamp: "t" });
    await waitFor(() => announces().length > 0);
    expect(announces()).toEqual(["No pude crear el plan."]);
    expect(a.startPlan).not.toHaveBeenCalled();

    events.length = 0;
    const b = setup({ planReadyTimeoutMs: 30, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const s2 = await session.startAssistant({ projectId: null }, b.deps);
    await say(s2.sessionId, "haz X");
    await confirm(s2.sessionId);
    await waitFor(() => announces().length > 0);
    expect(announces()).toEqual(["No pude crear el plan."]);
    expect(b.startPlan).not.toHaveBeenCalled();
  });

  it("sesión terminada mientras se prepara: el plan se arranca igual pero no se anuncia", async () => {
    const { deps, startPlan } = setup({ script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await session.endAssistant(sessionId, "user");
    ready();
    await waitFor(() => startPlan.mock.calls.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(startPlan).toHaveBeenCalledWith("plan-1", { requireJev: true });
    expect(announces()).toEqual([]);
  });

  it("la espera de plan:ready no deja oyentes tras ready/timeout", async () => {
    const { deps } = setup({ planReadyTimeoutMs: 20, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await waitFor(() => announces().length > 0);
    await session.endAssistant(sessionId, "user");
    // tras terminar no queda ningún oyente de la sesión: ready ya no provoca nada
    const startPlan2 = deps.startPlan as ReturnType<typeof vi.fn>;
    ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(startPlan2).not.toHaveBeenCalled();
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
  async function withPlan(script: Res[] = [{ text: "Listo." }, { text: PROPOSE }]) {
    const { deps, ...rest } = setup({ script });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    ready();
    await waitFor(() => announces().length > 0);
    events.length = 0; // descarta el anuncio de arranque
    return { sessionId, ...rest };
  }

  it("completado: lee el resumen de la síntesis", async () => {
    const { sessionId } = await withPlan();
    bc({ type: "plan:synthesis", planId: "plan-1", status: "succeeded", synthesis: "Todo quedó bien. Se cambió el login. Hay tres archivos.", timestamp: "t" });
    bc({ type: "plan:done", planId: "plan-1", status: "completed", timestamp: "t" });
    const a = types("voice:assistant:announce");
    expect(a).toHaveLength(1);
    expect(a[0].sessionId).toBe(sessionId);
    expect(a[0].text.startsWith("El plan terminó: Todo quedó bien.")).toBe(true);
  });

  it("pausado y fallido", async () => {
    await withPlan();
    bc({ type: "plan:done", planId: "plan-1", status: "pending", paused: "quota", timestamp: "t" });
    bc({ type: "plan:done", planId: "plan-1", status: "pending", paused: "budget", timestamp: "t" });
    bc({ type: "plan:done", planId: "plan-1", status: "pending", paused: "guard", timestamp: "t" });
    bc({ type: "plan:done", planId: "plan-1", status: "failed", timestamp: "t" });
    expect(types("voice:assistant:announce").map((e) => e.text)).toEqual([
      "El plan se pausó por cuota; revísalo en la pantalla.",
      "El plan se pausó por presupuesto; revísalo en la pantalla.",
      "El plan se pausó por guardia; revísalo en la pantalla.",
      "El plan falló; revísalo en la pantalla.",
    ]);
  });

  it("ignora planes que no son de la sesión", async () => {
    await withPlan();
    bc({ type: "plan:done", planId: "otro", status: "failed", timestamp: "t" });
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
    const [vault, dir, input] = two.writeNote.mock.calls[0];
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
    const writeNote = vi.fn<NoteFn>(() => {
      throw new Error("disco");
    });
    const { deps } = setup({ writeNote, script: (_m, n) => (n >= 3 ? { ok: false, error: "x" } : { text: "R." }) });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "primero");
    await say(sessionId, "segundo");
    const r = await session.endAssistant(sessionId, "user");
    expect(r).toEqual({ notePath: null });
    const input = writeNote.mock.calls[0][2];
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

describe("sesión terminada con un turno en curso", () => {
  function gatedAgy() {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const made: { closed: boolean; sent: string[]; closeCalls: number }[] = [];
    let spawns = 0;
    const factory = () => {
      spawns++;
      const mine = { closed: false, sent: [] as string[], closeCalls: 0 };
      made.push(mine);
      return {
        send: async (text: string, _d: (s: string) => void) => {
          mine.sent.push(text);
          if (made.length === 1 && mine.sent.length === 2) {
            await gate; // el turno del usuario
            // close() hace fallar el turno en curso con un error que no es de cuota
            return full({ ok: false, error: "agy dejó de responder" });
          }
          return full({ text: "Listo." });
        },
        alive: () => !mine.closed,
        close: () => {
          mine.closed = true;
          mine.closeCalls++;
          release();
        },
      };
    };
    return { factory, made, spawns: () => spawns };
  }

  async function endMidTurn(how: (sid: string, deps: Deps) => Promise<void>) {
    const g = gatedAgy();
    const { deps } = setup({ agy: g.factory });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await waitFor(() => g.made[0].sent.length === 1);
    await new Promise((r) => setTimeout(r, 20)); // calentamiento terminado
    const r = await session.assistantTurn(sessionId, "hola");
    if ("error" in r) throw new Error(r.error);
    await waitFor(() => g.made[0].sent.length === 2);
    await how(sessionId, deps);
    await new Promise((r2) => setTimeout(r2, 60));
    return { g, turnId: r.turnId, sessionId };
  }

  it("terminar a media llamada: sin reintento, sin turn-done y todo agy cerrado", async () => {
    const { g } = await endMidTurn(async (sid) => {
      await session.endAssistant(sid, "user");
    });
    expect(g.spawns()).toBe(1);
    expect(types("voice:assistant:turn-done")).toHaveLength(0);
    expect(g.made.every((m) => m.closed)).toBe(true);
    expect(await db.select().from(schema.tasks)).toHaveLength(0);
  });

  it("una sesión nueva a media llamada: no se lanza agy de más y todo queda cerrado", async () => {
    const { g } = await endMidTurn(async (_sid, deps) => {
      await session.startAssistant({ projectId: null }, deps);
    });
    // agy 1 (sesión vieja) y agy 2 (sesión nueva); ninguno extra por reintento
    expect(g.spawns()).toBe(2);
    expect(g.made[0].closed).toBe(true);
    expect(types("voice:assistant:turn-done")).toHaveLength(0);
  });

  it("shutdown a media llamada: silencio y agy cerrado", async () => {
    const { g } = await endMidTurn(async () => {
      session.shutdownAssistant();
    });
    expect(g.spawns()).toBe(1);
    expect(g.made.every((m) => m.closed)).toBe(true);
    expect(types("voice:assistant:turn-done")).toHaveLength(0);
  });

  it("el resumen de la nota no se pide con un turno en curso (no respawnea agy)", async () => {
    const g = gatedAgy();
    const { deps, writeNote } = setup({ agy: g.factory });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await waitFor(() => g.made[0].sent.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    // dos turnos reales no son posibles con el agy bloqueado; se usa la sesión ya terminada vía fallback
    const r = await session.endAssistant(sessionId, "user");
    expect(r).toEqual({ notePath: null });
    expect(writeNote).not.toHaveBeenCalled();
    expect(g.spawns()).toBe(1);
  });
});

describe("revisión final F6", () => {
  const gate = () => {
    let release: () => void = () => {};
    const p = new Promise<void>((r) => (release = r));
    return { p, release: () => release() };
  };
  const spoken = (turnId: string) => types("voice:assistant:delta").filter((e) => e.turnId === turnId).map((e) => e.delta).join("");

  it("I1: terminar mientras se busca la memoria: el turno no llega a agy ni lanza otro", async () => {
    const g = gate();
    const retrieve = vi.fn(async () => {
      await g.p;
      return { notes: [], source: "none" as const };
    });
    const { deps, agy } = setup({ retrieve: asRetrieve(retrieve) });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await waitFor(() => agy.sent.length === 1);
    const r = await session.assistantTurn(sessionId, "hola");
    expect("turnId" in r).toBe(true);
    await waitFor(() => retrieve.mock.calls.length === 1);
    await session.endAssistant(sessionId, "user");
    g.release();
    await new Promise((x) => setTimeout(x, 30));
    expect(agy.sent).toHaveLength(1);
    expect(agy.made).toHaveLength(1);
    expect(types("voice:assistant:turn-done")).toHaveLength(0);
  });

  it("I2: el servidor reemplaza la pregunta de agy por una que repite el pedido", async () => {
    const reply = 'Puedo revisarlo. ¿Lo arranco? <<<ACCION plan {"pedido":"Revisa el login","proyecto":"Orquestador-IA"}>>>';
    const { deps } = setup({ script: [{ text: "Listo." }, { text: reply }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "revisa el login");
    expect(d.speech).toBe("Puedo revisarlo. ¿Arranco el plan: «Revisa el login»?");
    expect(d.hasAction).toBe(true);
    expect(d.pedido).toBe("Revisa el login");
    const said = spoken(d.turnId as string);
    expect(said).toBe("Puedo revisarlo. ¿Arranco el plan: «Revisa el login»?");
    expect(said).not.toContain("<<<");
  });

  it("I2: agy que no pregunta igual recibe la pregunta del servidor", async () => {
    const reply = 'Te cuento cómo quedó. <<<ACCION plan {"pedido":"Borra la base","proyecto":"Orquestador-IA"}>>>';
    const { deps } = setup({ script: [{ text: "Listo." }, { text: reply }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "cómo quedó");
    expect(d.speech).toBe("Te cuento cómo quedó. ¿Arranco el plan: «Borra la base»?");
  });

  it("I2: interrumpir descarta la acción pendiente", async () => {
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: PROPOSE }, { text: "Va." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    expect(session.interruptAssistant(sessionId)).toBe(true);
    const d = await say(sessionId, "dale");
    expect(createPlan).not.toHaveBeenCalled();
    expect(d.speech).toBe("Va.");
  });

  it("I2: interrumpir con el turno en curso impide que su acción quede armada", async () => {
    const g = gate();
    let n = 0;
    const agyObj = {
      send: async (_t: string, onDelta: (d: string) => void) => {
        n++;
        if (n === 2) await g.p;
        const text = n === 2 ? PROPOSE : "Va.";
        onDelta(text);
        return full({ text });
      },
      alive: () => true,
      close: () => {},
    };
    const { deps, createPlan } = setup({ agy: () => agyObj });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const r = await session.assistantTurn(sessionId, "haz X");
    if ("error" in r) throw new Error(r.error);
    await waitFor(() => n === 2);
    session.interruptAssistant(sessionId);
    g.release();
    await turnDone(r.turnId);
    await say(sessionId, "dale");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("I2: el calentamiento nunca arma una acción", async () => {
    const { deps, createPlan } = setup({ script: [{ text: PROPOSE }, { text: "Va." }] });
    const { sessionId } = await session.startAssistant({ projectId: "p1" }, deps);
    await waitFor(() => types("accounts:changed").length > 0);
    await say(sessionId, "dale");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("I2: interrumpir una sesión desconocida devuelve false", () => {
    expect(session.interruptAssistant("nope")).toBe(false);
  });

  it("I3: proyecto desconocido: pregunta cuál y no arma la acción (aunque la sesión tenga proyecto)", async () => {
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"Arregla el README","proyecto":"tienda"}>>>';
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "Ok." }] });
    const { sessionId } = await session.startAssistant({ projectId: "p1" }, deps);
    const d = await say(sessionId, "arregla el README de mi tienda");
    expect(d.hasAction).toBe(false);
    expect(d.speech).toBe("¿En qué proyecto lo hago? Tengo: Orquestador-IA.");
    expect(spoken(d.turnId as string)).toBe("¿En qué proyecto lo hago? Tengo: Orquestador-IA.");
    await say(sessionId, "dale");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it.each([["null"], ['""'], ['"  "']])("I3: proyecto %s sin proyecto de sesión: pregunta cuál", async (p) => {
    const reply = `¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":${p}}>>>`;
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: reply }, { text: "Ok." }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "haz X");
    expect(d.hasAction).toBe(false);
    expect(d.speech).toContain("¿En qué proyecto lo hago?");
    await say(sessionId, "dale");
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("I3: proyecto vacío con proyecto de sesión usa el de la sesión", async () => {
    const reply = '¿Lo arranco? <<<ACCION plan {"pedido":"X","proyecto":""}>>>';
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: reply }] });
    const { sessionId } = await session.startAssistant({ projectId: "p1" }, deps);
    const d = await say(sessionId, "haz X");
    expect(d.hasAction).toBe(true);
    await confirm(sessionId);
    await waitFor(() => createPlan.mock.calls.length === 1);
    expect(createPlan).toHaveBeenCalledWith({ description: "X", projectId: "p1" });
  });

  it("I4: /start con la cuenta bloqueada por cuota responde 409 sin lanzar agy", async () => {
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const { deps, agy } = setup();
    await expect(session.startAssistant({ projectId: null }, deps)).rejects.toMatchObject({
      status: 409, message: "Se acabó la cuota de esta cuenta de Antigravity; cámbiala en el panel.",
    });
    expect(agy.made).toHaveLength(0);
    expect(session.activeAssistant()).toBeNull();
  });

  it("I4: un bloqueo ya vencido no impide arrancar", async () => {
    await db.update(schema.agyAccounts).set({ quotaBlockedUntil: new Date(Date.now() - 1000).toISOString() });
    const { deps } = setup();
    await expect(session.startAssistant({ projectId: null }, deps)).resolves.toHaveProperty("sessionId");
  });

  it("I4: cuota en el calentamiento: lo anuncia en voz y termina la sesión", async () => {
    const { deps, agy } = setup({ script: [{ ok: false, quota: true, error: "quota exhausted" }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await waitFor(() => types("voice:assistant:ended").length > 0);
    expect(announces()).toEqual(["Se acabó la cuota de esta cuenta de Antigravity; cámbiala en el panel."]);
    expect(types("voice:assistant:ended")[0]).toMatchObject({ sessionId, reason: "error" });
    expect(agy.made[0].closed).toBe(true);
  });

  it("I5: lo guardado en tasks/runs pasa por redactSecrets", async () => {
    const { deps } = setup({ script: [{ text: "Listo." }, { text: "Tu api_key: sk-zzz123 quedó." }] });
    const { conversationId, sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "mi password=hunter2 sirve?");
    const tasks = await db.select().from(schema.tasks).where(eq(schema.tasks.conversationId, conversationId));
    const runs = await db.select().from(schema.runs).where(eq(schema.runs.taskId, tasks[0].id));
    const all = JSON.stringify([tasks[0].prompt, tasks[0].title, runs[0].prompt, runs[0].result, runs[0].summary]);
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("sk-zzz123");
  });

  it("I7: dos /start concurrentes no dejan una sesión huérfana", async () => {
    const g = gate();
    let n = 0;
    const made: { closed: boolean }[] = [];
    const factory = () => {
      const mine = { closed: false };
      made.push(mine);
      return {
        send: async (t: string, onDelta: (d: string) => void) => {
          n++;
          if (t.startsWith("Resume esta plática")) await g.p; // el resumen de A tarda
          onDelta("R.");
          return full({ text: "R." });
        },
        alive: () => !mine.closed,
        close: () => {
          mine.closed = true;
        },
      };
    };
    const { deps } = setup({ agy: factory });
    const a = await session.startAssistant({ projectId: null }, deps);
    await waitFor(() => n === 1);
    await new Promise((x) => setTimeout(x, 10)); // calentamiento terminado
    await say(a.sessionId, "uno");
    await say(a.sessionId, "dos");
    const pb = session.startAssistant({ projectId: null }, deps);
    await waitFor(() => n === 4); // B espera el resumen de A
    const pc = session.startAssistant({ projectId: null }, deps);
    await new Promise((x) => setTimeout(x, 20));
    g.release();
    const [b, c] = await Promise.all([pb, pc]);
    expect(session.activeAssistant()?.sessionId).toBe(c.sessionId);
    const ended = types("voice:assistant:ended").map((e) => e.sessionId);
    expect(ended).toEqual(expect.arrayContaining([a.sessionId, b.sessionId]));
    expect(made).toHaveLength(3);
    expect(made.filter((m) => !m.closed)).toHaveLength(1);
  });
});

describe("I3: sin carpeta de proyecto no hay plan de voz", () => {
  it("si el proyecto desaparece antes del sí, no se crea el plan (nunca cae en process.cwd())", async () => {
    const { deps, createPlan } = setup({ script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "haz X");
    expect(d.hasAction).toBe(true);
    await db.delete(schema.projects);
    await confirm(sessionId);
    await waitFor(() => announces().length > 0);
    expect(announces()).toEqual(["No pude crear el plan."]);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("un proyecto sin ruta no cuenta como resuelto", async () => {
    await db.update(schema.projects).set({ path: "" });
    const { deps } = setup({ script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    const d = await say(sessionId, "haz X");
    expect(d.hasAction).toBe(false);
    expect(d.speech).toContain("¿En qué proyecto lo hago?");
  });
});

describe("I6: sin JEV el plan de voz espera aprobación en pantalla", () => {
  it("startPlan se pide con requireJev y 'needs-jev-approval' se anuncia con el planId", async () => {
    const startPlan = vi.fn(async (_id: string, _o?: { requireJev?: boolean }) => "needs-jev-approval" as const);
    const { deps } = setup({ startPlan, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    ready();
    await waitFor(() => announces().length > 0);
    expect(startPlan).toHaveBeenCalledWith("plan-1", { requireJev: true });
    expect(announces()).toEqual(["Lo preparé; apruébalo en la pantalla para arrancarlo."]);
    expect(types("voice:assistant:announce")[0]).toMatchObject({ planId: "plan-1", needsApproval: true });
  });

  it("plan crítico conserva su texto y también marca needsApproval", async () => {
    const startPlan = vi.fn(async (_id: string, _o?: { requireJev?: boolean }) => "needs-approval" as const);
    const { deps } = setup({ startPlan, script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    ready();
    await waitFor(() => announces().length > 0);
    expect(announces()).toEqual(["Lo preparé, pero es un plan crítico: apruébalo en la pantalla."]);
    expect(types("voice:assistant:announce")[0]).toMatchObject({ planId: "plan-1", needsApproval: true });
  });

  it("un plan arrancado no pide aprobación", async () => {
    const { deps } = setup({ script: [{ text: "Listo." }, { text: PROPOSE }] });
    const { sessionId } = await session.startAssistant({ projectId: null }, deps);
    await say(sessionId, "haz X");
    await confirm(sessionId);
    await new Promise((r) => setTimeout(r, 20));
    ready();
    await waitFor(() => announces().length > 0);
    expect(types("voice:assistant:announce")[0].needsApproval).toBeUndefined();
  });
});
