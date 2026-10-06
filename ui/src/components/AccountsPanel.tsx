import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountsApi, type AccountView, type WindowUsage } from "../lib/accounts-api";
import { formatIn, formatTokens } from "../lib/format";

function UsageLine({ w, name }: { w: WindowUsage; name: string }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-text-tertiary">{name}</span>
        <span className="min-w-0 truncate text-right">{w.pct !== null ? `~${w.pct} %` : `${formatTokens(w.usedTokens)} tok`}</span>
      </div>
      <span className="relative block h-1 w-full overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {w.pct !== null && <span className={`absolute inset-y-0 left-0 ${w.pct >= 85 ? "bg-err" : "bg-ok"}`} style={{ width: `${w.pct}%` }} />}
      </span>
      {w.resetsAt && <p className="break-words text-text-tertiary">reinicia en {formatIn(w.resetsAt - Date.now())}</p>}
    </div>
  );
}

function LimitInput({ label, ariaLabel, value, onSave }: { label: string; ariaLabel: string; value: number | null; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value?.toString() ?? "");
  return (
    <label className="block min-w-0">
      <span className="block text-text-tertiary">{label}</span>
      <input
        aria-label={ariaLabel}
        inputMode="numeric"
        className="w-full min-w-0 rounded border border-edge bg-surface-0 px-1.5 py-0.5 text-text-primary"
        value={draft}
        placeholder="auto"
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => onSave(draft ? Number(draft) : null)}
      />
    </label>
  );
}

function AccountCard({ a }: { a: AccountView }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["accounts"] });
  const activate = useMutation({ mutationFn: () => accountsApi.activate(a.id), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => accountsApi.remove(a.id), onSuccess: refresh });
  const update = useMutation({ mutationFn: (p: Parameters<typeof accountsApi.update>[1]) => accountsApi.update(a.id, p), onSuccess: refresh });

  return (
    <li className={`min-w-0 space-y-1.5 rounded-lg border px-3 py-2 ${a.active ? "border-ok/50" : "border-edge"}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate text-text-primary">{a.label}</span>
        {a.active && <span className="text-ok">activa</span>}
        <span className="ml-auto flex flex-wrap gap-x-2">
          {!a.active && <button className="hover:text-text-primary" onClick={() => activate.mutate()}>usar esta</button>}
          <button
            className="hover:text-err"
            onClick={() => { if (confirm(`¿Eliminar la cuenta "${a.label}" y su historial de uso?`)) remove.mutate(); }}
          >
            eliminar
          </button>
        </span>
      </div>
      <UsageLine w={a.usage.short} name="5 h" />
      <UsageLine w={a.usage.long} name="7 d" />
      {a.warn.warn && <p className="break-words text-err">{a.warn.reason}</p>}
      <details>
        <summary className="cursor-pointer text-text-tertiary">topes (tokens)</summary>
        <div className="mt-1 min-w-0 space-y-1">
          <LimitInput label="5 h manual" ariaLabel="Tope manual de 5 h en tokens" value={a.manualLimit5h} onSave={(v) => update.mutate({ manualLimit5h: v })} />
          <LimitInput label="7 d manual" ariaLabel="Tope manual de 7 d en tokens" value={a.manualLimit7d} onSave={(v) => update.mutate({ manualLimit7d: v })} />
          <p className="break-words text-text-tertiary">calibrado 5 h: {a.calibratedLimit5h ? formatTokens(a.calibratedLimit5h) : "aún no (se fija con el primer error de cuota)"}</p>
        </div>
      </details>
      {update.error && <p className="text-err">{(update.error as Error).message}</p>}
    </li>
  );
}

export function AccountsPanel() {
  const qc = useQueryClient();
  const { data: accounts = [] } = useQuery({ queryKey: ["accounts"], queryFn: accountsApi.list, refetchInterval: 60_000 });
  const [label, setLabel] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => accountsApi.create(label),
    onSuccess: () => { setLabel(""); qc.invalidateQueries({ queryKey: ["accounts"] }); },
  });
  const openTerminal = useMutation({
    mutationFn: accountsApi.openSwitchTerminal,
    onSuccess: () => setHint("Se abrió agy en una terminal: cierra sesión ahí, entra con la otra cuenta y luego marca aquí cuál quedó activa."),
    onError: (e) => setHint((e as Error).message),
  });

  return (
    <section aria-labelledby="cuentas-titulo" className="space-y-2 border-t border-edge px-4 py-3 font-mono text-[11px] text-text-secondary">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        <h2 id="cuentas-titulo" className="min-w-0 break-words text-text-tertiary">cuentas antigravity</h2>
        <button className="ml-auto break-words hover:text-text-primary" onClick={() => openTerminal.mutate()}>cambiar cuenta</button>
      </div>
      {hint && <p role="status" className="break-words text-text-primary">{hint}</p>}
      <ul className="min-w-0 space-y-2">{accounts.map((a) => <AccountCard key={a.id} a={a} />)}</ul>
      <form
        className="flex min-w-0 flex-col gap-1.5"
        onSubmit={(e) => { e.preventDefault(); if (label.trim()) create.mutate(); }}
      >
        <input
          aria-label="Etiqueta de la cuenta nueva"
          className="w-full min-w-0 rounded border border-edge bg-surface-0 px-1.5 py-0.5 text-text-primary"
          placeholder="p. ej. Familia A · usuario 2"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="self-start hover:text-text-primary">agregar</button>
      </form>
      {create.error && <p className="text-err">{(create.error as Error).message}</p>}
      <p className="break-words text-text-tertiary">El uso es una estimación local. El orquestador nunca cambia de cuenta solo.</p>
    </section>
  );
}
