import { randomUUID } from "node:crypto";
import { db, schema } from "../../db/index.js";
import { broadcast, onBroadcast } from "../../server/ws.js";
import { getActiveAccount, recordAgyCall } from "../../server/agy-accounts.js";
import { createPlan as realCreatePlan, startPlanIfAllowed } from "../../server/plan-create.js";
import { buildMemorySection, retrieveMemory } from "../../memory/retrieve.js";
import { queryEmbedder } from "../../memory/query-embedder.js";
import { writeTalkNote } from "../../memory/talk-note.js";
import { memoryConfig } from "../../memory/config.js";
import type { AdapterExecutionResult, WsEvent } from "../../lib/types.js";
import { createAgySession, type AgyTurnResult } from "./agy-session.js";
import {
  askProjectQuestion, buildAssistantSystemPrompt, buildTurnMessage, confirmQuestion, createSpokenFilter, extractAction,
  isClosingPhrase, isConfirmation, withServerQuestion,
} from "./text.js";
import { saveTurn } from "./persist.js";
import { disposeAllPlanWatchers, handlePlanEvent, watchPlanReady } from "./plan-events.js";

export type AssistantDeps = {
  agy?: () => ReturnType<typeof createAgySession>;
  now?: () => number;
  /** Espera máxima de plan:ready tras confirmar (10 min por defecto). */
  planReadyTimeoutMs?: number;
  createPlan?: typeof realCreatePlan;
  startPlan?: typeof startPlanIfAllowed;
  retrieve?: typeof retrieveMemory;
  writeNote?: typeof writeTalkNote;
};

/** Error de la API pública con el código HTTP que la ruta debe devolver. */
export class AssistantError extends Error {
  constructor(message: string, readonly status: 404 | 409) {
    super(message);
  }
}

const IDLE_MS = 10 * 60_000;
const MEMORY_TIMEOUT_MS = 5_000;
const SUMMARY_TIMEOUT_MS = 30_000;
const RETRY_HISTORY_TURNS = 6;
const SUMMARY_PROMPT = "Resume esta plática en 3 a 5 oraciones, en español, para una nota personal. Sin markdown.";

const TEXT_QUOTA = "Se acabó la cuota de esta cuenta de Antigravity; cámbiala en el panel.";
const TEXT_LOST = "Perdí la conexión con Antigravity.";
const TEXT_BYE = "¡Hasta luego!";
const TEXT_PREPARING = "Va, lo estoy preparando; te aviso cuando arranque.";
const TEXT_STARTED = "Listo, arranqué el plan. Te aviso cuando termine.";
const TEXT_CRITICAL = "Lo preparé, pero es un plan crítico: apruébalo en la pantalla.";
const TEXT_NEEDS_APPROVAL = "Lo preparé; apruébalo en la pantalla para arrancarlo.";
const TEXT_PLAN_FAILED = "No pude crear el plan.";

type Agy = ReturnType<typeof createAgySession>;
type Project = { id: string; name: string; path: string };
type Session = {
  id: string;
  conversationId: string;
  projectId: string | null;
  deps: Required<AssistantDeps>;
  agy: Agy;
  /** Todo agy que lanzó la sesión: al terminar se cierran todos. */
  agys: Set<Agy>;
  warmed: boolean;
  busy: boolean;
  ended: boolean;
  /** Acción propuesta por agy y repetida por el servidor; solo la confirma la frase siguiente. */
  pending: { pedido: string; projectId: string } | null;
  /** Turno en curso y, si el usuario lo interrumpió, su id (su acción no se arma). */
  turnId: string | null;
  interruptedTurn: string | null;
  turns: { user: string; assistant: string }[];
  plans: { id: string; description: string }[];
  syntheses: Map<string, string>;
  idleTimer: NodeJS.Timeout | null;
  unsub: () => void;
};

let current: Session | null = null;

const nowIso = () => new Date().toISOString();
const emit = (e: Record<string, unknown>) => broadcast({ ...e, timestamp: nowIso() } as unknown as WsEvent);
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, " ").trim();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })])
    .finally(() => timer && clearTimeout(timer));
}

