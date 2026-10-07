import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

interface WsEvent {
  type: string;
  runId?: string;
  stream?: string;
  data?: string;
  status?: string;
  result?: any;
  adapters?: Record<string, any>;
  timestamp?: string;
}

interface WsContextValue {
  connected: boolean;
  lastEvent: WsEvent | null;
  logs: Map<string, string>;
  /** Escucha TODOS los eventos, uno por uno y sin perder ninguno (a diferencia de lastEvent). */
  subscribe: (listener: (event: WsEvent) => void) => () => void;
}

const WsContext = createContext<WsContextValue>({
  connected: false,
  lastEvent: null,
  logs: new Map(),
  subscribe: () => () => {},
});

export function useWs() {
  return useContext(WsContext);
}

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const logsRef = useRef(new Map<string, string>());
  const listenersRef = useRef(new Set<(event: WsEvent) => void>());
  const subscribe = useCallback((l: (event: WsEvent) => void) => {
    listenersRef.current.add(l);
    return () => {
      listenersRef.current.delete(l);
    };
  }, []);
  const [, forceUpdate] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(url);

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (e) => {
        try {
          const event: WsEvent = JSON.parse(e.data);
          for (const l of listenersRef.current) {
            try { l(event); } catch { /* un oyente roto no debe tumbar a los demás */ }
          }
          // Los deltas del asistente llegan a ráfagas: solo van a los suscriptores (ni lastEvent ni logs).
          if (event.type === "voice:assistant:delta") return;
          setLastEvent(event);

          if (event.type === "log" && event.runId && event.data && event.stream === "stdout") {
            const prev = logsRef.current.get(event.runId) ?? "";
            logsRef.current.set(event.runId, prev + event.data);
            forceUpdate((n) => n + 1);
          }

          if (event.type === "plan:log" && (event as any).stepId && event.data && event.stream === "stdout") {
            const stepId = (event as any).stepId as string;
            const prev = logsRef.current.get(stepId) ?? "";
            logsRef.current.set(stepId, prev + event.data);
            forceUpdate((n) => n + 1);
          }

          // Accumulate plan generation stream keyed by planId with "gen:" prefix
          if (event.type === "plan:generating" && (event as any).planId && event.data) {
            const key = `gen:${(event as any).planId}`;
            const prev = logsRef.current.get(key) ?? "";
            logsRef.current.set(key, prev + event.data);
            forceUpdate((n) => n + 1);
          }

          // Shell command output keyed by jobId with "sh:" prefix
          if (event.type === "shell:log" && (event as any).jobId && event.data) {
            const key = `sh:${(event as any).jobId}`;
            const prev = logsRef.current.get(key) ?? "";
            logsRef.current.set(key, prev + event.data);
            forceUpdate((n) => n + 1);
          }

          // GitHub clone output keyed by jobId with "gh:" prefix
          if (event.type === "github:log" && (event as any).jobId && event.data) {
            const key = `gh:${(event as any).jobId}`;
            const prev = logsRef.current.get(key) ?? "";
            logsRef.current.set(key, prev + event.data);
            forceUpdate((n) => n + 1);
          }

          if (event.type === "run:status") {
            queryClient.invalidateQueries({ queryKey: ["runs"] });
            queryClient.invalidateQueries({ queryKey: ["tasks"] });
            queryClient.invalidateQueries({ queryKey: ["usage", "session"] });
          }

          if (event.type === "accounts:changed") {
            queryClient.invalidateQueries({ queryKey: ["accounts"] });
          }

          if (event.type === "adapters:status") {
            queryClient.invalidateQueries({ queryKey: ["adapters"] });
          }
        } catch {
          // ignore parse errors
        }
      };
    }

    connect();
    return () => {
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [queryClient]);

  return (
    <WsContext.Provider value={{ connected, lastEvent, logs: logsRef.current, subscribe }}>
      {children}
    </WsContext.Provider>
  );
}
