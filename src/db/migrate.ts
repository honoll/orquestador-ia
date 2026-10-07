import { createClient } from "@libsql/client";
import path from "node:path";
import { orchestratorDataRoot } from "../lib/worker-profile.js";
import fs from "node:fs";

const DB_DIR = path.join(
  orchestratorDataRoot(),
  "data",
);
fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, "orquestador.db");
const client = createClient({ url: `file:${DB_PATH}` });

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  skills_dir TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  conversation_id TEXT,
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','cancelled')),
  adapter TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  adapter TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','cancelled','timed_out')),
  prompt TEXT NOT NULL,
  result TEXT,
  summary TEXT,
  session_id TEXT,
  exit_code INTEGER,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_message TEXT,
  error_family TEXT,
  retry_not_before TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  timeout_sec INTEGER,
  cwd TEXT,
  env TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('generating','pending','running','completed','failed','cancelled')),
  error_message TEXT,
  estimated_tokens INTEGER,
  budget_tokens INTEGER,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  max_parallel INTEGER NOT NULL DEFAULT 3,
  pause_reason TEXT,
  tier TEXT,
  tier_confidence REAL,
  tier_source TEXT,
  memory_notes TEXT,
  memory_source TEXT,
  memory_note_path TEXT,
  synthesis TEXT,
  synthesis_status TEXT,
  synthesis_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  step_index INTEGER NOT NULL,
  description TEXT NOT NULL,
  adapter TEXT NOT NULL,
  model TEXT,
  reason TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped')),
  run_id TEXT,
  result TEXT,
  error_message TEXT,
  cost_usd REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  session_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  step_key TEXT,
  depends_on TEXT,
  writes INTEGER,
  estimated_tokens INTEGER,
  read_only INTEGER NOT NULL DEFAULT 0,
  guard_flags TEXT,
  guard_approved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_plan_steps_plan ON plan_steps(plan_id);

