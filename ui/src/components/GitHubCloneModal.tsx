import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWs } from "../context/WebSocketProvider";

interface GitHubCloneModalProps {
  initialUrl?: string;
  onClose: () => void;
  onCloned?: (projectId: string | null, destination: string) => void;
}

export function GitHubCloneModal({ initialUrl = "", onClose, onCloned }: GitHubCloneModalProps) {
  const { lastEvent, logs } = useWs();
  const qc = useQueryClient();

  const [url, setUrl] = useState(initialUrl);
  const [destination, setDestination] = useState("C:\\proyectos");
  const [createProject, setCreateProject] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  // Derive repo name from URL for project name suggestion
  useEffect(() => {
    if (!url) return;
    const clean = url.replace(/\.git$/, "");
    const parts = clean.replace("git@github.com:", "").replace(/https?:\/\/github\.com\//, "").split("/");
    const name = parts[parts.length - 1];
    if (name) setProjectName(name);
  }, [url]);

  // Listen for github WS events
  useEffect(() => {
    if (!lastEvent || !jobId) return;
    const e = lastEvent as any;
    if (e.jobId !== jobId) return;

    if (e.type === "github:done") {
      setDone(true);
      if (e.succeeded) {
        setSucceeded(true);
        if (e.projectId) qc.invalidateQueries({ queryKey: ["projects"] });
        onCloned?.(e.projectId, e.destination);
      } else {
        setError(e.error || "Clone failed");
      }
    }
  }, [lastEvent, jobId, qc, onCloned]);

  const cloneLog = jobId ? (logs.get(`gh:${jobId}`) ?? "") : "";

  async function handleClone() {
    setError(null);
    setDone(false);
    setSucceeded(false);

    const res = await fetch("/api/github/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.trim(),
        destination: destination.trim(),
        createProject,
        projectName: projectName.trim() || undefined,
      }),
    });

    if (!res.ok) {
      setError(await res.text());
      return;
    }
    const data = await res.json();
    setJobId(data.jobId);
  }

  async function handleCancel() {
    if (jobId) await fetch(`/api/github/${jobId}/cancel`, { method: "POST" });
    onClose();
  }

  const isCloning = !!jobId && !done;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={isCloning ? undefined : onClose} />
      <div className="relative z-10 bg-surface-1 border border-edge rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
          <div className="flex items-center gap-2">
            <span className="text-sm">⬇</span>
            <span className="font-mono text-xs text-text-primary">clonar repositorio</span>
          </div>
          {!isCloning && (
            <button onClick={onClose} className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary">✕</button>
          )}
        </div>

        <div className="p-5 space-y-4">
          {!jobId ? (
            <>
              {/* URL input */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
                  url o usuario/repo
                </label>
                <input
                  className="w-full bg-surface-0 border border-edge rounded-lg px-3 py-2.5 font-mono text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  placeholder="https://github.com/usuario/repo  o  usuario/repo"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  autoFocus
                />
                <p className="font-mono text-[9px] text-text-tertiary">
                  repos privados: usa <code className="text-accent">gh auth login</code> primero
                </p>
              </div>

              {/* Destination */}
              <div className="space-y-1.5">
                <label className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
                  carpeta destino
                </label>
                <input
                  className="w-full bg-surface-0 border border-edge rounded-lg px-3 py-2.5 font-mono text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent transition-colors"
                  placeholder="C:\proyectos"
                  value={destination}
                  onChange={e => setDestination(e.target.value)}
                />
                {url && projectName && (
                  <p className="font-mono text-[9px] text-text-tertiary">
                    se clonará en: <span className="text-accent">{destination}\\{projectName}</span>
                  </p>
                )}
              </div>

              {/* Create project option */}
              <label className="flex items-center gap-3 cursor-pointer group">
                <div
                  onClick={() => setCreateProject(!createProject)}
                  className={`h-4 w-4 rounded border flex items-center justify-center transition-colors cursor-pointer ${
                    createProject ? "bg-accent border-accent" : "border-edge-strong bg-surface-0"
                  }`}
                >
                  {createProject && <span className="text-surface-0 text-[10px]">✓</span>}
                </div>
                <span className="font-mono text-xs text-text-secondary group-hover:text-text-primary transition-colors">
                  crear proyecto en el orquestador
                </span>
              </label>

              {createProject && (
                <div className="space-y-1.5 pl-7">
                  <label className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
                    nombre del proyecto
                  </label>
                  <input
                    className="w-full bg-surface-0 border border-edge rounded-lg px-3 py-2 font-mono text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent transition-colors"
                    placeholder={projectName || "nombre"}
                    value={projectName}
                    onChange={e => setProjectName(e.target.value)}
                  />
                </div>
              )}

              {error && (
                <p className="font-mono text-xs text-err bg-err/10 rounded-lg px-3 py-2">{error}</p>
              )}

              <button
                onClick={handleClone}
                disabled={!url.trim() || !destination.trim()}
                className="w-full font-mono text-[11px] text-ok hover:text-text-primary border border-ok/30 hover:border-ok/50 rounded-lg py-2.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                clonar
              </button>
            </>
          ) : (
            <>
              {/* Progress view */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  {isCloning ? (
                    <>
                      <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse-dot" />
                      <span className="font-mono text-xs text-text-secondary">clonando...</span>
                    </>
                  ) : succeeded ? (
                    <>
                      <span className="text-ok">✓</span>
                      <span className="font-mono text-xs text-ok">clonado exitosamente</span>
                    </>
                  ) : (
                    <>
                      <span className="text-err">✗</span>
                      <span className="font-mono text-xs text-err">error al clonar</span>
                    </>
                  )}
                </div>

                {/* Stream log */}
                <CloneLog jobId={jobId} />

                {error && (
                  <p className="font-mono text-xs text-err bg-err/10 rounded-lg px-3 py-2 whitespace-pre-wrap">{error}</p>
                )}

                <div className="flex gap-2">
                  {isCloning ? (
                    <button
                      onClick={handleCancel}
                      className="flex-1 font-mono text-[11px] text-err hover:text-text-primary border border-err/30 rounded-lg py-2 transition-colors"
                    >
                      cancelar
                    </button>
                  ) : (
                    <button
                      onClick={onClose}
                      className="flex-1 font-mono text-[11px] text-accent hover:text-text-primary border border-accent/30 rounded-lg py-2 transition-colors"
                    >
                      {succeeded ? "listo" : "cerrar"}
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CloneLog({ jobId }: { jobId: string }) {
  const { logs } = useWs();
  const log = logs.get(`gh:${jobId}`) ?? "";

  return (
    <div className="bg-surface-0 rounded-lg border border-edge h-40 overflow-y-auto">
      {log ? (
        <pre className="font-mono text-[10px] text-text-secondary whitespace-pre-wrap leading-relaxed p-3">
          {log}
        </pre>
      ) : (
        <div className="flex items-center gap-2 p-3">
          <span className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" />
          <span className="font-mono text-[10px] text-text-tertiary">iniciando...</span>
        </div>
      )}
    </div>
  );
}
