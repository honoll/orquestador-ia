import { describe, it, expect, vi } from "vitest";
import { createJevClient, JEV_ENDPOINT, JEV_STATE_MAX_CHARS } from "../../src/lib/jev.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const answers = { tier: { type: "choice", choice: "trivial", confidence: 0.9, probabilities: { trivial: 0.9, normal: 0.1 } } };

describe("cliente JEV", () => {
  it("sin llave: no configurado y ask devuelve null sin llamar a la red", async () => {
    const fetchImpl = vi.fn();
    const c = createJevClient({ apiKey: "", fetchImpl: fetchImpl as any });
    expect(c.configured()).toBe(false);
    expect(await c.ask("x", { q: { type: "noul", instructions: "?" } })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("manda state, modelo y preguntas con Bearer y devuelve answers", async () => {
    const fetchImpl = vi.fn(async () => ok({ model: "jev-1.13.0", answers, usage: {} }));
    const c = createJevClient({ apiKey: "k", fetchImpl: fetchImpl as any });
    const r = await c.ask("pedido", { tier: { type: "choice", instructions: "?", criteria: { trivial: "a", normal: "b" } } });
    expect(r).toEqual(answers);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ state: "pedido", model: "jev-latest" });
    expect(body.questions.tier.criteria).toEqual({ trivial: "a", normal: "b" });
  });

  it("recorta el state", async () => {
    const fetchImpl = vi.fn(async () => ok({ answers }));
    await createJevClient({ apiKey: "k", fetchImpl: fetchImpl as any }).ask("x".repeat(JEV_STATE_MAX_CHARS + 100), { q: { type: "noul", instructions: "?" } });
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.state.length).toBe(JEV_STATE_MAX_CHARS);
  });

  it("reintenta una vez en 429 y luego responde", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(ok({ answers }));
    const r = await createJevClient({ apiKey: "k", fetchImpl: fetchImpl as any, retryDelayMs: 1 }).ask("x", { q: { type: "noul", instructions: "?" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r).toEqual(answers);
  });

  it("errores, respuestas sin answers y excepciones devuelven null (nunca lanza)", async () => {
    const q = { q: { type: "noul" as const, instructions: "?" } };
    expect(await createJevClient({ apiKey: "k", fetchImpl: vi.fn(async () => new Response("", { status: 401 })) as any }).ask("x", q)).toBeNull();
    expect(await createJevClient({ apiKey: "k", fetchImpl: vi.fn(async () => ok({ nada: 1 })) as any }).ask("x", q)).toBeNull();
    expect(await createJevClient({ apiKey: "k", fetchImpl: vi.fn(async () => { throw new Error("red"); }) as any }).ask("x", q)).toBeNull();
    const twice429 = vi.fn(async () => new Response("", { status: 529 }));
    expect(await createJevClient({ apiKey: "k", fetchImpl: twice429 as any, retryDelayMs: 1 }).ask("x", q)).toBeNull();
    expect(twice429).toHaveBeenCalledTimes(2);
  });

  it("el cliente por defecto lee la llave del entorno en cada llamada", async () => {
    const c = createJevClient({ fetchImpl: vi.fn() as any });
    expect(c.configured()).toBe(false);
    process.env.TYPESAFE_API_KEY = "k";
    try {
      expect(c.configured()).toBe(true);
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });
});
