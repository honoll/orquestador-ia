import { useEffect, useImperativeHandle, useState, type Ref } from "react";
import { dialogFor, paginate } from "../../office/world/dialog";
import type { WorldAgent } from "../../office/world/placement";
import type { OfficeLogEntry } from "../../lib/office-view";

export interface DialogHandle { advance: () => void }
interface Props { agent: WorldAgent; log: OfficeLogEntry[]; onOpenPlan: (id: string) => void; ref?: Ref<DialogHandle> }

const CHAR_MS = 2000 / 60; // 1 carácter cada 2 pasos de 60 Hz
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Caja de texto estilo GBA: páginas de 2 renglones escritas letra por letra; Enter/Espacio/Z/clic avanzan. */
export function WorldDialog({ agent, log, onOpenPlan, ref }: Props) {
  const d = dialogFor(agent);
  const pages = paginate(d.lineas);
  const [reduced] = useState(reducedMotion);
  const [pageIdx, setPageIdx] = useState(0);
  const [typed, setTyped] = useState(0);
  const [showLog, setShowLog] = useState(false);
  const page = pages[Math.min(pageIdx, pages.length - 1)];
  const total = page.join("\n").length;
  const shown = reduced ? total : Math.min(typed, total);
  const done = shown >= total;

  useEffect(() => {
    if (done) return;
    const id = setInterval(() => setTyped((n) => n + 1), CHAR_MS);
    return () => clearInterval(id);
  }, [done]);

  const advance = () => {
    if (!done) setTyped(total);
    else if (pageIdx < pages.length - 1) { setPageIdx(pageIdx + 1); setTyped(0); }
  };
  useImperativeHandle(ref, () => ({ advance }));

  const text = page.join("\n").slice(0, shown);
  const who = agent.key.startsWith("agy:") ? "agy" : agent.key;
  const entries = log.filter((e) => e.agent === who).slice(0, 5);

  return (
    <div
      className="absolute inset-x-2 bottom-2 border-4 border-zinc-200 bg-[#0b0b10] px-3 py-2 font-mono text-sm text-text-primary"
      style={{ boxShadow: "4px 4px 0 #000" }}
    >
      <p role="status" aria-live="polite" className="sr-only">{`${d.titulo}, ${d.estado}. ${page.join(" ")}`}</p>
      <div className="flex items-baseline gap-2 text-xs font-bold tracking-widest" aria-hidden="true">
        <span style={{ color: agent.color }}>{d.titulo}</span>
        <span className="text-text-secondary">{d.estado}</span>
      </div>
      <div aria-hidden="true" className="relative min-h-[2.75rem] cursor-pointer whitespace-pre-wrap pr-5 leading-snug" onClick={advance}>
        {text}
        {done && pageIdx < pages.length - 1 && <span className="absolute bottom-0 right-0 animate-pulse motion-reduce:animate-none">▼</span>}
      </div>
      <div className="mt-1 flex gap-3 text-xs">
        {d.planId && <button className="underline hover:text-accent" onClick={() => onOpenPlan(d.planId!)}>abrir plan</button>}
        <button className="underline hover:text-accent" aria-expanded={showLog} onClick={() => setShowLog((v) => !v)}>ver log</button>
      </div>
      {showLog && (
        <ul className="mt-1 max-h-24 overflow-y-auto text-xs text-text-secondary">
          {entries.length ? entries.map((e) => <li key={e.key}>{e.time} · {e.text}</li>) : <li>sin eventos todavía</li>}
        </ul>
      )}
    </div>
  );
}
