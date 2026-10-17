import { describe, it, expect, beforeAll, vi } from "vitest";

const { migrationDone } = await import("../../src/db/migrate.js");
const { createGoal, createChildTask, childrenOf, commentsFor } = await import("../../src/server/equipo/tasks.js");
const ALC = { leer: ["x"], entrega: "breve" }; // alcance obligatorio al delegar
const { issueRunToken } = await import("../../src/server/equipo/tokens.js");
const { createEquipoAgenteRoute } = await import("../../src/server/routes/equipo-agente.js");

beforeAll(async () => { await migrationDone; });

const kick = vi.fn();
const app = createEquipoAgenteRoute(kick);
const req = (path: string, token: string | null, body?: unknown, raw?: string) => app.request(path, {
  method: body !== undefined || raw !== undefined ? "POST" : "GET",
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
});

describe("API del agente", () => {
  it("401 sin token o con token falso", async () => {
    expect((await req("/tarea", null)).status).toBe(401);
    expect((await req("/tarea", "f".repeat(64))).status).toBe(401);
  });

  it("GET /tarea devuelve el contexto de su tarea", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "Meta A" });
    const token = await issueRunToken({ planId, stepId: rootStepId });
    const r = await req("/tarea", token);
    expect(r.status).toBe(200);
    // PowerShell 5.1 decodifica JSON sin charset como ISO-8859-1 y rompe los acentos
    expect(r.headers.get("content-type")).toContain("charset=utf-8");
    expect(((await r.json()) as { meta: { pedido: string } }).meta.pedido).toBe("Meta A");
  });

  it("POST /tareas crea una hija bajo su tarea y patea la meta; valida y aplica topes", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "m" });
    const token = await issueRunToken({ planId, stepId: rootStepId });
    const r = await req("/tareas", token, { rol: "dev", titulo: "Código", instrucciones: "haz", esperar: true, ...ALC });
    expect(r.status).toBe(201);
    const { id } = (await r.json()) as { id: string };
    expect((await childrenOf(rootStepId)).map((k) => k.id)).toEqual([id]);
    expect(kick).toHaveBeenCalledWith(planId);
    expect((await req("/tareas", token, { rol: "nadie", titulo: "x", instrucciones: "y", ...ALC })).status).toBe(400);
    expect((await req("/tareas", token, { rol: "dev", titulo: "t", instrucciones: "x" })).status).toBe(400); // sin leer ni entrega
    expect((await req("/tareas", token, undefined, "{roto")).status).toBe(400);
    expect((await req("/tareas", token, undefined, JSON.stringify({ rol: "dev", titulo: "t", instrucciones: "x".repeat(17000) }))).status).toBe(413);
  });

  it("POST /comentarios: en su tarea o en una hija; 403 fuera de su árbol", async () => {
    const { planId, rootStepId } = await createGoal({ pedido: "m" });
    const a = (await createChildTask(planId, rootStepId, { rol: "dev", titulo: "a", instrucciones: "i", ...ALC })).id;
    const b = (await createChildTask(planId, rootStepId, { rol: "dev", titulo: "b", instrucciones: "i", ...ALC })).id;
    const tokA = await issueRunToken({ planId, stepId: a });
    expect((await req("/comentarios", tokA, { texto: "avance" })).status).toBe(201);
    expect((await commentsFor(a, 5)).map((c) => c.body)).toEqual(["avance"]);
    expect((await req("/comentarios", tokA, { tareaId: b, texto: "hola" })).status).toBe(403);
    expect((await req("/comentarios", tokA, { tareaId: rootStepId, texto: "hola" })).status).toBe(403);
    const tokRoot = await issueRunToken({ planId, stepId: rootStepId });
    expect((await req("/comentarios", tokRoot, { tareaId: b, texto: "ajusta" })).status).toBe(201);
  });
});