CREATE TABLE IF NOT EXISTS plan_file_changes (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  file_path TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  changed_at TEXT NOT NULL,
  UNIQUE(plan_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_plan_file_changes_plan ON plan_file_changes(plan_id);

CREATE TABLE IF NOT EXISTS agy_accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  manual_limit_5h INTEGER,
  manual_limit_7d INTEGER,
  calibrated_limit_5h INTEGER,
  quota_blocked_until TEXT,
  quota_blocked_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agy_usage (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES agy_accounts(id),
  at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agy_usage_account_at ON agy_usage(account_id, at);

CREATE TABLE IF NOT EXISTS vault_notes (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  frontmatter TEXT,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL REFERENCES vault_notes(path),
  heading TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vault_chunks_path ON vault_chunks(path);
`;

const statements = SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean);

async function migrate() {
  // Run CREATE TABLE statements first (skip CREATE INDEX)
  for (const stmt of statements) {
    if (stmt.toUpperCase().startsWith("CREATE INDEX")) continue;
    await client.execute(stmt);
  }

  // Add conversation_id column if missing (migration for existing DBs)
  try {
    await client.execute("ALTER TABLE tasks ADD COLUMN conversation_id TEXT");
  } catch {
    // column already exists
  }

  // Backfill NULL conversation_id with the task's own id (self-referencing for single-message conversations)
  await client.execute("UPDATE tasks SET conversation_id = id WHERE conversation_id IS NULL");

  // Migrate plans table to support 'generating' status if the old CHECK constraint is missing it.
  // Clean up any leftover plans_old from previous failed migrations first.
  await client.execute("DROP TABLE IF EXISTS plans_old");
  const tableInfo = await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='plans'");
  const plansSql = String((tableInfo.rows[0] as any)?.[0] ?? "");
  if (plansSql && !plansSql.includes("generating")) {
    // Recreate plans table with 'generating' in the CHECK constraint.
    // IMPORTANT: Use a plans_new temp name so we never rename the original 'plans'
    // table — SQLite auto-updates FK references in other tables when a table is renamed,
    // so renaming plans→plans_old causes plan_steps to reference "plans_old" (broken FK).
    await client.execute("DROP TABLE IF EXISTS plans_new");
    await client.execute(`CREATE TABLE plans_new (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('generating','pending','running','completed','failed','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await client.execute("INSERT OR IGNORE INTO plans_new (id, project_id, description, status, created_at, updated_at) SELECT id, project_id, description, status, created_at, updated_at FROM plans");
    await client.execute("DROP TABLE plans");
    await client.execute("ALTER TABLE plans_new RENAME TO plans");
    console.log("Migrated plans table to support 'generating' status");
  }

  // Fix plan_steps FK if it references "plans_old" (caused by SQLite auto-updating FK
  // references when the plans table was renamed during migration — the old rename left
  // plan_steps pointing at the now-deleted plans_old table, which breaks every insert).
  await client.execute("DROP TABLE IF EXISTS plan_steps_old");
  const planStepsInfo = await client.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='plan_steps'");
  const planStepsSql = String((planStepsInfo.rows[0] as any)?.[0] ?? "");
  if (planStepsSql.includes("plans_old")) {
    await client.execute("ALTER TABLE plan_steps RENAME TO plan_steps_old");
    await client.execute(`CREATE TABLE plan_steps (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      step_index INTEGER NOT NULL,
      description TEXT NOT NULL,
      adapter TEXT NOT NULL,
      model TEXT,
      reason TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','succeeded','failed','cancelled','skipped')),
      run_id TEXT,
      result TEXT,
      error_message TEXT,
      cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      session_id TEXT,
      started_at TEXT,
      finished_at TEXT
    )`);
    await client.execute("INSERT OR IGNORE INTO plan_steps (id, plan_id, step_index, description, adapter, model, reason, prompt, status, run_id, result, error_message, cost_usd, input_tokens, output_tokens, session_id, started_at, finished_at) SELECT id, plan_id, step_index, description, adapter, model, reason, prompt, status, run_id, result, error_message, cost_usd, input_tokens, output_tokens, session_id, started_at, finished_at FROM plan_steps_old");
    await client.execute("DROP TABLE plan_steps_old");
    console.log("Fixed plan_steps FK reference (was pointing to plans_old)");
  }

  // Add error_message column to plans if missing
  try {
    await client.execute("ALTER TABLE plans ADD COLUMN error_message TEXT");
  } catch {
    // column already exists
  }

  // Add chat_history column to plans if missing
  try {
    await client.execute("ALTER TABLE plans ADD COLUMN chat_history TEXT");
  } catch {
    // column already exists
  }

  try {
    await client.execute("ALTER TABLE agy_accounts ADD COLUMN quota_blocked_at TEXT");
  } catch {
    // already exists
  }

  for (const stmt of [
    "ALTER TABLE plans ADD COLUMN estimated_tokens INTEGER",
    "ALTER TABLE plans ADD COLUMN budget_tokens INTEGER",
    "ALTER TABLE plans ADD COLUMN used_tokens INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE plans ADD COLUMN max_parallel INTEGER NOT NULL DEFAULT 3",
    "ALTER TABLE plans ADD COLUMN pause_reason TEXT",
    "ALTER TABLE plans ADD COLUMN synthesis TEXT",
    "ALTER TABLE plans ADD COLUMN synthesis_status TEXT",
    "ALTER TABLE plans ADD COLUMN synthesis_error TEXT",
    "ALTER TABLE plan_steps ADD COLUMN step_key TEXT",
    "ALTER TABLE plan_steps ADD COLUMN depends_on TEXT",
    "ALTER TABLE plan_steps ADD COLUMN writes INTEGER",
    "ALTER TABLE plan_steps ADD COLUMN estimated_tokens INTEGER",
    "ALTER TABLE plans ADD COLUMN tier TEXT",
    "ALTER TABLE plans ADD COLUMN tier_confidence REAL",
    "ALTER TABLE plans ADD COLUMN tier_source TEXT",
    "ALTER TABLE plans ADD COLUMN memory_notes TEXT",
    "ALTER TABLE plans ADD COLUMN memory_source TEXT",
    "ALTER TABLE plans ADD COLUMN memory_note_path TEXT",
    "ALTER TABLE plan_steps ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE plan_steps ADD COLUMN guard_flags TEXT",
    "ALTER TABLE plan_steps ADD COLUMN guard_approved INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await client.execute(stmt); } catch { /* column already exists */ }
  }

  // Si una base vieja quedó con más de una cuenta activa, conservar la más antigua.
  await client.execute(`UPDATE agy_accounts SET active = 0 WHERE active = 1 AND id NOT IN (
    SELECT id FROM agy_accounts WHERE active = 1 ORDER BY created_at LIMIT 1)`);
  try {
    await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_agy_accounts_active ON agy_accounts(active) WHERE active = 1");
  } catch { /* already exists */ }

  // Create plan_file_changes table if missing (migration for existing DBs)
  try {
    await client.execute(`CREATE TABLE IF NOT EXISTS plan_file_changes (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      file_path TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      changed_at TEXT NOT NULL,
      UNIQUE(plan_id, file_path)
    )`);
  } catch {
    // already exists
  }
  try {
    await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_file_changes ON plan_file_changes(plan_id, file_path)");
  } catch {
    // already exists
  }

  // Now run CREATE INDEX statements
  for (const stmt of statements) {
    if (!stmt.toUpperCase().startsWith("CREATE INDEX")) continue;
    await client.execute(stmt);
  }

  console.log(`Database migrated at ${DB_PATH}`);
}

// Export the migration promise so server/index.ts can await it
export const migrationDone = migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
