import { Hono } from "hono";
import { codexProfile } from "../../lib/worker-profile.js";
import { openCodexLoginTerminal } from "../../lib/codex-terminal.js";

const app = new Hono();

app.get("/status", async (c) => {
  if (c.req.query("fresh") === "1") codexProfile.invalidate();
  const { home, loggedIn } = await codexProfile.status();
  return c.json({ claude: { isolated: true }, agy: { isolated: true }, codex: { isolated: loggedIn, home } });
});

app.post("/codex/login-terminal", async (c) => {
  try {
    openCodexLoginTerminal((await codexProfile.status()).home);
    codexProfile.invalidate();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String((err as Error)?.message ?? err) }, 501);
  }
});

export default app;
