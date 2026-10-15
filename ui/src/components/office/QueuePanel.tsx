import type { ReactNode } from "react";
import { queueTag, type Tag, type Tone } from "../../lib/office-view";
import type { QueueItem } from "./OfficeView";

const TONE: Record<Tone, string> = { run: "text-accent", ok: "text-ok", err: "text-err", wait: "text-amber-400", idle: "text-text-secondary" };

export function TagBadge({ tag }: { tag: Tag }) {
  return <span className={`min-w-[74px] shrink-0 rounded-[3px] bg-surface-3 px-1.5 py-px text-center text-[10px] ${TONE[tag.tone]}`}>{tag.label}</span>;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 rounded-lg border border-edge-strong bg-surface-1 px-2.5 py-2">
      <h2 className="mb-1.5 text-[10px] tracking-[.12em] text-text-secondary">{title}</h2>
      {children}
    </section>
  );
}

export const ROW = "flex w-full items-center gap-2 border-t border-white/[.03] py-1 text-left hover:bg-surface-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent";

export function QueuePanel({ queue, onOpen }: { queue: QueueItem[]; onOpen: (planId: string) => void }) {
  return (
    <Panel title={`COLA · ${queue.length} ${queue.length === 1 ? "PASO" : "PASOS"}`}>
      {queue.length === 0 ? <p className="text-text-secondary">sin pasos en cola</p> : (
        <ul>
          {queue.map((q) => {
            const text = `${q.stepKey ? `${q.stepKey} · ` : ""}${q.description}${q.status === "paused" ? " (pausado)" : ""}`;
            return (
              <li key={q.stepId}>
                <button type="button" className={ROW} onClick={() => onOpen(q.planId)} title={`Abrir el plan: ${text}`}>
                  <TagBadge tag={queueTag(q)} />
                  <span className="flex-1 truncate">{text}</span>
                  {q.project && <span className="shrink-0 text-text-secondary">{q.project}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
