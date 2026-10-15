import { describe, it, expect } from "vitest";
import { buildOfficeState, type OfficeInput } from "../../src/server/office-state.js";

const NOW = 1_000_000;
const base = (o: Partial<OfficeInput> = {}): OfficeInput => ({
  now: NOW, generatingPlans: [], synthesisRunning: [], steps: [], chatRuns: [], tokensByAdapter: {},
  lastTierOrGuardAt: null, guardPausedCount: 0, memoryIndexing: false, lastMemoryLoadingAt: null, memoryNotes: 410,
  voiceActive: false, whisperState: "stopped", recentPlans: [], ...o,
});
const step = (o: Partial<OfficeInput["steps"][number]> = {}): OfficeInput["steps"][number] => ({
  planId: "p", stepId: "s1", stepKey: "s1", description: "hacer", adapter: "codex", model: null, status: "running",
  guardPaused: false, project: null, ...o,
});
const agent = (s: ReturnType<typeof buildOfficeState>, id: string) => s.agents.find((a) => a.id === id)!;

describe("buildOfficeState", () => {
  it("devuelve los 7 agentes y generatedAt ISO", () => {
    const s = buildOfficeState(base());
    expect(s.agents.map((a) => a.id)).toEqual(["jefe", "guardia", "agy", "codex", "claude", "biblio", "recepcion"]);
    expect(s.generatedAt).toBe(new Date(NOW).toISOString());
  });
  it("jefe: planeando, sintetizando, inactivo", () => {
    expect(agent(buildOfficeState(base({ generatingPlans: [{ id: "a", description: "X" }] })), "jefe")).toMatchObject({ working: true, activity: "planeando: X", model: "Opus 5.5" });
    expect(agent(buildOfficeState(base({ synthesisRunning: [{ id: "a", description: "Y" }] })), "jefe").activity).toBe("sintetizando: Y");
    expect(agent(buildOfficeState(base()), "jefe").working).toBe(false);
  });
  it("guardia: ventana de 8 s y pausa", () => {
    expect(agent(buildOfficeState(base({ lastTierOrGuardAt: NOW - 8000 })), "guardia").working).toBe(true);
    expect(agent(buildOfficeState(base({ lastTierOrGuardAt: NOW - 8001 })), "guardia").working).toBe(false);
    const g = agent(buildOfficeState(base({ guardPausedCount: 2 })), "guardia");
    expect(g.paused).toBe(true);
    expect(g.activity).toBe("pausó 2 paso(s)");
  });
  it("adaptadores: N = pasos running + chats; clamp de escritorios 1..4", () => {
    const idle = agent(buildOfficeState(base()), "codex");
    expect(idle).toMatchObject({ working: false, desks: 1, model: "gpt-5.5", tokens: 0 });
    const s = buildOfficeState(base({
      steps: [step({ model: "gpt-x" }), step({ stepId: "s2" }), step({ stepId: "s3", status: "pending" })],
      chatRuns: [{ adapter: "codex", model: null, prompt: "hola" }],
      tokensByAdapter: { codex: 77 },
    }));
    expect(agent(s, "codex")).toMatchObject({ working: true, desks: 3, activity: "hacer", model: "gpt-x", tokens: 77 });
    const many = buildOfficeState(base({ steps: Array.from({ length: 6 }, (_, i) => step({ stepId: `s${i}`, adapter: "agy" })) }));
    expect(agent(many, "agy").desks).toBe(4);
    const chat = buildOfficeState(base({ chatRuns: [{ adapter: "claude", model: "m", prompt: "p" }] }));
    expect(agent(chat, "claude")).toMatchObject({ working: true, activity: "chat", model: "m" });
  });
  it("biblio: indexando, buscando (20 s) y listo", () => {
    expect(agent(buildOfficeState(base({ memoryIndexing: true })), "biblio")).toMatchObject({ working: true, activity: "indexando" });
    expect(agent(buildOfficeState(base({ lastMemoryLoadingAt: NOW - 20000 })), "biblio")).toMatchObject({ working: true, activity: "buscando notas" });
    expect(agent(buildOfficeState(base({ lastMemoryLoadingAt: NOW - 20001 })), "biblio")).toMatchObject({ working: false, activity: "410 notas · listo" });
  });
  it("recepcion: voz activa o whisper arrancando", () => {
    expect(agent(buildOfficeState(base({ voiceActive: true })), "recepcion").working).toBe(true);
    expect(agent(buildOfficeState(base({ whisperState: "starting" })), "recepcion").working).toBe(true);
    expect(agent(buildOfficeState(base({ whisperState: "warming" })), "recepcion").working).toBe(true);
    expect(agent(buildOfficeState(base({ whisperState: "ready" })), "recepcion").working).toBe(false);
  });
  it("cola: running primero, luego pending, paused si guard, máx 20", () => {
    const steps = [
      step({ stepId: "p1", status: "pending" }),
      step({ stepId: "r1", status: "running" }),
      step({ stepId: "p2", status: "pending", guardPaused: true }),
      step({ stepId: "d", status: "succeeded" }),
    ];
    const q = buildOfficeState(base({ steps })).queue;
    expect(q.map((i) => [i.stepId, i.status])).toEqual([["r1", "running"], ["p1", "pending"], ["p2", "paused"]]);
    const big = Array.from({ length: 30 }, (_, i) => step({ stepId: `x${i}`, status: "pending" }));
    expect(buildOfficeState(base({ steps: big })).queue).toHaveLength(20);
  });
  it("plans = recentPlans", () => {
    const p = [{ id: "1", description: "d", status: "running", pauseReason: null, updatedAt: "t" }];
    expect(buildOfficeState(base({ recentPlans: p })).plans).toEqual(p);
  });
});

describe("collectOfficeInput (BD temporal)", () => {
  it("las consultas corren y devuelven la forma esperada", async () => {
    const { collectOfficeInput } = await import("../../src/server/office-state.js");
    const i = await collectOfficeInput(123);
    expect(i).toMatchObject({ now: 123, steps: [], chatRuns: [], whisperState: "stopped", voiceActive: false });
    expect(Array.isArray(i.recentPlans)).toBe(true);
  });
});
