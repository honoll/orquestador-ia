import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ROLES, deskLabel } from "../../lib/office";
import { clock, sceneScale, seatLabel, signLine } from "../../lib/office-view";
import { AgentSprite } from "./AgentSprite";
import { AccountRack } from "./AccountRack";
import { OfficeTalkPanel } from "./OfficeTalkPanel";
import type { AgentState, QueueItem } from "./OfficeView";

const DESIGN_W = 820; // ancho mínimo en el que cabe la escena sin escalar
const IDLE = "#8b8b94"; // ≥ 4.5:1 sobre el piso #0e0e12
const ZONES = [["direccion", "DIRECCIÓN"], ["trabajadores", "TRABAJADORES"], ["servicios", "SERVICIOS"]] as const;
const FLOOR = {
  background: "#0e0e12",
  backgroundImage: "linear-gradient(#ffffff06 2px,transparent 2px),linear-gradient(90deg,#ffffff06 2px,transparent 2px)",
  backgroundSize: "32px 32px",
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15_000); return () => clearInterval(id); }, []);
  return clock(now);
}

function Plant({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" className={`absolute h-7 w-5 ${className}`} viewBox="0 0 10 14" shapeRendering="crispEdges">
      <rect x="3" y="10" width="4" height="4" fill="#3f3f46" /><rect x="4" y="4" width="2" height="6" fill="#15803d" />
      <rect x="1" y="3" width="3" height="3" fill="#16a34a" /><rect x="6" y="2" width="3" height="3" fill="#16a34a" />
      <rect x="3" y="0" width="3" height="3" fill="#22c55e" />
    </svg>
  );
}

function Desks({ agent }: { agent: AgentState }) {
  const role = ROLES[agent.id];
  const n = Math.max(1, Math.min(4, agent.desks));
  const total = agent.seats?.length ?? 0;
  return Array.from({ length: n }, (_, i) => {
    const seat = agent.seats?.[i];
    const working = seat ? seat.working : agent.working;
    const label = seat ? seatLabel(seat.account, seat.role) + (i === 3 && total > 4 ? ` ×${total}` : "") : i === 0 ? deskLabel(role.label, n) : role.label;
    return (
      <div key={i} className="w-[112px] text-center">
        <AgentSprite role={agent.id} working={working} />
        <div className="mt-1 truncate text-[11px] font-bold tracking-[.14em]" style={{ color: working ? role.color : IDLE }} title={label}>{label}</div>
      </div>
    );
  });
}

export function OfficeScene({ agents, queue }: { agents: AgentState[]; queue: QueueItem[] }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: DESIGN_W, h: 600 });
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const measure = () => setBox({ w: o.clientWidth, h: i.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o); ro.observe(i);
    return () => ro.disconnect();
  }, []);
  const s = sceneScale(box.w, DESIGN_W);
  const time = useClock();
  const busy = agents.some((a) => a.working);

  // Decorativa (aria-hidden) salvo el panel de «Platicar»: lo demás está en texto en las tarjetas y los paneles.
  return (
    <div ref={outer} className="min-w-0" style={{ height: box.h * s }}>
      <div
        ref={inner}
        className="relative min-h-[600px] overflow-hidden rounded-lg border border-edge-strong pb-8"
        style={{ ...FLOOR, width: s < 1 ? DESIGN_W : "100%", transform: s < 1 ? `scale(${s})` : undefined, transformOrigin: "top left" }}
      >
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[130px] border-b-4 border-[#1b1b22] bg-[#121217]" />
        <div aria-hidden="true" className="absolute left-[22px] top-6 text-lg tracking-[.1em]" style={{ color: IDLE }}>{time}</div>
        <div aria-hidden="true" className="absolute left-1/2 top-[22px] -translate-x-1/2 whitespace-nowrap border-2 border-[#26262e] bg-[#08080a] px-[18px] py-2 text-center tracking-[.18em] shadow-[inset_0_0_0_2px_#000]" style={{ color: IDLE }}>
          ORQUESTADOR · <b className="text-text-primary">OFICINA</b>
          <i className={`ml-2 inline-block h-2 w-2 align-middle ${busy ? "bg-ok" : "bg-text-tertiary"}`} />
          <br /><small>{signLine(queue)}</small>
        </div>
        <div aria-hidden="true" className="relative flex flex-col gap-7 pl-[30px] pr-[316px] pt-[150px]">
          {ZONES.map(([zone, title]) => (
            <section key={zone}>
              <div className="text-[12px] font-bold tracking-[.22em]" style={{ color: IDLE }}>{title}</div>
              <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-3">
                {agents.filter((a) => ROLES[a.id]?.zone === zone).map((a) => <Desks key={a.id} agent={a} />)}
              </div>
            </section>
          ))}
        </div>
        <div className="absolute right-[18px] top-[150px] flex w-[282px] flex-col gap-3">
          <AccountRack />
          <OfficeTalkPanel />
        </div>
        <Plant className="right-[306px] top-[150px]" />
        <Plant className="bottom-5 right-[306px]" />
      </div>
    </div>
  );
}
