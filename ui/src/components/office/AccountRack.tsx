import { useQuery } from "@tanstack/react-query";
import { accountsApi } from "../../lib/accounts-api";

const IDLE = "#8b8b94";

export function AccountRack() {
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list, refetchInterval: 60_000 });
  return (
    <div className="absolute right-[18px] top-[150px] flex w-[282px] flex-wrap gap-1.5 rounded border-2 border-[#22222a] bg-[#0b0b0f] p-2.5">
      <div className="mb-2.5 w-full text-xs font-bold tracking-[.22em]" style={{ color: IDLE }}>CUENTAS ANTIGRAVITY</div>
      {accounts.length === 0 && <div style={{ color: IDLE }}>sin cuentas</div>}
      {accounts.map((a) => {
        const blocked = !!a.quotaBlockedUntil && Date.parse(a.quotaBlockedUntil) > Date.now();
        const pct = blocked ? 100 : Math.min(100, a.usage.short.pct ?? 0);
        const led = blocked ? "bg-err" : a.active ? "bg-[#60a5fa]" : "bg-text-tertiary";
        return (
          <div key={a.id} className="w-[60px] text-center">
            <div className={`h-4 font-bold ${blocked ? "text-err" : "text-text-primary"}`}>
              {blocked ? "⛔" : a.usage.short.pct !== null ? `${a.usage.short.pct}%` : "—"}
            </div>
            <div className={`mx-auto mb-1 h-2.5 w-2.5 ${led}`} />
            <div className="relative h-[150px] overflow-hidden border-2 border-[#24242b] bg-[#16161b]">
              <div className="absolute inset-1.5" style={{ background: "repeating-linear-gradient(#ffffff0a 0 2px,transparent 2px 12px)" }} />
              <div className={`absolute inset-x-0 bottom-0 ${blocked ? "bg-err/20" : "bg-[#60a5fa]/20"}`} style={{ height: `${pct}%` }} />
              {a.active && !blocked && <><b className="absolute left-2 top-3 h-[3px] w-[3px] bg-ok" /><b className="absolute left-2 top-9 h-[3px] w-[3px] bg-ok" /></>}
            </div>
            <small className="block truncate font-bold tracking-[.1em]" style={{ color: IDLE }}>{a.label.toUpperCase()}</small>
          </div>
        );
      })}
    </div>
  );
}