async function listProjects(): Promise<Project[]> {
  try {
    return await db.select({ id: schema.projects.id, name: schema.projects.name, path: schema.projects.path }).from(schema.projects);
  } catch {
    return [];
  }
}

function touch(s: Session) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => void endSession(s, "idle"), IDLE_MS);
  s.idleTimer.unref?.();
}

/** Llama a agy y registra el consumo en la cuenta activa (nunca lanza). */
async function sendRecorded(s: Session, agy: Agy, text: string, onDelta: (d: string) => void): Promise<AgyTurnResult> {
  const r = await agy.send(text, onDelta);
  try {
    const account = await getActiveAccount();
    if (account) {
      const result: AdapterExecutionResult = {
        exitCode: r.ok ? 0 : 1, signal: null, timedOut: false, stdout: "", stderr: "", summary: "",
        sessionId: null, model: null, costUsd: 0, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        errorMessage: r.error ?? null, errorFamily: r.quota ? "quota_exhausted" : null, retryNotBefore: r.retryNotBefore,
      };
      await recordAgyCall(account.id, result, "voice", s.deps.now(), r.startedAt);
    }
  } catch (err) {
    console.error("[voz] no se pudo registrar el uso de agy:", (err as Error)?.message);
  }
  return r;
}

/** Segundo plano tras confirmar: crea el plan, espera plan:ready, lo arranca y lo anuncia (si la sesión sigue). */
async function prepareAndStart(s: Session, action: { pedido: string; projectId: string }): Promise<void> {
  const watcher = watchPlanReady(s.deps.planReadyTimeoutMs);
  let text = TEXT_PLAN_FAILED;
  let approvalPlanId: string | null = null;
  try {
    // Un plan de voz siempre corre en la carpeta de su proyecto: sin ella no se crea (nunca process.cwd()).
    if (!(await projectRow(action.projectId))?.path) throw new Error("el proyecto del plan ya no existe o no tiene carpeta");
    const { id } = await s.deps.createPlan({ description: action.pedido, projectId: action.projectId });
    s.plans.push({ id, description: action.pedido });
    const waited = await watcher.wait(id);
    if (waited === "aborted") return;
    if (waited === "ready") {
      // El usuario confirmó: se arranca aunque la sesión ya haya terminado (solo no se anuncia).
      // Sin JEV (tier por fallback) no se arranca solo: queda pendiente para aprobarlo en pantalla (I6).
      const result = await s.deps.startPlan(id, { requireJev: true });
      if (result === "started" || result === "running") text = TEXT_STARTED;
      else if (result === "needs-approval" || result === "needs-jev-approval") {
        text = result === "needs-approval" ? TEXT_CRITICAL : TEXT_NEEDS_APPROVAL;
        approvalPlanId = id;
      }
    }
  } catch (err) {
    console.error("[voz] no se pudo crear/arrancar el plan:", (err as Error)?.message);
  } finally {
    watcher.dispose();
  }
  if (!s.ended) {
    emit({
      type: "voice:assistant:announce", sessionId: s.id, text,
      ...(approvalPlanId ? { planId: approvalPlanId, needsApproval: true } : {}),
    });
  }
}

function closeQuietly(agy: Agy) {
  try {
    agy.close();
  } catch {
    /* ya cerrado */
  }
}

/** agy nuevo registrado en la sesión; si ya terminó, nace cerrado. */
function newAgy(s: Session): Agy {
  const agy = s.deps.agy();
  s.agys.add(agy);
  if (s.ended) closeQuietly(agy);
  return agy;
}

/* ---------- turnos ---------- */

async function projectRow(id: string | null): Promise<Project | null> {
  if (!id) return null;
  return (await listProjects()).find((p) => p.id === id) ?? null;
}

async function memoryFor(s: Session, utterance: string): Promise<string> {
  try {
    const project = await projectRow(s.projectId);
    const mem = await withTimeout(
      s.deps.retrieve({
        query: utterance,
        project: project ? { name: project.name, path: project.path } : null,
        embedder: queryEmbedder(),
        topNotes: 3,
        budgetChars: 6000,
      }),
      MEMORY_TIMEOUT_MS,
    );
    return mem && mem.source === "semantic" && mem.notes.length ? buildMemorySection(mem) : "";
  } catch {
    return "";
  }
}

