import { toSpeechText } from "../text.js";
import type { WsEvent } from "../../lib/types.js";
import { onBroadcast } from "../../server/ws.js";

const PLAN_READY_TIMEOUT_MS = 10 * 60_000;
const PAUSE_NAMES: Record<string, string> = { quota: "cuota", budget: "presupuesto", guard: "guardia" };

type PlanCtx = { id: string; plans: { id: string }[]; syntheses: Map<string, string> };

/** Anuncios por voz de los planes lanzados en la sesión. */
export function handlePlanEvent(s: PlanCtx, e: WsEvent, emit: (e: Record<string, unknown>) => void) {
  const ev = e as unknown as { type: string; planId?: string; status?: string; synthesis?: string; paused?: string };
  if (!ev.planId) return;
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

export type PlanWait = "ready" | "failed" | "timeout" | "aborted";
export type PlanWatcher = { wait(planId: string): Promise<PlanWait>; dispose(): void };

const watchers = new Set<PlanWatcher>();

/**
 * Observa plan:ready / plan:error desde ya (también lo emitido antes de conocer el id del plan).
 * Quien lo crea debe llamar dispose(); wait() vence a los 10 min y no deja oyentes ni temporizadores.
 */
export function watchPlanReady(timeoutMs: number = PLAN_READY_TIMEOUT_MS): PlanWatcher {
  const seen = new Map<string, "ready" | "error">();
  let wake: (() => void) | null = null;
  let abort: (() => void) | null = null;
  const unsub = onBroadcast((e) => {
    const ev = e as unknown as { type: string; planId?: string };
    if (!ev.planId) return;
    if (ev.type === "plan:ready" || ev.type === "plan:error") {
      seen.set(ev.planId, ev.type === "plan:ready" ? "ready" : "error");
      wake?.();
    }
  });
  const watcher: PlanWatcher = {
    wait(planId) {
      return new Promise<PlanWait>((resolve) => {
        let done = false;
        const finish = (r: PlanWait) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          wake = null;
          abort = null;
          resolve(r);
        };
        const timer = setTimeout(() => finish("timeout"), timeoutMs);
        timer.unref?.();
        wake = () => {
          const v = seen.get(planId);
          if (v) finish(v === "ready" ? "ready" : "failed");
        };
        abort = () => finish("aborted");
        wake();
      });
    },
    dispose() {
      unsub();
      abort?.();
      watchers.delete(watcher);
    },
  };
  watchers.add(watcher);
  return watcher;
}

/** Apagado del servidor: suelta todas las esperas pendientes. */
export function disposeAllPlanWatchers(): void {
  for (const w of [...watchers]) w.dispose();
}
