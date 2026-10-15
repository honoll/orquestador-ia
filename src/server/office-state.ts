import { inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { MODEL_CATALOG, type AdapterType } from "../config/models.js";
import { isIndexing } from "../memory/vault-index.js";
import { activeAssistant } from "../voice/assistant/session.js";
import { whisper } from "../voice/whisper.js";
import { onBroadcast } from "./ws.js";
import { SERVER_STARTED_AT } from "./routes/usage.js";
import { agySeats, type AgySeat } from "./agy-workers.js";

export type AgentId = "jefe" | "guardia" | "agy" | "codex" | "claude" | "biblio" | "recepcion";
export interface AgentState { id: AgentId; working: boolean; desks: number; activity: string; model: string; tokens: number; paused?: boolean; seats?: AgySeat[] }
export interface QueueItem { planId: string; stepId: string; stepKey: string | null; description: string; adapter: string; status: "running" | "pending" | "paused"; project: string | null }
export interface PlanSummary { id: string; description: string; status: string; pauseReason: string | null; updatedAt: string }
export interface OfficeState { agents: AgentState[]; queue: QueueItem[]; plans: PlanSummary[]; generatedAt: string }
export interface OfficeInput {
  now: number;
  generatingPlans: { id: string; description: string }[];
  synthesisRunning: { id: string; description: string }[];
  steps: { planId: string; stepId: string; stepKey: string | null; description: string; adapter: string; model: string | null; status: string; guardPaused: boolean; project: string | null }[];
  chatRuns: { adapter: string; model: string | null; prompt: string }[];
  tokensByAdapter: Record<string, number>; // desde SERVER_STARTED_AT (runs + agy_usage)
  lastTierOrGuardAt: number | null; guardPausedCount: number;
  memoryIndexing: boolean; lastMemoryLoadingAt: number | null; memoryNotes: number;
  voiceActive: boolean; whisperState: string;
  recentPlans: PlanSummary[]; // últimos 8 por updated_at
  agySeats: AgySeat[]; // una por cuenta de agy habilitada (local + trabajadores)
  planProgress: Record<string, { done: number; total: number }>; // por planId de asientos que trabajan
}

const GUARD_WINDOW_MS = 8000;
const MEMORY_WINDOW_MS = 20000;
const QUEUE_MAX = 20;

export function buildOfficeState(i: OfficeInput): OfficeState {
  const { now } = i;
  const agents: AgentState[] = [];
  // shortcut: planner/síntesis no guardan tokens por separado; sumar plans.used_tokens si se quiere el del jefe
  const idle = (id: AgentId, activity: string, model: string): AgentState => ({ id, working: false, desks: 1, activity, model, tokens: 0 });

  const boss = i.generatingPlans[0] ? `planeando: ${i.generatingPlans[0].description}` : i.synthesisRunning[0] ? `sintetizando: ${i.synthesisRunning[0].description}` : null;
  agents.push({ ...idle("jefe", boss ?? "libre", "Opus 5.5"), working: boss !== null });

  const guardOn = i.lastTierOrGuardAt !== null && now - i.lastTierOrGuardAt <= GUARD_WINDOW_MS;
  const paused = i.guardPausedCount > 0;
  agents.push({ ...idle("guardia", paused ? `pausó ${i.guardPausedCount} paso(s)` : guardOn ? "revisando" : "libre", "JEV"), working: guardOn, paused });

  for (const id of ["agy", "codex", "claude"] as const satisfies readonly AdapterType[]) {
    const running = i.steps.filter((s) => s.adapter === id && s.status === "running");
    const chats = i.chatRuns.filter((r) => r.adapter === id);
    // chat/análisis/voz de agy no toman lease: corren en la cuenta local, así que su asiento trabaja.
    const loose = id === "agy" ? (chats.length ? "chat" : i.voiceActive ? "voz" : null) : null;
    const seats = id === "agy" && i.agySeats.length
      ? i.agySeats.map((x) => ({ ...x, progress: x.planId ? (i.planProgress[x.planId] ?? null) : null }))
        .map((x) => (x.local && !x.working && loose ? { ...x, working: true, activity: loose } : x))
      : undefined;
    // Con asientos, un escritorio por cuenta; el resto de adaptadores, uno por paso/chat en curso.
    const n = seats ? Math.max(seats.length, 1) : running.length + chats.length;
    const working = seats ? seats.some((x) => x.working) || running.length + chats.length > 0 : n > 0;
    agents.push({
      id, working, desks: Math.min(4, Math.max(1, n)), ...(seats ? { seats } : {}),
      activity: running[0]?.description ?? (chats.length ? "chat" : "libre"),
      model: running[0]?.model ?? chats[0]?.model ?? MODEL_CATALOG[id].defaultModel,
      tokens: i.tokensByAdapter[id] ?? 0,
    });
  }

  const searching = i.lastMemoryLoadingAt !== null && now - i.lastMemoryLoadingAt <= MEMORY_WINDOW_MS;
  agents.push({
    ...idle("biblio", i.memoryIndexing ? "indexando" : searching ? "buscando notas" : `${i.memoryNotes} notas · listo`, "bge-m3"),
    working: i.memoryIndexing || searching,
  });

  const listening = i.voiceActive || i.whisperState === "starting" || i.whisperState === "warming";
  agents.push({ ...idle("recepcion", listening ? "escuchando" : "libre", "Whisper"), working: listening });

  const toItem = (s: OfficeInput["steps"][number]): QueueItem => ({
    planId: s.planId, stepId: s.stepId, stepKey: s.stepKey, description: s.description, adapter: s.adapter,
    status: s.guardPaused ? "paused" : (s.status as "running" | "pending"), project: s.project,
  });
  const queue = [...i.steps.filter((s) => s.status === "running"), ...i.steps.filter((s) => s.status === "pending")].slice(0, QUEUE_MAX).map(toItem);

  return { agents, queue, plans: i.recentPlans, generatedAt: new Date(now).toISOString() };
}

let lastTierOrGuardAt: number | null = null;
let lastMemoryLoadingAt: number | null = null;

/** Guarda cuándo ocurrieron los últimos eventos que animan a la guardia y a la bibliotecaria. */
export function startOfficeEventTracker(): void {
  onBroadcast((e) => {
    const ev = e as { type: string; source?: string };
    if (ev.type === "plan:tier" || ev.type === "plan:guard") lastTierOrGuardAt = Date.now();
    else if (ev.type === "plan:memory" && ev.source === "loading") lastMemoryLoadingAt = Date.now();
  });
}

const num = (rows: { n: unknown }[]) => Number(rows[0]?.n ?? 0);

export async function collectOfficeInput(now: number = Date.now()): Promise<OfficeInput> {
  const generatingPlans = await db.all<{ id: string; description: string }>(sql`SELECT id, description FROM plans WHERE status = 'generating'`);
  const synthesisRunning = await db.all<{ id: string; description: string }>(sql`SELECT id, description FROM plans WHERE synthesis_status = 'running'`);
  const stepRows = await db.all<{ planId: string; stepId: string; stepKey: string | null; description: string; adapter: string; model: string | null; status: string; guardPaused: number; project: string | null }>(sql`
    SELECT s.plan_id AS planId, s.id AS stepId, s.step_key AS stepKey, s.description, s.adapter, s.model, s.status,
           (p.pause_reason = 'guard' AND s.status = 'pending' AND s.guard_flags IS NOT NULL) AS guardPaused,
           pr.name AS project
    FROM plan_steps s JOIN plans p ON p.id = s.plan_id LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE s.status IN ('running', 'pending') AND (p.status = 'running' OR p.pause_reason IS NOT NULL)
    ORDER BY s.step_index`);
  const steps = stepRows.map((r) => ({ ...r, guardPaused: !!r.guardPaused }));
  // Las ejecuciones de pasos de plan ya cuentan como pasos; aquí solo el chat suelto.
  const chatRuns = await db.all<{ adapter: string; model: string | null; prompt: string }>(sql`
    SELECT adapter, model, prompt FROM runs WHERE status = 'running'
    AND id NOT IN (SELECT run_id FROM plan_steps WHERE run_id IS NOT NULL AND status = 'running')`);
  const tokensByAdapter: Record<string, number> = {};
  const tok = await db.all<{ adapter: string; n: number }>(sql`
    SELECT adapter, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS n
    FROM runs WHERE datetime(started_at) >= datetime(${SERVER_STARTED_AT}) GROUP BY adapter`);
  for (const r of tok) tokensByAdapter[r.adapter] = Number(r.n);
  const analysis = await db.all<{ n: number }>(sql`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS n FROM agy_usage WHERE source = 'analysis' AND at >= ${SERVER_STARTED_AT}`);
  tokensByAdapter.agy = (tokensByAdapter.agy ?? 0) + num(analysis);
  const guardPausedCount = steps.filter((s) => s.guardPaused).length;
  const notes = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM vault_notes`);
  const recentPlans = await db.all<PlanSummary>(sql`
    SELECT id, description, status, pause_reason AS pauseReason, updated_at AS updatedAt FROM plans ORDER BY updated_at DESC LIMIT 8`);
  const seats = await agySeats(now);
  const planProgress: Record<string, { done: number; total: number }> = {};
  const ids = [...new Set(seats.filter((s) => s.working && s.planId).map((s) => s.planId!))];
  const rows = ids.length
    ? await db.select({ planId: schema.planSteps.planId, status: schema.planSteps.status }).from(schema.planSteps).where(inArray(schema.planSteps.planId, ids))
    : [];
  for (const r of rows) {
    const p = (planProgress[r.planId] ??= { done: 0, total: 0 });
    p.total++;
    if (r.status === "succeeded" || r.status === "skipped") p.done++;
  }
  return {
    now, generatingPlans, synthesisRunning, steps, chatRuns, tokensByAdapter,
    lastTierOrGuardAt, guardPausedCount,
    memoryIndexing: isIndexing(), lastMemoryLoadingAt, memoryNotes: num(notes),
    voiceActive: activeAssistant() !== null, whisperState: whisper.status(), recentPlans, agySeats: seats, planProgress,
  };
}
