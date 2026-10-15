import { planTag } from "../../lib/office-view";
import { Panel, ROW, TagBadge } from "./QueuePanel";
import type { PlanSummary } from "./OfficeView";

export function PlansPanel({ plans, onOpen }: { plans: PlanSummary[]; onOpen: (planId: string) => void }) {
  const active = plans.filter((p) => ["generating", "running"].includes(p.status) || (p.status === "pending" && p.pauseReason)).length;
  return (
    <Panel title={`PLANES · ${active} ${active === 1 ? "ACTIVO" : "ACTIVOS"}`}>
      {plans.length === 0 ? <p className="text-text-secondary">sin planes todavía</p> : (
        <ul>
          {plans.map((p) => (
            <li key={p.id}>
              <button type="button" className={ROW} onClick={() => onOpen(p.id)} title={`Abrir el plan: ${p.description}`}>
                <TagBadge tag={planTag(p)} />
                <span className="flex-1 truncate">{p.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
