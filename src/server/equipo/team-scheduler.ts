import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import pino from "pino";
import { db, schema } from "../../db/index.js";
import { broadcast } from "../ws.js";
import { runPlanStep, type StepOutcome } from "../plan-runner.js";
import { agyAvailability, cwdAllowsWorkers, parallelLimit, pickWorker, type AgyLease } from "../agy-workers.js";
import { guardStep } from "../plan-guard.js";
import { planCwd } from "../plan-create.js";
import { budgetExceeded, extendBudget } from "../plan-dag.js";
import { getRole } from "../roles.js";
import { memoryConfig } from "../../memory/config.js";
import { writePlanNote } from "../../memory/plan-note.js";
import { ESPERA_CUENTA_MS, HUMANO, JEFE_ROL, MAX_TURNOS_TAREA, COMENTARIOS_EN_PROMPT, orqApi } from "./constants.js";
import { issueRunToken, revokePlanTokens, revokeRunToken } from "./tokens.js";
import {
  cancelPlanWakeups, claimWakeup, enqueueWakeup, finishWakeup, hasQueued, hasQueuedFor, parsePayload, requeueWakeup, type WakeupRow,
} from "./wakeups.js";
import {
  addComment, ancestorsOf, TeamError, authorLabel, childSummary, childrenOf, commentsByIds, commentsFor, createGoal, getStep, onTaskTerminal,
  parseIds, roleCatalog, type StepRow,
} from "./tasks.js";
import { buildTurnPrompt, JEFE_BODY, JEFE_NOMBRE, loadEquipoGuide } from "./prompts.js";

const log = pino({ name: "team-scheduler" });

/** cancelled: el usuario canceló. stopped: la meta ya cerró o falló; los turnos que aún terminan solo se cancelan. */
interface TeamRun { cancelled: boolean; stopped: boolean; kills: Set<() => void>; bell: (() => void) | null }
const active = new Map<string, TeamRun>();

const now = () => new Date().toISOString();
const emit = (e: Record<string, unknown>) => broadcast({ ...e, timestamp: now() } as any);
const P = schema.plans, S = schema.planSteps;

async function getPlan(id: string) {
  const [p] = await db.select().from(P).where(eq(P.id, id));
  if (!p) throw new Error(`Meta ${id} no existe`);
  return p;
}
async function setPlan(id: string, patch: Partial<typeof P.$inferInsert>) {
  await db.update(P).set({ ...patch, updatedAt: now() }).where(eq(P.id, id));
}
const GOAL_DONE = ["completed", "failed", "cancelled"] as const;
/** Escribe solo si la meta sigue abierta: un cierre o una cancelación no se pisan. true si escribió. */
async function setPlanOpen(id: string, patch: Partial<typeof P.$inferInsert>): Promise<boolean> {
  const r = await db.update(P).set({ ...patch, updatedAt: now() }).where(and(eq(P.id, id), notInArray(P.status, [...GOAL_DONE]))).returning({ id: P.id });
  return r.length > 0;
}
/** Pasos aún abiertos (pending/running) de la meta → cancelled. */
async function cancelOpenSteps(planId: string): Promise<void> {
  await db.update(S).set({ status: "cancelled", finishedAt: now() }).where(and(eq(S.planId, planId), inArray(S.status, ["pending", "running"])));
}
const killAll = (run: TeamRun) => { for (const k of run.kills) { try { k(); } catch { /* ya terminó */ } } };
async function setStep(id: string, patch: Partial<typeof S.$inferInsert>) {
  await db.update(S).set(patch).where(eq(S.id, id));
}
const ring = (run: TeamRun) => { const b = run.bell; run.bell = null; b?.(); };
/** Espera a que termine un turno, llegue un kick o pasen `ms` (por si se liberó una cuenta). */
function waitBell(run: TeamRun, inFlight: Map<string, Promise<void>>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); if (run.bell === done) run.bell = null; resolve(); }
    run.bell = done;
    for (const p of inFlight.values()) void p.then(done, done);
  });
}

