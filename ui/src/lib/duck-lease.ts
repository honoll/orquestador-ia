// Arrendamiento de ducking de audio (F5): el servidor baja el volumen de las demás apps mientras haya un
// arrendamiento activo (caduca a los 45 s), así que se renueva cada 20 s. Controlador puro con temporizadores
// inyectados para poder probarlo sin DOM.

export type DuckReason = "mic" | "speak" | "conversation";
export const DUCK_RENEW_MS = 20_000;

export interface DuckLeaseDeps {
  /** Envía el estado deseado al servidor. Fire-and-forget: el controlador atrapa cualquier fallo. */
  send: (on: boolean) => void | Promise<unknown>;
  /** Si devuelve false (no soportado o desactivado) no se hace ninguna llamada. */
  isAvailable?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  renewMs?: number;
}

export interface DuckLease {
  start(): void;
  stop(): void;
  active(): boolean;
}

export function createDuckLease(deps: DuckLeaseDeps): DuckLease {
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const renewMs = deps.renewMs ?? DUCK_RENEW_MS;
  const isAvailable = deps.isAvailable ?? (() => true);
  let timer: unknown = null;
  let on = false;

  const safeSend = (value: boolean) => {
    try {
      const r = deps.send(value);
      if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => {});
    } catch {
      /* el ducking nunca debe romper la voz */
    }
  };

  return {
    start() {
      if (on || !isAvailable()) return;
      on = true;
      safeSend(true);
      timer = setTimer(() => {
        if (isAvailable()) safeSend(true);
      }, renewMs);
    },
    stop() {
      if (!on) return;
      on = false;
      if (timer !== null) clearTimer(timer);
      timer = null;
      safeSend(false);
    },
    active: () => on,
  };
}

/** Cuerpo JSON de la petición. */
export function duckBody(reason: DuckReason, on: boolean): string {
  return JSON.stringify({ reason, on });
}
