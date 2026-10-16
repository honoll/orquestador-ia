import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useWs } from "../../context/WebSocketProvider";
import { useAppState } from "../../context/AppStateContext";
import { roleColor } from "../../lib/roles";
import { formatTokens } from "../../lib/format";
import { stripStatusLine } from "../../lib/step-status";
import { ESTADO_TAREA, PAUSA, metaLabel, refreshesEquipo, treeRows, type MetaDetalle, type MetaView } from "../../lib/equipo";

const TONE: Record<string, string> = { run: "text-blue", ok: "text-ok", err: "text-err", wait: "text-warn", idle: "text-text-secondary" };

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Error ${r.status}`);
  return r.json();
}

/** Vista Equipo (F14): metas, árbol de tareas en vivo, comentarios y controles. */
export function EquipoView() {
  const qc = useQueryClient();
  const { subscribe } = useWs();
  const { selectedProjectId, setProject, equipoFocus, setEquipoFocus } = useAppState();
  const proyectos = useQuery({ queryKey: ["projects"], queryFn: () => api<{ id: string; name: string }[]>("/api/projects") });
  const metas = useQuery({ queryKey: ["equipo"], queryFn: () => api<MetaView[]>("/api/equipo/metas") });
  const [metaId, setMetaId] = useState<string | null>(null);
  const actual = metaId ?? metas.data?.[0]?.id ?? null;
  const detalle = useQuery({ queryKey: ["equipo", actual], queryFn: () => api<MetaDetalle>(`/api/equipo/metas/${actual}`), enabled: !!actual });
  const [tareaId, setTareaId] = useState<string | null>(null);
  const [pedido, setPedido] = useState("");
  const [comentario, setComentario] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // F15: la barra lateral pide abrir una meta y tarea concretas.
  useEffect(() => {
    if (!equipoFocus) return;
    setMetaId(equipoFocus.metaId);
    setTareaId(equipoFocus.tareaId);
    setError(null);
    setEquipoFocus(null);
  }, [equipoFocus, setEquipoFocus]);

  useEffect(() => subscribe((ev) => {
    if (!refreshesEquipo(ev.type)) return;
    void qc.invalidateQueries({ queryKey: ["equipo"] });
  }), [subscribe, qc]);

  const rows = useMemo(() => treeRows(detalle.data?.tareas ?? []), [detalle.data]);
  const tarea = detalle.data?.tareas.find((t) => t.id === tareaId) ?? rows[0]?.tarea ?? null;
  const hilo = (detalle.data?.comentarios ?? []).filter((c) => c.tareaId === tarea?.id);
  const meta = detalle.data?.meta;
  const activa = meta && !["completed", "failed", "cancelled"].includes(meta.estado);

  const run = (fn: () => Promise<unknown>) => async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await fn(); await qc.invalidateQueries({ queryKey: ["equipo"] }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const queryError = (metas.error ?? detalle.error) as Error | null;
  const elegir = (id: string) => { setMetaId(id); setTareaId(null); setError(null); };
  const crear = run(async () => {
    const { id } = await api<{ id: string }>("/api/equipo/metas", { pedido, projectId: selectedProjectId });
    setPedido(""); setMetaId(id); setTareaId(null);
  });
  const comentar = run(async () => {
    if (!actual || !tarea) return;
    await api(`/api/equipo/metas/${actual}/comentarios`, { tareaId: tarea.id, texto: comentario });
    setComentario("");
  });

  return (
    <div className="grid h-full grid-cols-[260px_minmax(0,1fr)] gap-3 overflow-hidden bg-surface-0 p-3 text-text-primary">
      <aside className="px-panel flex min-h-0 flex-col gap-2 bg-surface-1 p-2">
        <p className="font-pixel text-[11px] text-text-secondary">NUEVA META</p>
        <textarea className="px-input h-24 resize-none" value={pedido} onChange={(e) => setPedido(e.target.value)} placeholder="¿Qué quieres que haga el equipo?" aria-label="Pedido de la nueva meta" />
        {/* Sin proyecto la meta escribiría en la carpeta del orquestador: el servidor la rechaza y aquí no se lanza. */}
        <select className="px-input" value={selectedProjectId ?? ""} onChange={(e) => setProject(e.target.value || null)} aria-label="Proyecto de la nueva meta">
          <option value="">— elige un proyecto —</option>
          {(proyectos.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {!selectedProjectId && <p className="text-text-secondary">Elige aquí el proyecto donde trabajará el equipo.</p>}
        <button className="px-btn px-btn-pri" disabled={busy || !pedido.trim() || !selectedProjectId} onClick={crear}>LANZAR</button>
        <p className="mt-2 font-pixel text-[11px] text-text-secondary">METAS</p>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {(metas.data ?? []).map((m) => (
            <li key={m.id}>
              <button className={`w-full px-1 py-1 text-left hover:bg-white/10 ${m.id === actual ? "bg-white/10" : ""}`} aria-current={m.id === actual ? "true" : undefined} onClick={() => elegir(m.id)}>
                <span className="block truncate">{m.pedido}</span>
                <span className="font-pixel text-[10px] text-text-secondary">{metaLabel(m.estado)}{m.pausa ? ` · ${PAUSA[m.pausa] ?? m.pausa}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="@container flex min-h-0 flex-col gap-3 overflow-y-auto">
        {(error || queryError) && <p role="alert" className="px-panel border-err! px-2 py-1 text-err">{error ?? queryError?.message}</p>}
        {!meta ? (
          <p className="text-text-secondary">
            {actual ? (detalle.isPending ? "cargando…" : "") : metas.isPending ? "cargando…" : metas.data?.length === 0 ? "Lanza una meta para ver al equipo trabajando." : ""}
          </p>
        ) : (
          <>
            <header className="px-panel flex flex-wrap items-center gap-2 bg-surface-1 p-2">
              <h2 className="mr-auto font-pixel text-[13px]">{meta.pedido}</h2>
              <span className="text-text-secondary">{metaLabel(meta.estado)}{meta.pausa ? ` · ${PAUSA[meta.pausa] ?? meta.pausa}` : ""}</span>
              <span className="text-text-secondary">{formatTokens(meta.usados)}{meta.presupuesto ? ` / ${formatTokens(meta.presupuesto)}` : ""} tok</span>
              {activa && !meta.pausa && <button className="px-btn" disabled={busy} onClick={run(() => api(`/api/equipo/metas/${meta.id}/pausar`, {}))}>PAUSAR</button>}
              {activa && (meta.pausa || meta.estado === "pending") && <button className="px-btn px-btn-blue" disabled={busy} onClick={run(() => api(`/api/equipo/metas/${meta.id}/continuar`, {}))}>CONTINUAR</button>}
              {activa && <button className="px-btn" disabled={busy} onClick={run(() => api(`/api/equipo/metas/${meta.id}/cancelar`, {}))}>CANCELAR</button>}
            </header>

            <div className="grid min-h-0 gap-3 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <ul className="px-panel bg-surface-1 p-2" aria-label="Tareas de la meta">
                {rows.map(({ tarea: t, nivel }) => {
                  const est = ESTADO_TAREA[t.estado] ?? { label: t.estado, tone: "idle" as const };
                  return (
                    <li key={t.id}>
                      <button className={`flex w-full items-center gap-2 py-1 text-left hover:bg-white/10 ${t.id === tarea?.id ? "bg-white/10" : ""}`} style={{ paddingLeft: 8 + nivel * 16 }} aria-current={t.id === tarea?.id ? "true" : undefined} onClick={() => setTareaId(t.id)}>
                        <span className="px-tag" style={{ color: roleColor(t.rol) }}>{t.rol.toUpperCase()}</span>
                        <span className="min-w-0 flex-1 truncate">{t.titulo}</span>
                        <span className={`font-pixel text-[10px] ${TONE[est.tone]}`}>{est.label}{t.guardia ? " · guardia" : ""}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              {tarea && (
                <div className="px-panel flex flex-col gap-2 bg-surface-1 p-2">
                  <p className="font-pixel text-[11px] text-text-secondary">
                    {tarea.rol.toUpperCase()} · {tarea.cuenta ?? "sin cuenta"} · {tarea.turnos} turno(s) · {formatTokens(tarea.tokens)} tok
                  </p>
                  {tarea.guardia && meta.pausa === "guard" && (
                    <button className="px-btn px-btn-pri self-start" disabled={busy} onClick={run(() => api(`/api/equipo/metas/${meta.id}/tareas/${tarea.id}/aprobar`, {}))}>APROBAR ESTA TAREA</button>
                  )}
                  <details><summary className="cursor-pointer text-text-secondary">instrucciones</summary><pre className="font-code whitespace-pre-wrap">{tarea.instrucciones}</pre></details>
                  {tarea.detalle && <p className="text-text-secondary">{tarea.detalle}</p>}
                  {tarea.resultado && <pre className="font-code max-h-64 overflow-y-auto whitespace-pre-wrap">{stripStatusLine(tarea.resultado)}</pre>}
                  <p className="font-pixel text-[11px] text-text-secondary">COMENTARIOS</p>
                  <ul className="flex flex-col gap-1">
                    {hilo.map((c) => <li key={c.id}><span className="text-accent">{c.autor}:</span> <span className="whitespace-pre-wrap">{c.texto}</span></li>)}
                  </ul>
                  {activa && (
                    <>
                      <textarea className="px-input h-16 resize-none" value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Comenta (despierta al dueño). @rol hace una consulta." aria-label="Comentario para la tarea" />
                      <button className="px-btn self-start" disabled={busy || !comentario.trim()} onClick={comentar}>COMENTAR</button>
                    </>
                  )}
                </div>
              )}
            </div>

            {meta.respuesta && (
              <article className="px-panel bg-surface-1 p-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripStatusLine(meta.respuesta)}</ReactMarkdown>
              </article>
            )}
            {meta.error && <p className="text-err">{meta.error}</p>}
          </>
        )}
      </section>
    </div>
  );
}