export const isTeamRunning = (planId: string): boolean => active.has(planId);

/** Despierta el bucle de la meta, o lo arranca si no está corriendo. */
export function kickTeam(planId: string): void {
  const run = active.get(planId);
  if (run) { ring(run); return; }
  void runTeam(planId).catch((err) => log.error({ err, planId }, "runTeam falló"));
}

async function addUsedTokens(planId: string, tokens: number) {
  if (tokens <= 0) return;
  // Incremento atómico: turnos en paralelo no se pisan la suma.
  await db.update(P).set({ usedTokens: sql`${P.usedTokens} + ${tokens}` }).where(eq(P.id, planId));
  const p = await getPlan(planId);
  emit({ type: "team:goal", planId, status: p.status, usedTokens: p.usedTokens });
}

/** La meta falla de forma inesperada: se matan sus turnos y se cierra con el error (nunca se queda colgada). */
async function failGoal(run: TeamRun, planId: string, err: unknown): Promise<void> {
  log.error({ err, planId }, "La meta falló de forma inesperada");
  run.stopped = true;
  killAll(run);
  ring(run);
  try {
    if (!(await setPlanOpen(planId, { status: "failed", pauseReason: null, errorMessage: String((err as Error)?.message ?? err).slice(0, 2000) }))) return;
    await cancelPlanWakeups(planId);
    await revokePlanTokens(planId);
    await cancelOpenSteps(planId);
  } catch { return; /* sin base */ }
  emit({ type: "team:goal", planId, status: "failed" });
}

export async function pauseTeam(planId: string, reason: "quota" | "budget" | "guard" | "manual"): Promise<void> {
  if (active.get(planId)?.cancelled) return;
  if (!(await setPlanOpen(planId, { status: "pending", pauseReason: reason }))) return; // ya cerrada o cancelada
  emit({ type: "team:goal", planId, status: "pending", paused: reason });
  const run = active.get(planId);
  if (run) ring(run);
}

export async function continueTeam(planId: string): Promise<void> {
  const p = await getPlan(planId);
  if (p.mode !== "equipo" || ["completed", "failed", "cancelled"].includes(p.status)) return;
  const patch: Partial<typeof P.$inferInsert> = { pauseReason: null, status: "running" };
  if (p.pauseReason === "budget" || budgetExceeded(p.usedTokens, p.budgetTokens)) patch.budgetTokens = extendBudget(p.budgetTokens, p.usedTokens);
  if (!(await setPlanOpen(planId, patch))) return;
  emit({ type: "team:goal", planId, status: "running" });
  kickTeam(planId);
}

export async function cancelTeam(planId: string): Promise<void> {
  const [p] = await db.select({ status: P.status }).from(P).where(eq(P.id, planId));
  if (!p || (GOAL_DONE as readonly string[]).includes(p.status)) return; // una meta cerrada no se reescribe
  const run = active.get(planId);
  if (run) { run.cancelled = true; killAll(run); ring(run); }
  await cancelPlanWakeups(planId);
  await revokePlanTokens(planId);
  await cancelOpenSteps(planId);
  if (!(await setPlanOpen(planId, { status: "cancelled", pauseReason: null }))) return;
  emit({ type: "team:goal", planId, status: "cancelled" });
}

export async function approveTaskGuard(planId: string, stepId: string): Promise<boolean> {
  const s = await getStep(stepId);
  if (!s || s.planId !== planId || !s.guardFlags) return false;
  await setStep(stepId, { guardApproved: 1 });
  await continueTeam(planId);
  return true;
}

export async function startGoal(input: { pedido: unknown; projectId?: string | null }): Promise<{ planId: string }> {
  const { planId } = await createGoal(input);
  kickTeam(planId);
  return { planId };
}

