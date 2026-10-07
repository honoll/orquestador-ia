import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  description: text("description"),
  skillsDir: text("skills_dir"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id),
  conversationId: text("conversation_id"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ["pending", "running", "succeeded", "failed", "cancelled"] })
    .notNull()
    .default("pending"),
  adapter: text("adapter").notNull(),
  model: text("model"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const plans = sqliteTable("plans", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id),
  description: text("description").notNull(),
  status: text("status", { enum: ["generating", "pending", "running", "completed", "failed", "cancelled"] })
    .notNull()
    .default("pending"),
  errorMessage: text("error_message"),
  chatHistory: text("chat_history"),
  estimatedTokens: integer("estimated_tokens"),
  budgetTokens: integer("budget_tokens"),
  usedTokens: integer("used_tokens").notNull().default(0),
  maxParallel: integer("max_parallel").notNull().default(3),
  // Por qué está pausado el plan: cuota agotada o presupuesto de tokens.
  pauseReason: text("pause_reason", { enum: ["quota", "budget", "guard"] }),
  // Nivel de rigor del plan (clasificado por JEV o por el respaldo local) y de dónde salió.
  tier: text("tier", { enum: ["trivial", "normal", "critical"] }),
  tierConfidence: real("tier_confidence"),
  tierSource: text("tier_source", { enum: ["jev", "fallback"] }),
  // Memoria de Cerebro usada al planear: notas (JSON sin extracto), origen y nota del proyecto.
  memoryNotes: text("memory_notes"),
  memorySource: text("memory_source", { enum: ["semantic", "project-only", "none"] }),
  memoryNotePath: text("memory_note_path"),
  synthesis: text("synthesis"),
  synthesisStatus: text("synthesis_status", { enum: ["running", "succeeded", "failed"] }),
  synthesisError: text("synthesis_error"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const planSteps = sqliteTable("plan_steps", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => plans.id),
  stepIndex: integer("step_index").notNull(),
  description: text("description").notNull(),
  adapter: text("adapter").notNull(),
  model: text("model"),
  reason: text("reason"),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ["pending", "running", "succeeded", "failed", "cancelled", "skipped"] })
    .notNull()
    .default("pending"),
  runId: text("run_id"),
  result: text("result"),
  errorMessage: text("error_message"),
  costUsd: real("cost_usd"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  sessionId: text("session_id"),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  stepKey: text("step_key"),
  // JSON: arreglo con las claves (stepKey) de los pasos de los que depende.
  dependsOn: text("depends_on"),
  // 1 si el paso escribe en el proyecto, 0 si es solo lectura.
  writes: integer("writes"),
  estimatedTokens: integer("estimated_tokens"),
  // 1 = el adapter corre sin permisos de escritura.
  readOnly: integer("read_only").notNull().default(0),
  // JSON: arreglo de banderas (GuardFlag[]) que la guardia detectó en el prompt.
  guardFlags: text("guard_flags"),
  // 1 = el usuario aprobó correr el paso aunque la guardia lo marcó.
  guardApproved: integer("guard_approved").notNull().default(0),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id),
  adapter: text("adapter").notNull(),
  model: text("model"),
  status: text("status", { enum: ["running", "succeeded", "failed", "cancelled", "timed_out"] })
    .notNull()
    .default("running"),
  prompt: text("prompt").notNull(),
  result: text("result"),
  summary: text("summary"),
  sessionId: text("session_id"),
  exitCode: integer("exit_code"),
  costUsd: real("cost_usd"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  errorMessage: text("error_message"),
  errorFamily: text("error_family"),
  retryNotBefore: text("retry_not_before"),
  startedAt: text("started_at").notNull().default(sql`(datetime('now'))`),
  finishedAt: text("finished_at"),
  timeoutSec: integer("timeout_sec"),
  cwd: text("cwd"),
  env: text("env"),
});

export const planFileChanges = sqliteTable("plan_file_changes", {
  id: text("id").primaryKey(),
  planId: text("plan_id").notNull().references(() => plans.id),
  filePath: text("file_path").notNull(),
  content: text("content").notNull().default(""),
  changedAt: text("changed_at").notNull(),
}, (t) => ({
  uniqPlanFile: uniqueIndex("uq_plan_file_changes").on(t.planId, t.filePath),
}));

export const agyAccounts = sqliteTable("agy_accounts", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  active: integer("active").notNull().default(0),
  manualLimit5h: integer("manual_limit_5h"),
  manualLimit7d: integer("manual_limit_7d"),
  calibratedLimit5h: integer("calibrated_limit_5h"),
  quotaBlockedUntil: text("quota_blocked_until"),
  quotaBlockedAt: text("quota_blocked_at"),
  notes: text("notes"),
  createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
});

/** Consumo de cada llamada a agy (chat, plan o análisis), ligado a la cuenta activa. `at` en ISO. */
export const agyUsage = sqliteTable("agy_usage", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => agyAccounts.id),
  at: text("at").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  source: text("source").notNull(),
});

/** Notas de la bóveda de Obsidian indexadas (ruta relativa con "/"). */
export const vaultNotes = sqliteTable("vault_notes", {
  path: text("path").primaryKey(),
  title: text("title").notNull(),
  mtimeMs: integer("mtime_ms").notNull(),
  frontmatter: text("frontmatter"),
  indexedAt: text("indexed_at").notNull(),
});

/** Metadatos del índice de la bóveda: `model` y `dim` de los embeddings guardados. */
export const vaultMeta = sqliteTable("vault_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Trozos de cada nota con su embedding (base64 de Float32Array). */
export const vaultChunks = sqliteTable("vault_chunks", {
  id: text("id").primaryKey(),
  path: text("path").notNull().references(() => vaultNotes.path),
  heading: text("heading").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  text: text("text").notNull(),
  embedding: text("embedding").notNull(),
});
