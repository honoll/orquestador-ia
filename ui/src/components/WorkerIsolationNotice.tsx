import { useMutation, useQuery } from "@tanstack/react-query";

interface WorkersStatus {
  claude: { isolated: boolean };
  agy: { isolated: boolean };
  codex: { isolated: boolean; home: string };
}

const btn = "min-h-6 px-2 text-left hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

export function WorkerIsolationNotice() {
  const { data, refetch } = useQuery<WorkersStatus>({
    queryKey: ["workers-status"],
    queryFn: async () => {
      const r = await fetch("/api/workers/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 60_000,
  });
  const login = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/workers/codex/login-terminal", { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    },
  });
  if (!data) return null;

  return (
    <section aria-labelledby="aislamiento-titulo" className="space-y-1 border-t border-edge px-4 py-3 font-mono text-[11px] text-text-secondary">
      <h2 id="aislamiento-titulo" className="break-words text-text-tertiary">aislamiento de trabajadores</h2>
      {data.codex.isolated ? (
        <>
          <p className="text-ok">codex: aislado ✓</p>
          <p className="break-words text-text-tertiary">claude: aislado ✓ · agy: sin globales ✓</p>
        </>
      ) : (
        <>
          <p className="break-words text-accent">Codex aislado parcialmente: inicia la sesión del perfil de trabajadores (una vez)</p>
          <div className="flex flex-col items-start gap-0.5">
            <button type="button" className={btn} disabled={login.isPending} onClick={() => login.mutate()}>
              iniciar sesión de Codex para trabajadores
            </button>
            <button type="button" className={btn} onClick={() => { void refetch(); }}>ya inicié sesión</button>
          </div>
          {login.isError && <p className="break-words text-err">{(login.error as Error).message}</p>}
        </>
      )}
    </section>
  );
}