export async function humanComment(planId: string, stepId: string, texto: unknown): Promise<{ id: string }> {
  const [meta] = await db.select({ mode: P.mode }).from(P).where(eq(P.id, planId));
  if (meta?.mode !== "equipo") throw new TeamError(404, "La meta no existe");
  const r = await addComment(planId, stepId, HUMANO, texto);
  const p = await getPlan(planId);
  if (!p.pauseReason && !["completed", "failed", "cancelled"].includes(p.status)) kickTeam(planId);
  return r;
}

/**
 * Al arrancar el servidor, en toda meta de equipo abierta (corriendo o pendiente, pausada o no): los despertares
 * tomados vuelven a la cola, los turnos que corrían vuelven con "continuar" y los tokens se revocan. Solo siguen
 * las que no están pausadas.
 */
export async function resumeTeamsOnBoot(): Promise<void> {
  const W = schema.teamWakeups;
  const metas = await db.select().from(P).where(and(eq(P.mode, "equipo"), inArray(P.status, ["running", "pending"])));
  for (const m of metas) {
    if (active.has(m.id)) continue;
    for (const w of await db.select({ id: W.id }).from(W).where(and(eq(W.planId, m.id), eq(W.status, "tomado")))) await requeueWakeup(w.id);
    const corriendo = await db.select().from(S).where(and(eq(S.planId, m.id), eq(S.status, "running")));
    for (const s of corriendo) {
      await setStep(s.id, { status: "pending" });
      await enqueueWakeup(m.id, s.id, "continuar");
    }
    await revokePlanTokens(m.id);
    if (!m.pauseReason) kickTeam(m.id);
  }
}

function roleBlockFor(step: StepRow): { nombre: string; body: string; escribe: boolean } {
  if (step.role === JEFE_ROL) return { nombre: JEFE_NOMBRE, body: JEFE_BODY, escribe: true };
  const r = step.role ? getRole(step.role) : null;
  return r
    ? { nombre: r.nombre, body: r.body, escribe: r.escribe !== false }
    : { nombre: step.role ?? "agente", body: 'Termina con una sola línea de estado: <<<ESTADO terminado>>>, <<<ESTADO bloqueado {"detalle":"…"}>>> o <<<ESTADO necesita {"detalle":"…"}>>>.', escribe: step.readOnly !== 1 };
}

async function promptFor(pedido: string, step: StepRow, w: WakeupRow, resume: boolean): Promise<string> {
  const payload = parsePayload(w.payload);
  const role = roleBlockFor(step);
  const kids = await childrenOf(step.id);
  const hijas = (resume ? kids.filter((k) => payload.childIds.includes(k.id)) : kids)
    .map((k) => ({ rol: k.role ?? "?", titulo: k.description, resumen: childSummary(k) }));
  const rows = resume ? await commentsByIds(payload.commentIds) : await commentsFor(step.id, COMENTARIOS_EN_PROMPT);
  const comentarios = await Promise.all(rows.map(async (c) => ({ autor: await authorLabel(c.author), texto: c.body })));
  const ancestros = resume ? [] : (await ancestorsOf(step)).map((a) => ({ rol: a.role ?? "?", titulo: a.description, resultado: a.result }));
  return buildTurnPrompt({
    pedido, tarea: { titulo: step.description, instrucciones: step.prompt }, roleBlock: role, escribe: role.escribe,
    catalogo: step.role === JEFE_ROL ? roleCatalog() : undefined, ancestros, hijas, comentarios,
    motivos: payload.reasons, resume,
  }, loadEquipoGuide());
}

type Start = { kind: "started"; promise: Promise<void> } | { kind: "skip" } | { kind: "wait" } | { kind: "pause" };

