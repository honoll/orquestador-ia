import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const { migrationDone } = await import("../../src/db/migrate.js");
const { default: route } = await import("../../src/server/routes/agy-workers.js");
const { default: accountsRoute } = await import("../../src/server/routes/accounts.js");
const { createAccount } = await import("../../src/server/agy-accounts.js");

const KEY = "c".repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wr-"));
fs.writeFileSync(path.join(dir, "agy7.key"), KEY);
let server: http.Server;
let port = 0;

beforeAll(async () => {
  await migrationDone;
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end("{}"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, account: "agy7", version: "1", busy: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  fs.writeFileSync(path.join(dir, "agy7.json"), JSON.stringify({ account: "agy7", port, windowsUser: "agy7" }));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const json = (p: string, method: string, body?: unknown) =>
  route.request(p, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe("/api/agy-workers", () => {
  it("import (AGY_WORKERS_DIR) + health por el cliente + PATCH/DELETE; nunca devuelve la llave", async () => {
    process.env.AGY_WORKERS_DIR = dir;
    const imp = await json("/import", "POST", {});
    expect(imp.status).toBe(200);
    const impText = await imp.text();
    expect(impText).not.toContain(KEY);
    const list = (await (await route.request("/")).json()) as { id: string; accountLabel: string; port: number }[];
    const w = list.find((x) => x.accountLabel === "agy7")!;
    expect(w.port).toBe(port);
    const health = await route.request(`/${w.id}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, account: "agy7", version: "1", busy: true });
    expect((await json(`/${w.id}`, "PATCH", { port: 80 })).status).toBe(400);
    expect((await json(`/${w.id}`, "PATCH", { enabled: false })).status).toBe(200);
    expect((await json(`/${w.id}`, "PATCH", { keyPath: path.join(dir, "nada.key") })).status).toBe(200);
    const bad = await route.request(`/${w.id}/health`);
    expect(bad.status).toBe(502);
    expect(((await bad.json()) as { ok: boolean }).ok).toBe(false);
    expect((await route.request(`/${w.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await route.request(`/nada/health`)).status).toBe(404);
    delete process.env.AGY_WORKERS_DIR;
  });

  it("POST crea y valida", async () => {
    const a = await createAccount("agy8");
    expect((await json("/", "POST", { accountId: a.id, port: 3128, keyPath: "C:/k/agy8.key" })).status).toBe(201);
    expect((await json("/", "POST", { accountId: a.id, port: 3129, keyPath: "C:/k/agy8.key" })).status).toBe(400);
    expect((await json("/", "POST", { accountId: "x", port: "3129" })).status).toBe(400);
  });

  it("PATCH /api/accounts/:id acepta pool", async () => {
    const a = await createAccount("pooled");
    const r = await accountsRoute.request(`/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pool: "Plan 3" }) });
    expect(((await r.json()) as { pool: string }).pool).toBe("Plan 3");
  });

  it("POST /api/accounts/:id/activate de una cuenta con trabajador → 409 con motivo en español", async () => {
    const a = await createAccount("agy9");
    expect((await json("/", "POST", { accountId: a.id, port: 3139, keyPath: "C:/k/agy9.key" })).status).toBe(201);
    const r = await accountsRoute.request(`/${a.id}/activate`, { method: "POST" });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/trabajador/);
  });
});
