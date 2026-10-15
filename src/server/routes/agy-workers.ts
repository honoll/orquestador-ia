import { Hono } from "hono";
import {
  listWorkers, createWorker, updateWorker, deleteWorker, importWorkers, markWorkerHealth, markWorkerBusy, WorkerValidationError,
} from "../agy-workers.js";
import { workerHealth } from "../../adapters/agy/worker-client.js";

const app = new Hono();

const fail = (err: unknown) => {
  if (err instanceof WorkerValidationError) {
    return { status: (/no encontrado/i.test(err.message) ? 404 : 400) as 400 | 404, error: err.message };
  }
  return { status: 500 as const, error: String((err as Error)?.message ?? err) };
};

const body = async (c: { req: { json: () => Promise<unknown> } }) => {
  const b = await c.req.json().catch(() => ({}));
  return (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
};

app.get("/", async (c) => c.json(await listWorkers()));

app.post("/", async (c) => {
  try {
    const b = await body(c);
    return c.json(await createWorker({ accountId: b.accountId, port: b.port, keyPath: b.keyPath, enabled: b.enabled }), 201);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status === 404 ? 400 : f.status);
  }
});

// Lee los <cuenta>.json de C:\ProgramData\orquestador-ia\workers (o AGY_WORKERS_DIR); nunca lee ni devuelve llaves.
app.post("/import", async (c) => {
  try {
    return c.json(await importWorkers());
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.patch("/:id", async (c) => {
  try {
    const b = await body(c);
    return c.json(await updateWorker(c.req.param("id"), { port: b.port, keyPath: b.keyPath, enabled: b.enabled }));
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.delete("/:id", async (c) => {
  try {
    await deleteWorker(c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.get("/:id/health", async (c) => {
  const w = (await listWorkers()).find((x) => x.id === c.req.param("id"));
  if (!w) return c.json({ error: "Trabajador no encontrado" }, 404);
  try {
    const h = await workerHealth({ port: w.port, keyPath: w.keyPath });
    markWorkerHealth(w.id, true);
    markWorkerBusy(w.id, h.busy === true);
    return c.json(h);
  } catch (err) {
    markWorkerHealth(w.id, false);
    return c.json({ ok: false, error: (err as Error).message }, 502);
  }
});

export default app;