async function startTurn(run: TeamRun, planId: string, pedido: string, w: WakeupRow, cwd: string, localOnly: boolean): Promise<Start> {
  const step = await getStep(w.stepId);
  if (!step || step.planId !== planId) { await finishWakeup(w.id, "cancelado"); return { kind: "skip" }; }

  if (step.turns >= MAX_TURNOS_TAREA) {
    await setStep(step.id, { status: "failed", errorMessage: `demasiados turnos (${MAX_TURNOS_TAREA})`, statusDetail: "demasiados turnos", finishedAt: now() });
    await finishWakeup(w.id, "hecho");
    emit({ type: "team:task", planId, stepId: step.id, status: "failed" });
    await afterTerminal(run, planId, step.id);
    return { kind: "skip" };
  }

  let agyLease: AgyLease | undefined;
  let resume = !!step.sessionId;
  if (step.adapter === "agy") {
    const preferida = step.sessionId && step.accountId ? step.accountId : null;
    let lease = preferida ? await pickWorker(Date.now(), { localOnly, only: preferida }) : null;
    if (!lease && preferida) {
      if (Date.now() - Date.parse(w.createdAt) < ESPERA_CUENTA_MS) { await requeueWakeup(w.id); return { kind: "wait" }; }
      resume = false; // la cuenta del turno anterior no se libera: sesión nueva en otra
    }
    if (!lease) lease = await pickWorker(Date.now(), { localOnly });
    if (!lease) {
      await requeueWakeup(w.id);
      if (!run.cancelled && (await agyAvailability(Date.now(), { localOnly })).usable === 0) { await pauseTeam(planId, "quota"); return { kind: "pause" }; }
      return { kind: "wait" };
    }
    agyLease = lease;
    // Misma regla que runPlanStep: la sesión solo se retoma en la cuenta que la creó (sin cuenta = la local).
    resume &&= lease.accountId === step.accountId || (step.accountId == null && !lease.worker);
  }

  let prompt: string;
  let token: string;
  try {
    // Guardia (ya con cuenta: mientras espera cuenta no se consulta a JEV en cada vuelta): solo tareas que
    // escriben y no aprobadas; evalúa sus instrucciones originales.
    if (step.writes === 1 && step.guardApproved !== 1) {
      const guard = await guardStep({ prompt: step.prompt, deps: [], projectPath: cwd });
      if (guard.flagged) {
        agyLease?.release();
        await setStep(step.id, { guardFlags: JSON.stringify(guard.flags) });
        emit({ type: "team:task", planId, stepId: step.id, status: "pending", guard: guard.flags });
        await requeueWakeup(w.id);
        if (!run.cancelled) await pauseTeam(planId, "guard");
        return { kind: "pause" };
      }
      if (step.guardFlags) await setStep(step.id, { guardFlags: null });
    }
    if (!resume && step.sessionId) await setStep(step.id, { sessionId: null });
    prompt = await promptFor(pedido, step, w, resume);
    token = await issueRunToken({ planId, stepId: step.id });
    // En equipo la aprobación de la guardia queda en la tarea: sus instrucciones no cambian entre turnos.
    await setStep(step.id, {
      status: "running", startedAt: now(), turns: step.turns + 1, errorMessage: null,
      ...(step.guardApproved === 1 && step.guardFlags ? { guardFlags: null } : {}),
    });
  } catch (err) {
    agyLease?.release();
    throw err;
  }
  emit({ type: "team:task", planId, stepId: step.id, status: "running" });

  const kills: (() => void)[] = [];
  const promise = runPlanStep({
    planId, stepId: step.id, cwd, promptOverride: prompt, agyLease,
    extraEnv: { ORQ_API: orqApi(), ORQ_TAREA: step.id, ORQ_TOKEN: token },
    onKillRegistered: (k) => { kills.push(k); run.kills.add(k); if (run.cancelled) { try { k(); } catch { /* ya terminó */ } } },
  })
    .catch(async (err: Error): Promise<StepOutcome> => {
      log.error({ err, stepId: step.id }, "runPlanStep lanzó una excepción");
      await setStep(step.id, { status: "failed", errorMessage: err.message, finishedAt: now() });
      return { status: "failed", tokensUsed: 0 };
    })
    .then(async (outcome) => {
      for (const k of kills) run.kills.delete(k);
      await revokeRunToken(token);
      await afterTurn(run, planId, step.id, w, outcome);
    })
    .catch((err) => failGoal(run, planId, err));
  return { kind: "started", promise };
}

