import { toSpeechText } from "../text.js";
import type { WsEvent } from "../../lib/types.js";

const PLAN_READY_TIMEOUT_MS = 10 * 60_000;
const PAUSE_NAMES: Record<string, string> = { quota: "cuota", budget: "presupuesto", guard: "guardia" };

/** plan:ready / plan:error vistos (incluso antes de que createPlan responda). */
const planSignals = new Map<string, "ready" | "error">();
const signalWaiters = new Set<() => void>();

export function clearPlanSignals(): void {
  planSignals.clear();
}

type PlanCtx = { id: string; plans: { id: string }[]; syntheses: Map<string, string> };

/** Anuncios por voz de los planes de la sesión y registro de plan:ready/plan:error. */
export function handlePlanEvent(s: PlanCtx, e: WsEvent, emit: (e: Record<string, unknown>) => void) {
  const ev = e as unknown as { type: string; planId?: string; status?: string; synthesis?: string; paused?: string };
  if (!ev.planId) return;
  if (ev.type === "plan:ready" || ev.type === "plan:error") {
    planSignals.set(ev.planId, ev.type === "plan:ready" ? "ready" : "error");
    for (const w of [...signalWaiters]) w();
    return;
  }
  if (!s.plans.some((p) => p.id === ev.planId)) return;
  if (ev.type === "plan:synthesis" && ev.status === "succeeded" && typeof ev.synthesis === "string") {
    s.syntheses.set(ev.planId, ev.synthesis);
    return;
  }
  if (ev.type !== "plan:done") return;
  let text: string | null = null;
  if (ev.status === "completed") {
    const syn = s.syntheses.get(ev.planId);
    text = "El plan terminó" + (syn ? ": " + toSpeechText(syn, { summary: true }) : ".");
  } else if (ev.status === "pending" && ev.paused) {
    text = `El plan se pausó por ${PAUSE_NAMES[ev.paused] ?? ev.paused}; revísalo en la pantalla.`;
  } else if (ev.status === "failed") {
    text = "El plan falló; revísalo en la pantalla.";
  }
  if (text) emit({ type: "voice:assistant:announce", sessionId: s.id, text });
}

/** Espera plan:ready del plan (10 min máx.); false si falló o venció. */
export async function waitPlanReady(planId: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let wake: () => void = () => {};
  const waiter = () => wake();
  signalWaiters.add(waiter);
  try {
    const deadline = new Promise<void>((r) => { timer = setTimeout(r, PLAN_READY_TIMEOUT_MS); });
    while (!planSignals.has(planId)) {
      let timedOut = false;
      await Promise.race([
        new Promise<void>((r) => { wake = r; }),
        deadline.then(() => { timedOut = true; }),
      ]);
      if (timedOut) return false;
    }
    return planSignals.get(planId) === "ready";
  } finally {
    signalWaiters.delete(waiter);
    if (timer) clearTimeout(timer);
  }
}

