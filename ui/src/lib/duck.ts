import { createDuckLease, duckBody, type DuckLease, type DuckReason } from "./duck-lease";

// Estado de disponibilidad (viene de GET /api/voice/status → duck). Hasta saberlo, no se hace ninguna llamada.
let available = false;
export function setDuckAvailability(duck: { supported?: boolean; enabled?: boolean } | undefined) {
  available = !!duck && duck.supported === true && duck.enabled === true;
}

const leases = new Map<DuckReason, DuckLease>();

function post(reason: DuckReason, on: boolean) {
  return fetch("/api/voice/duck", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: duckBody(reason, on),
    keepalive: true,
  });
}

/** Un único arrendamiento por motivo, sin importar cuántos botones lo pidan. */
export function duckLease(reason: DuckReason): DuckLease {
  let l = leases.get(reason);
  if (!l) {
    l = createDuckLease({ send: (on) => post(reason, on), isAvailable: () => available });
    leases.set(reason, l);
  }
  return l;
}

if (typeof window !== "undefined") {
  // Al cerrar o recargar la pestaña no hay tiempo para un fetch normal: sendBeacon con Blob JSON.
  window.addEventListener("pagehide", () => {
    for (const [reason, l] of leases) {
      if (!l.active()) continue;
      try {
        navigator.sendBeacon("/api/voice/duck", new Blob([duckBody(reason, false)], { type: "application/json" }));
      } catch {
        /* el arrendamiento caduca solo a los 45 s */
      }
    }
  });
}