async function afterTurn(run: TeamRun, planId: string, stepId: string, w: WakeupRow, outcome: StepOutcome): Promise<void> {
  await addUsedTokens(planId, outcome.tokensUsed);
  const step = (await getStep(stepId))!;
  if (run.cancelled || run.stopped) {
    await finishWakeup(w.id, "cancelado");
    await setStep(stepId, { status: "cancelled", finishedAt: now() });
    return;
  }
  if (outcome.status === "requeued" || outcome.status === "paused_quota") {
    await setStep(stepId, { turns: Math.max(0, step.turns - 1) });
    await requeueWakeup(w.id);
    if (outcome.status === "paused_quota") await pauseTeam(planId, "quota");
    ring(run);
    return;
  }
  await finishWakeup(w.id, "hecho");
  // Espera hijas (blocked_by no vacío) o ya llegó otro despertar para ella: queda en la bandeja (no terminal).
  // onTaskTerminal encola el despertar del padre ANTES de vaciar blocked_by: aquí siempre se ve uno de los dos.
  if (parseIds(step.blockedBy).length > 0 || await hasQueuedFor(stepId)) {
    await setStep(stepId, { status: "pending", errorMessage: null });
    emit({ type: "team:task", planId, stepId, status: "pending" });
    ring(run);
    return;
  }
  emit({ type: "team:task", planId, stepId, status: step.status });
  await afterTerminal(run, planId, stepId);
  ring(run);
}

async function afterTerminal(run: TeamRun, planId: string, stepId: string): Promise<void> {
  const step = (await getStep(stepId))!;
  if (step.parentStepId) { await onTaskTerminal(planId, stepId); return; }
  await closeGoal(run, planId, step);
  ring(run);
}

/** La raíz terminó: la meta se cierra con su respuesta (o falla); lo que quedaba pendiente o corriendo se cancela. */
async function closeGoal(run: TeamRun, planId: string, root: StepRow): Promise<void> {
  if (run.cancelled || (GOAL_DONE as readonly string[]).includes((await getPlan(planId)).status)) return;
  run.stopped = true;
  killAll(run); // turnos de hijas aún en curso: su afterTurn las deja canceladas
  await cancelPlanWakeups(planId);
  await revokePlanTokens(planId);
  await cancelOpenSteps(planId);
  if (root.status === "succeeded") {
    if (!(await setPlanOpen(planId, { status: "completed", pauseReason: null, synthesis: root.result, synthesisStatus: "succeeded" }))) return;
    emit({ type: "team:goal", planId, status: "completed" });
    await saveNote(planId, root.result ?? "");
  } else {
    if (!(await setPlanOpen(planId, { status: "failed", pauseReason: null, errorMessage: (root.errorMessage ?? root.statusDetail ?? "la tarea del Jefe falló").slice(0, 2000) }))) return;
    emit({ type: "team:goal", planId, status: "failed" });
  }
}

async function saveNote(planId: string, answer: string): Promise<void> {
  try {
    const plan = await getPlan(planId);
    const project = plan.projectId ? (await db.select().from(schema.projects).where(eq(schema.projects.id, plan.projectId)))[0] : undefined;
    const rows = await db.select().from(S).where(eq(S.planId, planId));
    const cfg = memoryConfig();
    const rel = writePlanNote(cfg.vaultPath, cfg.writeDir, {
      planId, description: plan.description, tier: null, usedTokens: plan.usedTokens,
      projectName: project?.name ?? null, projectPath: project?.path ?? null, projectNotePath: null,
      steps: rows.sort((a, b) => a.stepIndex - b.stepIndex).map((r) => ({ key: r.stepKey ?? r.id.slice(0, 6), description: `${r.role ?? ""} · ${r.description}`, adapter: r.adapter, status: r.status })),
      answer, memory: null, memoryNotes: [], date: new Date(),
    });
    await setPlan(planId, { memoryNotePath: rel });
  } catch (err) {
    log.error({ err, planId }, "No se pudo escribir la nota de la meta en Cerebro");
  }
}

