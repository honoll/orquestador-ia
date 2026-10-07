import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createClient } from "@libsql/client";

// Base creada con el esquema ANTERIOR a F2 (sin columnas nuevas, con dos cuentas activas).
describe("actualización de una base anterior a F2", () => {
  it("agrega columnas, conserva datos y deja una sola cuenta activa", async () => {
    const dir = path.join(process.env.ORQUESTADOR_DATA_DIR!, "data");
    fs.mkdirSync(dir, { recursive: true });
    const old = createClient({ url: `file:${path.join(dir, "orquestador.db")}` });
    await old.executeMultiple(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, description TEXT, skills_dir TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE plans (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('generating','pending','running','completed','failed','cancelled')),
        error_message TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE plan_steps (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), step_index INTEGER NOT NULL,
        description TEXT NOT NULL, adapter TEXT NOT NULL, model TEXT, reason TEXT, prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', run_id TEXT, result TEXT, error_message TEXT, cost_usd REAL,
        input_tokens INTEGER, output_tokens INTEGER, session_id TEXT, started_at TEXT, finished_at TEXT);
      CREATE TABLE agy_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
        manual_limit_5h INTEGER, manual_limit_7d INTEGER, calibrated_limit_5h INTEGER, quota_blocked_until TEXT,
        quota_blocked_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO plans (id, description) VALUES ('p1', 'viejo');
      INSERT INTO plan_steps (id, plan_id, step_index, description, adapter, prompt) VALUES ('s1', 'p1', 0, 'x', 'codex', 'p');
      INSERT INTO agy_accounts (id, label, active, created_at) VALUES ('b', 'B', 1, '2026-02-01'), ('a', 'A', 1, '2026-01-01');
    `);
    old.close();

    const { migrationDone } = await import("../../src/db/migrate.js");
    await migrationDone;
    const { db, schema } = await import("../../src/db/index.js");

    const plan = (await db.select().from(schema.plans))[0];
    expect(plan).toMatchObject({ id: "p1", description: "viejo", usedTokens: 0, maxParallel: 3, budgetTokens: null, tier: null, tierConfidence: null, tierSource: null });
    const step = (await db.select().from(schema.planSteps))[0];
    expect(step).toMatchObject({ id: "s1", stepKey: null, dependsOn: null, writes: null, estimatedTokens: null, readOnly: 0, guardFlags: null, guardApproved: 0 });
    const accounts = await db.select().from(schema.agyAccounts);
    expect(accounts.filter((a) => a.active === 1).map((a) => a.id)).toEqual(["a"]);
    await expect(db.insert(schema.agyAccounts).values({ id: "z", label: "Z", active: 1 })).rejects.toThrow();
  });
});
