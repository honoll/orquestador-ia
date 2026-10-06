import { Hono } from "hono";
import { claudeProfileManager } from "../../adapters/claude/profile-manager.js";

const app = new Hono();

// List profiles with real-time status
app.get("/", (c) => {
  return c.json(claudeProfileManager.getProfilesStatus());
});

// Add a profile
app.post("/", async (c) => {
  const body = await c.req.json<{ id: string; label: string }>();
  if (!body.id?.trim()) return c.json({ error: "id required" }, 400);
  claudeProfileManager.addProfile({
    id: body.id.trim(),
    label: body.label?.trim() || body.id.trim(),
  });
  return c.json(claudeProfileManager.getProfilesStatus(), 201);
});

// Update label
app.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ label: string }>();
  claudeProfileManager.updateProfile(id, { label: body.label });
  return c.json(claudeProfileManager.getProfilesStatus());
});

// Remove a profile
app.delete("/:id", (c) => {
  const id = c.req.param("id");
  claudeProfileManager.removeProfile(id);
  return c.json(claudeProfileManager.getProfilesStatus());
});

// Clear rate limit manually
app.post("/:id/clear-limit", (c) => {
  const id = c.req.param("id");
  claudeProfileManager.clearRateLimit(id);
  return c.json(claudeProfileManager.getProfilesStatus());
});

export default app;