/** Bucle de una meta: toma despertares mientras haya capacidad, hasta cerrar, pausar o quedar sin trabajo. */
export async function runTeam(planId: string): Promise<void> {
  if (active.has(planId)) return;
  const run: TeamRun = { cancelled: false, stopped: false, kills: new Set(), bell: null };
  active.set(planId, run);
  const inFlight = new Map<string, Promise<void>>();
  let ran = false; // el bucle llegó a correr: solo entonces el finally puede rearrancarlo
  try {
    const p0 = await getPlan(planId);
    if (p0.mode !== "equipo" || p0.pauseReason || ["completed", "failed", "cancelled"].includes(p0.status)) return;
    const cwd = await planCwd(p0);
    const localOnly = !cwdAllowsWorkers(cwd);
    // Una cancelación durante planCwd gana: no se reabre la meta.
    if (run.cancelled || !(await setPlanOpen(planId, { status: "running" }))) return;
    ran = true;
    emit({ type: "team:goal", planId, status: "running" });

    for (;;) {
      if (run.cancelled || run.stopped) break;
      const plan = await getPlan(planId);
      if (plan.status !== "running" || plan.pauseReason) break;
      const limit = (await parallelLimit()) + 1; // +1: el Jefe corre en claude, sin cuenta agy
      let stop = false;
      const waiting = new Set<string>(); // esperan cuenta en esta vuelta: no tapan los despertares de atrás
      while (inFlight.size < limit) {
        if (run.cancelled || run.stopped) { stop = true; break; }
        if (budgetExceeded((await getPlan(planId)).usedTokens, plan.budgetTokens)) { await pauseTeam(planId, "budget"); stop = true; break; }
        const w = await claimWakeup(planId, new Set([...inFlight.keys(), ...waiting]));
        if (!w) break;
        const r = await startTurn(run, planId, plan.description, w, cwd, localOnly);
        if (r.kind === "started") {
          inFlight.set(w.stepId, r.promise);
          void r.promise.finally(() => inFlight.delete(w.stepId));
        } else if (r.kind === "pause") { stop = true; break; }
        else if (r.kind === "wait") waiting.add(w.stepId);
      }
      if (stop) break;
      if (inFlight.size === 0 && !(await hasQueued(planId))) {
        const p = await getPlan(planId);
        if (p.status === "running") { await setPlan(planId, { status: "pending" }); emit({ type: "team:goal", planId, status: "pending" }); }
        break;
      }
      await waitBell(run, inFlight, 5000);
    }
    if (inFlight.size) await Promise.allSettled(inFlight.values());
  } catch (err) {
    await failGoal(run, planId, err);
  } finally {
    active.delete(planId);
    try {
      // A5: salir cancelado deja la meta cancelada aunque un turno o una pausa hayan escrito después.
      if (run.cancelled) await setPlan(planId, { status: "cancelled", pauseReason: null });
      else if (ran && !run.stopped) {
        // Llegó un despertar o un "continuar" mientras el bucle drenaba sus turnos: se vuelve a arrancar
        // (sin trabajo, el bucle nuevo deja la meta en pending).
        const p = await getPlan(planId);
        if (p.mode === "equipo" && !p.pauseReason && (p.status === "running" || (p.status === "pending" && await hasQueued(planId)))) kickTeam(planId);
      }
    } catch { /* meta borrada */ }
  }
}
