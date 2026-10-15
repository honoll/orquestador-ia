import { useQuery } from "@tanstack/react-query";
import { accountsApi } from "../../lib/accounts-api";
import { groupByPool } from "../../lib/office-view";

const IDLE = "#8b8b94";

export function AccountRack() {
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list, refetchInterval: 60_000 });
  const pools = groupByPool(accounts.map((a) => ({ id: a.id, label: a.label, active: a.active, pool: a.pool, quotaBlockedUntil: a.quotaBlockedUntil, poolShortPct: a.poolUsage?.short.pct ?? a.usage.short.pct })));
  return (
    <div aria-hidden="true" className="flex flex-wrap gap-1.5 rounded border-2 border-[#22222a] bg-[#0b0b0f] p-2.5">
      <div className="mb-2.5 w-full text-xs font-bold tracking-[.22em]" style={{ color: IDLE }}>CUENTAS ANTIGRAVITY</div>
      {pools.length === 0 && <div style={{ color: IDLE }}>sin cuentas</div>}
      {pools.map((p) => {
        const pct = p.blocked ? 100 : Math.min(100, p.pct ?? 0);
        const hasLocal = p.accounts.some((a) => a.active);
        return (
          <div key={p.key} className="w-[60px] text-center">
            <div className={`h-4 font-bold ${p.blocked ? "text-err" : "text-text-primary"}`}>{p.blocked ? "⛔" : p.pct !== null ? `${p.pct}%` : "—"}</div>
            <div className={`mx-auto mb-1 h-2.5 w-2.5 ${p.blocked ? "bg-err" : hasLocal ? "bg-[#60a5fa]" : "bg-text-tertiary"}`} />
            <div className="relative h-[110px] overflow-hidden border-2 border-[#24242b] bg-[#16161b]">
              <div className="absolute inset-1.5" style={{ background: "repeating-linear-gradient(#ffffff0a 0 2px,transparent 2px 12px)" }} />
              <div className={`absolute inset-x-0 bottom-0 ${p.blocked ? "bg-err/20" : "bg-[#60a5fa]/20"}`} style={{ height: `${pct}%` }} />
            </div>
            {p.accounts.map((a) => (
              <small key={a.id} className="block truncate font-bold tracking-[.06em]" style={{ color: a.active ? "#60a5fa" : IDLE }} title={a.active ? `${a.label} (local, activa)` : a.label}>
                {a.active ? "● " : ""}{a.label.toUpperCase()}
              </small>
            ))}
          </div>
        );
      })}
    </div>
  );
}
