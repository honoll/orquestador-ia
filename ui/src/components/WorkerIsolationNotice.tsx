import { useMutation, useQuery } from "@tanstack/react-query";

interface WorkersStatus {
  claude: { isolated: boolean };
  agy: { isolated: boolean };
  codex: { isolated: boolean; home: string };
}

const btn =
  "min-h-6 px-2 text-left underline decoration-dotted underline-offset-2 border border-edge rounded-sm hover:text-text-primary disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

async function fetchStatus(fresh = false): Promise<WorkersStatus> {
  const r = await fetch(fresh ? "/api/workers/status?fresh=1" : "/api/workers/status");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function WorkerIsolationNotice() {
  const { data, refetch, isFetching } = useQuery<WorkersStatus>({
    queryKey: ["workers-status"],
    queryFn: () => fetchStatus(),
    refetchInterval: 60_000,
  });
  const login = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/workers/codex/login-terminal", { method: "POST" });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
    },
  });
  const recheck = useMutation({
    mutationFn: async () => {
      const fresh = await fetchStatus(true);
      await refetch();
      return fresh;
    },
  });
  if (!data) return null;

  const claudeLine = `claude: ${data.claude.isolated ? "aislado ✓" : "sin aislar"}`;
  const agyLine = `agy: ${data.agy.isolated ? "sin globales ✓" : "sin aislar"}`;

  return (
    <section aria-labelledby="aislamiento-titulo" className="space-y-1 border-t border-edge px-4 py-3 font-mono text-[11px] text-text-secondary">
      <h2 id="aislamiento-titulo" className="break-words text-text-tertiary">aislamiento de trabajadores</h2>
      {data.codex.isolated ? (
        <>
          <p role="status" className="text-ok">codex: aislado ✓</p>
          <p className="break-words text-text-tertiary">{claudeLine} · {agyLine}</p>
        </>
      ) : (
        <>
          <p role="status" className="break-words text-accent">Codex aislado parcialmente: inicia la sesión del perfil de trabajadores (una vez)</p>
          <p className="break-words text-text-tertiary">{claudeLine}</p>
          <p className="break-words text-text-tertiary">{agyLine}</p>
          <div className="flex flex-col items-start gap-1">
            <button type="button" className={btn} disabled={login.isPending} aria-busy={login.isPending} onClick={() => login.mutate()}>
              iniciar sesión de Codex para trabajadores
            </button>
            <button type="button" className={btn} disabled={recheck.isPending || isFetching} aria-busy={recheck.isPending || isFetching} onClick={() => recheck.mutate()}>
              ya inicié sesión
            </button>
          </div>
          <p className="break-words text-text-tertiary">
            Perfil: <code>{data.codex.home}</code>. Manual: <code>{`set CODEX_HOME=${data.codex.home} && codex login`}</code>
          </p>
          {login.isError && <p role="alert" className="break-words text-err">{(login.error as Error).message}</p>}
          {recheck.isError && <p role="alert" className="break-words text-err">{(recheck.error as Error).message}</p>}
        </>
      )}
    </section>
  );
}