/**
 * Proyecto del plan de voz. Un nombre explícito debe existir en la base (si no, null: se pregunta cuál).
 * Sin nombre (null/vacío) se usa el de la sesión, si existe. Nunca hay "carpeta por defecto".
 */
async function resolveProject(s: Session, name: string | null): Promise<{ projectId: string | null; projects: Project[] }> {
  const projects = (await listProjects()).filter((p) => p.path.trim());
  const wanted = name ? norm(name) : "";
  if (wanted) return { projectId: projects.find((p) => norm(p.name) === wanted)?.id ?? null, projects };
  const own = s.projectId ? projects.find((p) => p.id === s.projectId) : undefined;
  return { projectId: own?.id ?? null, projects };
}

async function finishTurn(
  s: Session,
  turnId: string,
  p: {
    utterance: string; speech: string; hasAction: boolean; ok: boolean; error?: string; r?: AgyTurnResult; emitDelta: boolean;
    final?: boolean; pedido?: string;
  },
) {
  if (s.ended && !p.final) return;
  if (p.emitDelta) emit({ type: "voice:assistant:delta", sessionId: s.id, turnId, delta: p.speech });
  const now = s.deps.now();
  await saveTurn({
    conversationId: s.conversationId,
    projectId: s.projectId,
    prompt: p.utterance,
    speech: p.speech,
    ok: p.ok,
    error: p.error,
    inputTokens: p.r?.inputTokens ?? 0,
    outputTokens: p.r?.outputTokens ?? 0,
    startedAt: p.r?.startedAt ?? now,
    now,
  });
  emit({
    type: "voice:assistant:turn-done", sessionId: s.id, turnId, speech: p.speech, hasAction: p.hasAction,
    ...(p.pedido ? { pedido: p.pedido } : {}),
    ...(p.error ? { error: p.error } : {}),
  });
}

function historyPrefix(s: Session, projects: Project[]): string {
  const last = s.turns.slice(-RETRY_HISTORY_TURNS).map((t) => `Usuario: ${t.user}\nAsistente: ${t.assistant}`).join("\n");
  return buildAssistantSystemPrompt(projects) + (last ? "\n\nPlática hasta ahora:\n" + last : "") + "\n\n";
}

async function normalTurn(s: Session, turnId: string, utterance: string) {
  const memory = await memoryFor(s, utterance);
  // Terminada mientras se buscaba la memoria: no se llama a agy (no se relanza un proceso huérfano).
  if (s.ended) return;
  const message = buildTurnMessage(utterance, memory);
  // A la UI solo llegan oraciones completas, sin la marca ni la pregunta de arranque de agy (ver I2).
  const newFilter = () => createSpokenFilter((delta) => {
    if (!s.ended) emit({ type: "voice:assistant:delta", sessionId: s.id, turnId, delta });
  });
  let spoken = newFilter();
  const onDelta = (delta: string) => spoken.push(delta);

  let r = await sendRecorded(s, s.agy, message, onDelta);
  // Sesión terminada a media llamada: el turno se resuelve en silencio (sin reintento ni eventos).
  if (s.ended) return;
  if (!r.ok && !r.quota) {
    // Un reintento: agy nuevo, con la plática reciente como texto.
    closeQuietly(s.agy);
    const projects = await listProjects();
    if (s.ended) return;
    s.agy = newAgy(s);
    spoken = newFilter();
    r = await sendRecorded(s, s.agy, historyPrefix(s, projects) + message, onDelta);
    if (s.ended) return;
  }

  if (!r.ok) {
    const speech = r.quota ? TEXT_QUOTA : TEXT_LOST;
    await finishTurn(s, turnId, { utterance, speech, hasAction: false, ok: false, error: r.error ?? "error", r, emitDelta: false });
    await endSession(s, "error");
    return;
  }

  const { speech: parsed, action } = extractAction(r.text);
  let speech = parsed || "Perdón, no supe qué responder.";
  let question: string | null = parsed ? null : speech;
  let pedido: string | undefined;
  if (action) {
    const { projectId, projects } = await resolveProject(s, action.proyecto);
    if (s.ended) return;
    if (projectId) {
      // El servidor repite el pedido: el "sí" siguiente se refiere a lo que de verdad se va a ejecutar.
      question = confirmQuestion(action.pedido);
      // Si el usuario interrumpió este turno no oyó la pregunta: no se arma nada.
      if (s.interruptedTurn !== turnId) {
        s.pending = { pedido: action.pedido, projectId };
        pedido = action.pedido;
      }
    } else {
      question = askProjectQuestion(projects.map((p) => p.name));
    }
    speech = withServerQuestion(parsed, question);
  }
  spoken.end(question);
  s.turns.push({ user: utterance, assistant: speech });
  await finishTurn(s, turnId, { utterance, speech, hasAction: pedido !== undefined, ok: true, r, emitDelta: false, pedido });
}

