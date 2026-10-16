import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useWs } from "../../context/WebSocketProvider";
import { useAppState } from "../../context/AppStateContext";
import { accountsApi } from "../../lib/accounts-api";
import { groupByPool, viewLocked } from "../../lib/office-view";
import { ABIERTOS_KEY, alternar, colorRol, destino, indicador, leerAbiertos, lineaActual, refrescaBarra, type Bandeja, type BandejaTarea } from "../../lib/barra";
import { AdapterUsage } from "../AdapterUsage";

const TONE = { run: "text-blue", wait: "text-warn", idle: "text-text-tertiary" } as const;
const GRUPOS = [["trabajando", "TRABAJANDO"], ["enCola", "EN COLA"], ["esperando", "ESPERANDO HIJAS"]] as const;

async function fetchBandejas(): Promise<Bandeja[]> {
  const r = await fetch("/api/equipo/bandejas");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function EquipoSection() {
  const qc = useQueryClient();
  const { subscribe } = useWs();
  const { view, talkActive, setView, setActivePlanId, setEquipoFocus } = useAppState();
  const bandejas = useQuery({ queryKey: ["bandejas"], queryFn: fetchBandejas, refetchInterval: 30_000, retry: 1 });
  const [abiertos, setAbiertos] = useState<string[]>(() => {
    try { return leerAbiertos(localStorage.getItem(ABIERTOS_KEY)); } catch { return []; }
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsub = subscribe((ev) => {
      if (!refrescaBarra(ev.type) || timer.current) return;
      // Freno de 300 ms (no debounce): una ráfaga de eventos no deja la barra congelada.
      timer.current = setTimeout(() => {
        timer.current = null;
        void qc.invalidateQueries({ queryKey: ["bandejas"] });
      }, 300);
    });
    return () => { unsub(); if (timer.current) clearTimeout(timer.current); timer.current = null; };
  }, [subscribe, qc]);

  const toggle = (rol: string) => setAbiertos((prev) => {
    const next = alternar(prev, rol);
    try { localStorage.setItem(ABIERTOS_KEY, JSON.stringify(next)); } catch { /* almacenamiento bloqueado */ }
    return next;
  });

  const abrir = (t: BandejaTarea) => {
    if (talkActive) return; // un plan de pasos reemplazaría el árbol de Chat y cortaría la plática
    const d = destino(t);
    if (viewLocked(d.view, view, talkActive)) return;
    if (d.view === "equipo") setEquipoFocus({ metaId: d.metaId, tareaId: d.tareaId });
    else setActivePlanId(d.planId);
    setView(d.view);
  };

  return (
    <section aria-label="Equipo">
      <p className="mb-1 font-pixel text-[11px] text-text-secondary">EQUIPO</p>
      {bandejas.isPending && <p className="mb-1 text-text-tertiary">cargando…</p>}
      {bandejas.isError && (
        <p role="alert" className="mb-1 text-err">{bandejas.data ? "sin conexión — mostrando la última foto" : "sin conexión con el servidor"}</p>
      )}
      <ul>
        {(bandejas.data ?? []).map((b) => {
          const ind = indicador(b);
          const abierto = abiertos.includes(b.rol);
          const linea = lineaActual(b);
          return (
            <li key={b.rol}>
              <button aria-expanded={abierto} className="flex w-full items-start gap-2 px-1 py-1 text-left hover:bg-white/10" onClick={() => toggle(b.rol)}>
                <span aria-hidden="true" className="mt-1.5 h-2.5 w-2.5 shrink-0" style={{ background: colorRol(b.rol) }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-pixel text-[11px]" style={{ color: colorRol(b.rol) }}>{b.nombre.toUpperCase()}</span>
                    <span className={`font-pixel text-[10px] ${TONE[ind.tone]}`}>{ind.texto}</span>
                  </span>
                  {linea && <span className="block truncate text-text-secondary" title={linea}>{linea}</span>}
                </span>
              </button>
              {abierto && (
                <div className="mb-1 ml-5 border-l-2 border-edge pl-2">
                  {GRUPOS.map(([g, label]) => (b[g].length ? (
                    <div key={g}>
                      <p className="font-pixel text-[10px] text-text-tertiary">
                        {label}{b.total[g] > b[g].length ? ` · y ${b.total[g] - b[g].length} más` : ""}
                      </p>
                      <ul>
                        {b[g].map((t) => (
                          <li key={t.id}>
                            <button className="w-full truncate py-0.5 text-left hover:bg-white/10 disabled:opacity-50" disabled={talkActive} title={talkActive ? "Termina la plática para abrir tareas" : `${t.titulo} — ${t.meta}`} onClick={() => abrir(t)}>
                              {t.titulo}<span className="text-text-tertiary"> · {t.cuenta ?? "—"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null))}
                  {ind.tone === "idle" && <p className="text-text-tertiary">sin tareas</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CuentasSection() {
  const { view, talkActive, setView } = useAppState();
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list, refetchInterval: 60_000 });
  const pools = groupByPool(accounts.map((a) => ({
    id: a.id, label: a.label, active: a.active, pool: a.pool, quotaBlockedUntil: a.quotaBlockedUntil, poolShortPct: a.poolUsage?.short.pct ?? a.usage.short.pct,
  })));
  return (
    <section aria-label="Cuentas">
      <p className="mb-1 font-pixel text-[11px] text-text-secondary">CUENTAS</p>
      <ul>
        {pools.map((p) => (
          <li key={p.key} className="flex items-center justify-between gap-2">
            <span className="truncate">{p.accounts.some((a) => a.active) && <><span aria-hidden="true">● </span><span className="sr-only">cuenta local </span></>}{p.accounts.map((a) => a.label).join(", ")}</span>
            <span className={p.blocked ? "text-err" : "text-text-secondary"}>{p.blocked ? <><span aria-hidden="true">⛔</span><span className="sr-only">bloqueada</span></> : p.pct !== null ? `${p.pct}%` : "—"}</span>
          </li>
        ))}
        {pools.length === 0 && <li className="text-text-tertiary">sin cuentas de agy</li>}
      </ul>
      <p className="mt-2 font-pixel text-[10px] text-text-tertiary">CLAUDE</p>
      <AdapterUsage adapter="claude" />
      <p className="mt-2 font-pixel text-[10px] text-text-tertiary">CODEX</p>
      <AdapterUsage adapter="codex" />
      <button className="px-btn mt-3 w-full" disabled={viewLocked("ajustes", view, talkActive)} onClick={() => setView("ajustes")}>AJUSTES</button>
    </section>
  );
}

/** Barra lateral (F15): el equipo en vivo y las cuentas en compacto. */
export function TeamSidebar() {
  return (
    <div className="flex flex-col gap-4 px-2 pb-3">
      <EquipoSection />
      <CuentasSection />
    </div>
  );
}
