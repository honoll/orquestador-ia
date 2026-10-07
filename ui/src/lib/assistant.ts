// Cliente del asistente de voz (F6): cuerpos de petición, filtrado de eventos WS por sesión y llamadas HTTP.
// La parte pura se prueba en node (test/ui/assistant.test.ts).

export type AssistantEvent =
  | { type: "delta"; sessionId: string; turnId: string; delta: string }
  | { type: "turn-done"; sessionId: string; turnId: string; speech: string; hasAction: boolean; error?: string }
  | { type: "announce"; sessionId: string; text: string }
  | { type: "ended"; sessionId: string; reason: string; notePath: string | null };

const str = (v: unknown): v is string => typeof v === "string";

/** Evento WS crudo → evento tipado, o null si no es del asistente o no es de esta sesión. */
export function parseAssistantEvent(raw: unknown, sessionId: string): AssistantEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (!str(e.type) || !e.type.startsWith("voice:assistant:")) return null;
  if (e.sessionId !== sessionId) return null;
  switch (e.type) {
    case "voice:assistant:delta":
      if (!str(e.turnId) || !str(e.delta)) return null;
      return { type: "delta", sessionId, turnId: e.turnId, delta: e.delta };
    case "voice:assistant:turn-done":
      if (!str(e.turnId)) return null;
      return {
        type: "turn-done",
        sessionId,
        turnId: e.turnId,
        speech: str(e.speech) ? e.speech : "",
        hasAction: e.hasAction === true,
        ...(str(e.error) && e.error ? { error: e.error } : {}),
      };
    case "voice:assistant:announce":
      if (!str(e.text) || !e.text.trim()) return null;
      return { type: "announce", sessionId, text: e.text };
    case "voice:assistant:ended":
      return {
        type: "ended",
        sessionId,
        reason: str(e.reason) ? e.reason : "",
        notePath: str(e.notePath) && e.notePath ? e.notePath : null,
      };
    default:
      return null;
  }
}

export function startBody(projectId: string | null): string {
  return JSON.stringify(projectId ? { projectId } : {});
}

export function turnBody(text: string): string {
  return JSON.stringify({ text: text.trim() });
}

/** Cuerpo de POST /end (el servidor no lo usa, pero sendBeacon necesita un Blob JSON). */
export function endBody(): string {
  return "{}";
}

export const assistantPaths = {
  start: "/api/voice/assistant/start",
  turn: (id: string) => `/api/voice/assistant/${encodeURIComponent(id)}/turn`,
  end: (id: string) => `/api/voice/assistant/${encodeURIComponent(id)}/end`,
  interrupt: (id: string) => `/api/voice/assistant/${encodeURIComponent(id)}/interrupt`,
};

/**
 * Qué decir al llegar turn-done: la frase del servidor si nada se dijo por deltas, también cuando trae
 * error (cuota agotada, agy perdido: el aviso se oye antes de cerrar).
 */
export function turnDoneSpeech(ev: { speech: string; error?: string }, sentencesSoFar: number): string | null {
  const s = ev.speech.trim();
  return sentencesSoFar === 0 && s ? s : null;
}

export const FINISH_AFTER_SPEECH_MAX_MS = 15_000;

/**
 * Cierre diferido: cuando el servidor termina la plática, la vista espera a que la cola de voz quede vacía
 * (con un tope de seguridad) para que el último aviso se oiga completo. done() se llama una sola vez.
 */
export function createFinishAfterSpeech(opts: { idle(): boolean; timeoutMs?: number }): {
  request(done: () => void): void;
  notifyIdle(): void;
  cancel(): void;
} {
  let pending: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    const done = pending;
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
    done?.();
  };
  return {
    request(done) {
      if (pending) return;
      if (opts.idle()) return done();
      pending = done;
      timer = setTimeout(fire, opts.timeoutMs ?? FINISH_AFTER_SPEECH_MAX_MS);
    },
    notifyIdle: fire,
    cancel() {
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export type TurnOutcome =
  | { kind: "accepted"; turnId: string }
  | { kind: "discarded" }
  | { kind: "error"; message: string };

/** Respuesta de POST /turn → resultado. 202 {turnId} | 200 {discarded} | 4xx {error}. */
export function turnOutcome(status: number, body: unknown): TurnOutcome {
  const b = (body && typeof body === "object" ? body : {}) as { turnId?: unknown; discarded?: unknown; error?: unknown };
  if (status === 200 && b.discarded === true) return { kind: "discarded" };
  if (status === 202 && str(b.turnId)) return { kind: "accepted", turnId: b.turnId };
  return { kind: "error", message: str(b.error) && b.error ? b.error : `HTTP ${status}` };
}

export function startErrorMessage(status: number, serverMessage?: string): string {
  if (status === 409) return serverMessage || "Ya hay una plática en curso.";
  return `No se pudo iniciar la plática: ${serverMessage || `HTTP ${status}`}`;
}

// ─── Interruptor «Interrumpir con la voz» ─────────────────────────────────────

const BARGE_IN_KEY = "orq.voice.bargeIn";
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readBargeIn(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(BARGE_IN_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeBargeIn(storage: StorageLike | null | undefined, on: boolean): void {
  try {
    storage?.setItem(BARGE_IN_KEY, on ? "1" : "0");
  } catch {
    /* almacenamiento bloqueado */
  }
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function json(r: Response): Promise<unknown> {
  return r.json().catch(() => ({}));
}

export class AssistantRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function startSession(projectId: string | null): Promise<{ sessionId: string; conversationId: string }> {
  const r = await fetch(assistantPaths.start, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: startBody(projectId),
  });
  const b = (await json(r)) as { sessionId?: unknown; conversationId?: unknown; error?: unknown };
  if (!r.ok || !str(b.sessionId) || !str(b.conversationId)) {
    throw new AssistantRequestError(startErrorMessage(r.status, str(b.error) ? b.error : undefined), r.status);
  }
  return { sessionId: b.sessionId, conversationId: b.conversationId };
}

export async function postTurn(sessionId: string, text: string): Promise<TurnOutcome> {
  const r = await fetch(assistantPaths.turn(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: turnBody(text),
  });
  return turnOutcome(r.status, await json(r));
}

export async function endSession(sessionId: string): Promise<{ notePath: string | null }> {
  const r = await fetch(assistantPaths.end(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: endBody(),
  });
  const b = (await json(r)) as { notePath?: unknown };
  return { notePath: str(b.notePath) && b.notePath ? b.notePath : null };
}

/** Avisa al servidor de una interrupción: descarta la acción pendiente (no cancela el turno de agy). */
export async function interruptSession(sessionId: string): Promise<void> {
  await fetch(assistantPaths.interrupt(sessionId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

/** Al cerrar la pestaña no hay tiempo para un fetch normal. */
export function endSessionBeacon(sessionId: string): void {
  try {
    // El tsconfig de pruebas (sin DOM) no conoce sendBeacon.
    (navigator as unknown as { sendBeacon(url: string, data: Blob): boolean }).sendBeacon(
      assistantPaths.end(sessionId),
      new Blob([endBody()], { type: "application/json" }),
    );
  } catch {
    /* la sesión caduca sola en el servidor */
  }
}