async function runTurn(s: Session, turnId: string, utterance: string) {
  try {
    // Toda frase nueva consume la acción pendiente: solo puede confirmarla la inmediata siguiente.
    const action = s.pending;
    s.pending = null;
    if (isClosingPhrase(utterance)) {
      await finishTurn(s, turnId, { utterance, speech: TEXT_BYE, hasAction: false, ok: true, emitDelta: true, final: true });
      s.busy = false; // el resumen de la nota necesita agy libre
      await endSession(s, "phrase");
      return;
    }
    if (action) {
      if (isConfirmation(utterance)) {
        void prepareAndStart(s, action);
        const speech = TEXT_PREPARING;
        s.turns.push({ user: utterance, assistant: speech });
        await finishTurn(s, turnId, { utterance, speech, hasAction: false, ok: true, emitDelta: true });
        return;
      }
    }
    await normalTurn(s, turnId, utterance);
  } catch (err) {
    console.error("[voz] turno fallido:", (err as Error)?.message);
    if (!s.ended) emit({
      type: "voice:assistant:turn-done", sessionId: s.id, turnId, speech: TEXT_LOST, hasAction: false,
      error: (err as Error)?.message ?? "error",
    });
  } finally {
    s.busy = false;
    if (s.turnId === turnId) s.turnId = null;
    if (!s.ended) touch(s);
  }
}

/* ---------- API pública ---------- */

// Los /start se atienden de uno en uno: dos arranques concurrentes no pueden dejar una sesión huérfana.
let startChain: Promise<unknown> = Promise.resolve();

export function startAssistant(
  input: { projectId: string | null },
  deps: AssistantDeps = {},
): Promise<{ sessionId: string; conversationId: string }> {
  const run = startChain.then(() => doStart(input, deps));
  startChain = run.catch(() => undefined);
  return run;
}

async function doStart(
  input: { projectId: string | null },
  deps: AssistantDeps,
): Promise<{ sessionId: string; conversationId: string }> {
  const now = deps.now ?? Date.now;
  const account = await getActiveAccount();
  if (!account) throw new AssistantError("No hay cuenta de Antigravity activa", 409);
  if (account.quotaBlockedUntil && Date.parse(account.quotaBlockedUntil) > now()) throw new AssistantError(TEXT_QUOTA, 409);
  if (current) await endSession(current, "user");

  const full: Required<AssistantDeps> = {
    agy: deps.agy ?? (() => createAgySession()),
    now,
    planReadyTimeoutMs: deps.planReadyTimeoutMs ?? 10 * 60_000,
    createPlan: deps.createPlan ?? realCreatePlan,
    startPlan: deps.startPlan ?? startPlanIfAllowed,
    retrieve: deps.retrieve ?? retrieveMemory,
    writeNote: deps.writeNote ?? writeTalkNote,
  };
  const s: Session = {
    id: randomUUID(),
    conversationId: randomUUID(),
    projectId: input.projectId,
    deps: full,
    agy: full.agy(),
    agys: new Set(),
    warmed: false,
    busy: false,
    ended: false,
    pending: null,
    turnId: null,
    interruptedTurn: null,
    turns: [],
    plans: [],
    syntheses: new Map(),
    idleTimer: null,
    unsub: () => {},
  };
  s.agys.add(s.agy);
  s.unsub = onBroadcast((e) => handlePlanEvent(s, e, emit));
  current = s;
  touch(s);

  // Calentamiento en segundo plano: prepara agy con el prompt de sistema; su respuesta se descarta
  // (nunca arma una acción). Si topa con la cuota, lo dice en voz y cierra la plática.
  void (async () => {
    const projects = await listProjects();
    const r = await sendRecorded(s, s.agy, buildAssistantSystemPrompt(projects) + "\n\nResponde solo: Listo.", () => {});
    s.warmed = true;
    if (r.quota && !s.ended) {
      emit({ type: "voice:assistant:announce", sessionId: s.id, text: TEXT_QUOTA });
      await endSession(s, "error");
    }
  })().catch(() => {}).finally(() => { s.warmed = true; });

  return { sessionId: s.id, conversationId: s.conversationId };
}

