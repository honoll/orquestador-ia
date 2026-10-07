import { describe, it, expect, beforeAll } from "vitest";
import { migrationDone } from "../../src/db/migrate.js";
import { db, schema } from "../../src/db/index.js";
import tasksRoute from "../../src/server/routes/tasks.js";

const mk = (id: string, projectId: string | null, conversationId: string) => ({
  id, projectId, conversationId, title: `t-${id}`, prompt: "p", adapter: "claude",
});

beforeAll(async () => {
  await migrationDone;
  await db.insert(schema.projects).values({ id: "proj1", name: "P", path: "C:/p" });
  await db.insert(schema.tasks).values([
    mk("a", null, "conv-sin"), mk("b", null, "conv-sin"), mk("c", "proj1", "conv-proj"),
  ]);
});

describe("GET /conversations", () => {
  it("projectId=none devuelve solo las pláticas sin proyecto", async () => {
    const r = await tasksRoute.request("/conversations?projectId=none");
    const body = (await r.json()) as { conversationId: string; messageCount: number }[];
    expect(body.map((x) => x.conversationId)).toEqual(["conv-sin"]);
    expect(body[0].messageCount).toBe(2);
  });
  it("sin parámetro sigue devolviendo []", async () => {
    expect(await (await tasksRoute.request("/conversations")).json()).toEqual([]);
  });
  it("con un projectId real solo las de ese proyecto", async () => {
    const body = (await (await tasksRoute.request("/conversations?projectId=proj1")).json()) as { conversationId: string }[];
    expect(body.map((x) => x.conversationId)).toEqual(["conv-proj"]);
  });
});
