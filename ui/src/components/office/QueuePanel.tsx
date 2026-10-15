import type { ReactNode } from "react";
import { queueTag, type Tag, type Tone } from "../../lib/office-view";
import type { QueueItem } from "./OfficeView";

const TONE: Record<Tone, string> = { run: "text-accent", ok: "text-ok", err: "text-err", wait: "text-warn", idle: "text-text-secondary" };

export function TagBadge({ tag }: { tag: Tag }) {
  return <span className={`px-tag min-w-[74px] shrink-0 text-center ${TONE[tag.tone]}`}>{tag.label}</span>;
}

export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="px-panel px-grid min-w-0 px-2.5 py-2">
      <h2 className="mb-1.5 font-pixel text-[11px] text-text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export const ROW = "flex w-full items-center gap-2 border-t-2 border-edge py-1 text-left hover:bg-surface-2";

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
