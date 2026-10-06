import { useQuery } from "@tanstack/react-query";
import { accountsApi } from "../lib/accounts-api";
import { formatIn, formatTokens } from "../lib/format";

export function HudBar() {
  const { data: activeData } = useQuery({ queryKey: ["accounts", "active"], queryFn: accountsApi.active, refetchInterval: 60_000 });
  const { data: session } = useQuery({ queryKey: ["usage", "session"], queryFn: accountsApi.session, refetchInterval: 60_000 });
  const account = activeData?.account ?? null;
  const short = account?.usage.short;

  return (
    <header className="flex items-center gap-4 border-b border-edge bg-surface-1 px-4 py-1.5 font-mono text-[11px] text-text-secondary" aria-label="Estado del orquestador">
      <span className="text-text-tertiary">antigravity</span>
      {account ? (
        <>
          <span className="text-text-primary">{account.label}</span>
          {short && (
            <span className="flex items-center gap-2" title="Estimación local: Google no publica la cuota">
              {short.pct !== null ? (
                <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                  <span className={`absolute inset-y-0 left-0 ${short.pct >= 85 ? "bg-err" : "bg-ok"}`} style={{ width: `${short.pct}%` }} />
                </span>
              ) : null}
              <span>
                {short.pct !== null ? `~${short.pct} %` : `${formatTokens(short.usedTokens)} tok (sin tope)`} · estimado
                {short.resetsAt ? ` · se reinicia en ${formatIn(short.resetsAt - Date.now())}` : ""}
              </span>
            </span>
          )}
          {account.warn.warn && (
            <span role="alert" className="rounded border border-err/40 px-1.5 py-0.5 text-err">{account.warn.reason}</span>
          )}
        </>
      ) : (
        <span>sin cuenta activa — agrégala en el panel de cuentas</span>
      )}
      <span className="ml-auto" title="Tokens de todos los adapters desde que arrancó el servidor">
        sesión: {formatTokens(session?.tokens ?? 0)} tok
      </span>
    </header>
  );
}