export async function assistantTurn(
  sessionId: string,
  utterance: string,
): Promise<{ turnId: string } | { error: string; status: 404 | 409 }> {
  const s = current;
  if (!s || s.id !== sessionId || s.ended) return { error: "Sesión no encontrada", status: 404 };
  if (s.busy) return { error: "Ya hay un turno en curso", status: 409 };
  s.busy = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  const turnId = randomUUID();
  s.turnId = turnId;
  void runTurn(s, turnId, utterance);
  return { turnId };
}

/** El usuario interrumpió: se descarta la acción pendiente y la que arme el turno en curso. */
export function interruptAssistant(sessionId: string): boolean {
  const s = current;
  if (!s || s.id !== sessionId || s.ended) return false;
  s.pending = null;
  if (s.busy && s.turnId) s.interruptedTurn = s.turnId;
  return true;
}

async function summarize(s: Session, reason: string): Promise<string> {
  const fallback = s.turns.slice(0, 3).map((t) => t.user.trim().replace(/[.!?]+$/, "")).join(". ") + ".";
  // Nunca con un turno en curso o el calentamiento pendiente: la cola respawnearía agy tras cerrarlo.
  if (reason === "error" || s.busy || !s.warmed || !s.agy.alive()) return fallback;
  try {
    const r = await withTimeout(sendRecorded(s, s.agy, SUMMARY_PROMPT, () => {}), SUMMARY_TIMEOUT_MS);
    const text = r && r.ok ? extractAction(r.text).speech : "";
    return text || fallback;
  } catch {
    return fallback;
  }
}

type EndReason = "user" | "phrase" | "idle" | "error";

export async function endAssistant(sessionId: string, reason: EndReason): Promise<{ notePath: string | null }> {
  const s = current;
  if (!s || s.id !== sessionId) return { notePath: null };
  return endSession(s, reason);
}

/** Cierra una sesión concreta (aunque ya no sea la actual): nota, agy, oyentes y evento `ended`. */
async function endSession(s: Session, reason: EndReason): Promise<{ notePath: string | null }> {
  if (s.ended) return { notePath: null };
  s.ended = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);

  let notePath: string | null = null;
  if (s.turns.length >= 2) {
    try {
      const summary = await summarize(s, reason);
      const cfg = memoryConfig();
      const project = await projectRow(s.projectId);
      notePath = s.deps.writeNote(cfg.vaultPath, cfg.talkDir, {
        date: new Date(s.deps.now()),
        summary,
        turns: s.turns,
        plans: s.plans,
        projectName: project?.name ?? null,
        projectNotePath: null,
      });
    } catch (err) {
      console.error("[voz] no se pudo escribir la nota de la plática:", (err as Error)?.message);
      notePath = null;
    }
  }

  for (const a of s.agys) closeQuietly(a);
  s.unsub();
  if (current === s) current = null;
  emit({ type: "voice:assistant:ended", sessionId: s.id, reason, notePath });
  return { notePath };
}

export function activeAssistant(): { sessionId: string; conversationId: string } | null {
  return current && !current.ended ? { sessionId: current.id, conversationId: current.conversationId } : null;
}

/** En el apagado del servidor: cierra agy y suelta temporizadores y oyentes (sin nota ni eventos). */
export function shutdownAssistant(): void {
  const s = current;
  current = null;
  disposeAllPlanWatchers();
  if (!s) return;
  s.ended = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.unsub();
  for (const a of s.agys) closeQuietly(a);
}
