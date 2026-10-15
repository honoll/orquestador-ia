import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { roleColor, roleTag, ROLE_TEMPLATE } from "../lib/roles";

// Espejo de GET /api/roles (src/server/routes/roles.ts).
interface RoleRow { id: string; nombre?: string; modelo?: string; escribe?: boolean | "salidas"; error?: string; original: boolean }

const escribeTxt = (e: RoleRow["escribe"]) => (e === "salidas" ? "salidas" : e ? "escribe" : "lee");
const JSON_HEADERS = { "Content-Type": "application/json" };

async function errorOf(r: Response): Promise<string> {
  const b = await r.json().catch(() => null) as { error?: string } | null;
  return b?.error ?? `HTTP ${r.status}`;
}

/** Vista "Roles": lista de roles + editor del markdown (guardar, restaurar original, nuevo rol). */
export function RolesView() {
  const qc = useQueryClient();
  const { data: roles = [], isError } = useQuery({
    queryKey: ["roles"],
    queryFn: async (): Promise<RoleRow[]> => {
      const r = await fetch("/api/roles");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  // selected === null → rol nuevo (POST); si no, se edita ese id (PUT).
  const [selected, setSelected] = useState<string | null>("dev");
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = roles.find((r) => r.id === selected);
  // Si "dev" (u otro id elegido) ya no existe, abre el primero de la lista.
  useEffect(() => {
    if (selected !== null && roles.length > 0 && !current) setSelected(roles[0].id);
  }, [roles, selected, current]);

  useEffect(() => {
    setError(null); setNotice(null); setDirty(false);
    if (selected === null) { setText(ROLE_TEMPLATE); return; }
    let live = true;
    fetch(`/api/roles/${encodeURIComponent(selected)}`)
      .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(await errorOf(r)))))
      .then((t) => { if (live) setText(t); })
      .catch((e: Error) => { if (live) { setText(""); setError(e.message); } });
    return () => { live = false; };
  }, [selected]);

  const pick = (id: string | null) => {
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Descartarlos?")) return;
    setSelected(id);
  };

  const save = async () => {
    setError(null); setNotice(null);
    const r = await fetch(selected === null ? "/api/roles" : `/api/roles/${encodeURIComponent(selected)}`, {
      method: selected === null ? "POST" : "PUT", headers: JSON_HEADERS, body: JSON.stringify({ markdown: text }),
    }).catch(() => null);
    if (!r?.ok) { setError(r ? await errorOf(r) : "Sin conexión con el servidor"); return; }
    const created = selected === null ? ((await r.json()) as { id: string }).id : null;
    await qc.invalidateQueries({ queryKey: ["roles"] });
    setDirty(false);
    if (created) setSelected(created);
    setNotice(created ? `Rol "${created}" creado` : "Guardado");
  };

  const restore = async () => {
    if (!selected || !window.confirm(`¿Restaurar "${selected}" a su versión original? Se pierden tus cambios.`)) return;
    setError(null); setNotice(null);
    const r = await fetch(`/api/roles/${encodeURIComponent(selected)}/restore`, { method: "POST", headers: JSON_HEADERS, body: "{}" }).catch(() => null);
    if (!r?.ok) { setError(r ? await errorOf(r) : "Sin conexión con el servidor"); return; }
    const x = await fetch(`/api/roles/${encodeURIComponent(selected)}`).catch(() => null);
    if (!x?.ok) { setError(x ? await errorOf(x) : "Sin conexión con el servidor"); return; }
    setText(await x.text()); setDirty(false); setNotice("Restaurado al original");
    void qc.invalidateQueries({ queryKey: ["roles"] });
  };

  return (
    <div className="flex h-full min-h-0 text-xs text-text-secondary">
      <nav aria-label="Roles" className="px-grid flex w-64 shrink-0 flex-col border-r-[3px] border-edge bg-[#0b0b0e]">
        <p className="px-4 pb-2 pt-4 font-pixel text-[11px] text-text-tertiary">ROLES DE AGENTES</p>
        {isError && <p role="alert" className="mx-3 border-[3px] border-err bg-err/10 px-2 py-1 text-err">No se pudo leer la lista de roles</p>}
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-1">
          {roles.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-current={selected === r.id ? "true" : undefined}
                onClick={() => pick(r.id)}
                className={`px-panel flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-surface-2! ${selected === r.id ? "bg-surface-3!" : ""}`}
                style={{ borderColor: roleColor(r.id) }}
              >
                <span className="flex items-center gap-2">
                  <span className="font-pixel text-[12px]" style={{ color: roleColor(r.id) }}>{r.nombre ?? roleTag(r.id)}</span>
                  {r.error
                    ? <span className="ml-auto text-err" title={r.error}>✗ error</span>
                    : <span className="ml-auto text-ok" aria-label="válido">✓</span>}
                </span>
                <span className="truncate text-text-tertiary">
                  {r.error ? `${r.id}.md` : `${r.modelo} · ${escribeTxt(r.escribe)}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => pick(null)}
          className={`px-btn m-3 py-1 ${selected === null ? "px-btn-pri" : ""}`}
        >
          + NUEVO ROL
        </button>
      </nav>

      <section className="flex min-w-0 flex-1 flex-col gap-2 p-4" aria-label="Editor de rol">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-pixel text-[12px] text-text-primary">{selected === null ? "NUEVO ROL (DESDE PLANTILLA)" : <span className="font-mono text-[13px]">{selected}.md</span>}</h2>
          {dirty && <span className="px-tag text-accent">SIN GUARDAR</span>}
          <span className="ml-auto" />
          {selected !== null && current?.original && (
            <button type="button" onClick={() => void restore()} className="px-btn">
              RESTAURAR ORIGINAL
            </button>
          )}
          <button type="button" onClick={() => void save()} disabled={!text.trim()} className="px-btn px-btn-pri">
            {selected === null ? "CREAR ROL" : "GUARDAR"}
          </button>
        </div>
        {error && <p role="alert" className="whitespace-pre-wrap border-[3px] border-err bg-err/10 px-3 py-2 text-sm text-err shadow-[3px_3px_0_#000]">{error}</p>}
        {notice && <p role="status" className="text-sm text-ok">{notice}</p>}
        <label htmlFor="role-editor" className="sr-only">Markdown del rol</label>
        <textarea
          id="role-editor"
          value={text}
          onChange={(e) => { setText(e.target.value); setDirty(true); setNotice(null); }}
          spellCheck={false}
          className="px-input min-h-0 flex-1 resize-none p-3 font-mono text-[13px] leading-relaxed"
        />
        <p className="text-text-tertiary">
          Frontmatter (id, nombre, modelo, escribe, herramientasPermitidas) y las 6 secciones en orden. Se valida al guardar; los cambios se usan sin reiniciar.
        </p>
      </section>
    </div>
  );
}
