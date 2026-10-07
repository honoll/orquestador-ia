import type { WSContext } from "hono/ws";
import type { WsEvent } from "../lib/types.js";

const clients = new Set<WSContext>();

export function addClient(ws: WSContext) {
  clients.add(ws);
}

export function removeClient(ws: WSContext) {
  clients.delete(ws);
}

const listeners = new Set<(event: WsEvent) => void>();

/** Escucha todo lo que se emite con broadcast (uso interno del servidor). Devuelve la baja. */
export function onBroadcast(listener: (event: WsEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function broadcast(event: WsEvent) {
  for (const l of [...listeners]) {
    try {
      l(event);
    } catch {
      /* un oyente con fallo no debe afectar a los demás ni a los clientes */
    }
  }
  const data = JSON.stringify(event);
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch {
      clients.delete(ws);
    }
  }
}
