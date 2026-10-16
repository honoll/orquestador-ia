import { useQuery } from "@tanstack/react-query";
import { accountsApi } from "../lib/accounts-api";
import { formatIn, formatTokens } from "../lib/format";
import { useAppState } from "../context/AppStateContext";
import { useWs } from "../context/WebSocketProvider";
import { viewLocked, type View } from "../lib/office-view";

export function HudBar() {
  const { data: activeData } = useQuery({ queryKey: ["accounts", "active"], queryFn: accountsApi.active, refetchInterval: 60_000 });
  const { data: session } = useQuery({ queryKey: ["usage", "session"], queryFn: accountsApi.session, refetchInterval: 60_000 });
  const account = activeData?.account ?? null;
  const short = account?.usage.short;
  const { view, setView, talkActive } = useAppState();
  const { connected } = useWs();

  return (
    <header className="flex items-center gap-x-3 whitespace-nowrap border-b-[3px] border-edge bg-[#0b0b0e] px-3 py-1.5 text-text-primary" aria-label="Estado del orquestador">
      <span className="font-pixel text-[13px]">ORQUESTADOR</span>
      <span className={connected ? "text-ok" : "text-err"}>
        <span aria-hidden="true">● </span>{connected ? "en línea" : "desconectado"}
      </span>
      <span className="font-pixel text-[11px] text-text-tertiary">ANTIGRAVITY</span>
      {account ? (
        <>
          <span>{account.label}</span>
          {short && (
            <span className="flex min-w-0 items-center gap-2" title="Estimación local: Google no publica la cuota">
              {short.pct !== null ? (
                <span className="relative block h-2.5 w-24 shrink-0 border-2 border-edge-strong bg-black" aria-hidden="true">
                  <span className={`absolute inset-y-0 left-0 ${short.pct >= 85 ? "bg-err" : "bg-warn"}`} style={{ width: `${short.pct}%` }} />
                </span>
              ) : null}
              <span className="truncate">
                {short.pct !== null ? `~${short.pct} %` : `${formatTokens(short.usedTokens)} tok (sin tope)`} · estimado
                {short.resetsAt ? ` · se reinicia en ${formatIn(short.resetsAt - Date.now())}` : ""}
              </span>
            </span>
          )}
          {account.warn.warn && (
            <span role="alert" className="border-2 border-err px-1.5 text-err">{account.warn.reason}</span>
          )}
        </>
      ) : (
        <span className="text-text-secondary">sin cuenta activa — agrégala en el panel de cuentas</span>
      )}
      <span className="ml-auto text-text-secondary" title="Tokens de todos los adapters desde que arrancó el servidor">
        sesión: {formatTokens(session?.tokens ?? 0)} tok
      </span>
      <div role="group" aria-label="Vista" className="flex shrink-0 gap-1.5">
        {(["chat", "oficina", "equipo", "roles", "ajustes"] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => setView(v)}
            disabled={viewLocked(v, view, talkActive)}
            title={viewLocked(v, view, talkActive) ? "Termina la plática para cambiar de vista" : undefined}
            className={`px-btn ${view === v ? "px-btn-pri" : ""}`}
          >
            {v === "chat" ? "CHAT" : v === "oficina" ? "OFICINA" : v === "equipo" ? "EQUIPO" : v === "roles" ? "ROLES" : "AJUSTES"}
          </button>
        ))}
      </div>
    </header>
  );
}
