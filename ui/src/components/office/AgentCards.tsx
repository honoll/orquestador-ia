import { ROLES } from "../../lib/office";
import { formatTokens } from "../../lib/format";
import type { AgentState } from "./OfficeView";

export function AgentCards({ agents }: { agents: AgentState[] }) {
  return (
    <ul aria-label="Agentes" className="grid grid-cols-2 gap-1.5 px-3 py-2 @min-[560px]:grid-cols-4 @min-[900px]:grid-cols-7">
      {agents.map((a) => {
        const role = ROLES[a.id];
        const busy = a.seats?.filter((x) => x.working).length ?? 0;
        const state = a.seats && a.seats.length > 1
          ? `${a.working ? "TRABAJANDO" : "EN REPOSO"} · ${busy}/${a.seats.length}`
          : a.working ? `TRABAJANDO${a.desks > 1 ? ` ×${a.desks}` : ""}` : a.paused ? "EN ESPERA" : "EN REPOSO";
        return (
          <li key={a.id} className="px-panel min-w-0 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex shrink-0 items-center gap-1.5 font-pixel text-[11px]">
                <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0" style={{ background: role.color }} />
                <span>{a.seats && a.seats.length > 1 ? `${role.label} ×${a.seats.length}` : role.label}</span>
              </span>
              <span className="min-w-0 truncate text-xs text-text-secondary" title={a.model}>{a.model}</span>
            </div>
            <p className="my-0.5 truncate text-text-secondary" title={a.activity}>{a.activity}</p>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 whitespace-nowrap text-text-secondary">
              <span className={`font-pixel text-[11px] ${a.working || a.paused ? "text-warn" : ""}`}>{state}</span>
              <span className="text-xs">{a.tokens > 0 ? formatTokens(a.tokens) : "—"} tok</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
