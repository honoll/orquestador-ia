import { Hono } from "hono";
import {
  listAccounts, createAccount, activateAccount, updateAccount, deleteAccount, getActiveAccount, AccountValidationError,
} from "../agy-accounts.js";
import { resolveAgyPath } from "../../lib/agy-path.js";
import { openAgyTerminal } from "../../lib/agy-terminal.js";

const app = new Hono();

const fail = (err: unknown) =>
  err instanceof AccountValidationError ? { status: 400 as const, error: err.message } : { status: 500 as const, error: String((err as Error)?.message ?? err) };

app.get("/", async (c) => c.json(await listAccounts()));

app.get("/active", async (c) => {
  const row = await getActiveAccount();
  if (!row) return c.json({ account: null });
  const account = (await listAccounts()).find((a) => a.id === row.id) ?? null;
  return c.json({ account });
});

app.post("/", async (c) => {
  try {
    const body = await c.req.json<{ label?: string }>();
    return c.json(await createAccount(body.label ?? ""), 201);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.post("/switch-terminal", async (c) => {
  const exe = resolveAgyPath();
  if (!exe) return c.json({ error: "agy no encontrado: instala Antigravity CLI o define AGY_PATH" }, 404);
  try {
    openAgyTerminal(exe);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 501);
  }
});

app.post("/:id/activate", async (c) => {
  try {
    await activateAccount(c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status === 400 ? 404 : 500);
  }
});

app.patch("/:id", async (c) => {
  try {
    const body = await c.req.json<{ label?: string; manualLimit5h?: number | null; manualLimit7d?: number | null; notes?: string | null }>();
    return c.json(await updateAccount(c.req.param("id"), body));
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status);
  }
});

app.delete("/:id", async (c) => {
  try {
    await deleteAccount(c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    const f = fail(err);
    return c.json({ error: f.error }, f.status === 400 ? 404 : 500);
  }
});

export default app;
