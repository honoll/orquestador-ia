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
      <div className="absolute inset-0 bg-black/70" onClick={isCloning ? undefined : onClose} />
      <div className="px-panel relative z-10 w-full max-w-md mx-4 overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b-[3px] border-edge">
          <div className="flex items-center gap-2">
            <span className="text-sm">⬇</span>
            <span className="font-pixel text-[12px] text-text-primary">CLONAR REPOSITORIO</span>
          </div>
          {!isCloning && (
            <button onClick={onClose} aria-label="Cerrar" className="px-btn px-2">✕</button>
          )}
        </div>

        <div className="p-5 space-y-4">
          {!jobId ? (
            <>
              {/* URL input */}
              <div className="space-y-1.5">
                <label className="block font-pixel text-[11px] text-text-tertiary">
                  URL O USUARIO/REPO
                </label>
                <input
                  className="px-input w-full px-3 py-2 font-code focus:border-accent!"
                  placeholder="https://github.com/usuario/repo  o  usuario/repo"
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  autoFocus
                />
                <p className="text-xs text-text-tertiary">
                  repos privados: usa <code className="text-accent">gh auth login</code> primero
                </p>
              </div>

              {/* Destination */}
              <div className="space-y-1.5">
                <label className="block font-pixel text-[11px] text-text-tertiary">
                  CARPETA DESTINO
                </label>
                <input
                  className="px-input w-full px-3 py-2 font-code focus:border-accent!"
                  placeholder="C:\proyectos"
                  value={destination}
                  onChange={e => setDestination(e.target.value)}
                />
                {url && projectName && (
                  <p className="text-xs text-text-tertiary">
                    se clonará en: <span className="font-mono text-[12px] text-accent">{destination}\\{projectName}</span>
                  </p>
                )}
              </div>

              {/* Create project option */}
              <label className="flex items-center gap-3 cursor-pointer group">
                <div
                  onClick={() => setCreateProject(!createProject)}
                  className={`h-5 w-5 border-2 flex items-center justify-center transition-colors cursor-pointer ${
                    createProject ? "bg-accent border-accent" : "border-edge-strong bg-surface-0"
                  }`}
                >
                  {createProject && <span className="text-surface-0 text-xs leading-none">✓</span>}
                </div>
                <span className="text-sm text-text-secondary group-hover:text-text-primary transition-colors">
                  crear proyecto en el orquestador
                </span>
              </label>

              {createProject && (
                <div className="space-y-1.5 pl-7">
                  <label className="block font-pixel text-[11px] text-text-tertiary">
                    NOMBRE DEL PROYECTO
                  </label>
                  <input
                    className="px-input w-full px-3 py-2 text-sm focus:border-accent!"
                    placeholder={projectName || "nombre"}
                    value={projectName}
                    onChange={e => setProjectName(e.target.value)}
                  />
                </div>
              )}

              {error && (
                <p className="border-[3px] border-err bg-err/10 px-3 py-2 text-sm text-err">{error}</p>
              )}

              <button
                onClick={handleClone}
                disabled={!url.trim() || !destination.trim()}
                className="px-btn px-btn-pri w-full py-2"
              >
                CLONAR
              </button>
            </>
          ) : (
            <>
              {/* Progress view */}
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  {isCloning ? (
                    <>
                      <span className="h-1.5 w-1.5 bg-accent animate-pulse-dot" />
                      <span className="text-sm text-text-secondary">clonando...</span>
                    </>
                  ) : succeeded ? (
                    <>
                      <span className="text-ok">✓</span>
                      <span className="text-sm text-ok">clonado exitosamente</span>
                    </>
                  ) : (
                    <>
                      <span className="text-err">✗</span>
                      <span className="text-sm text-err">error al clonar</span>
                    </>
                  )}
                </div>

                {/* Stream log */}
                <CloneLog jobId={jobId} />

                {error && (
                  <p className="border-[3px] border-err bg-err/10 px-3 py-2 text-sm text-err whitespace-pre-wrap">{error}</p>
                )}

                <div className="flex gap-2">
                  {isCloning ? (
                    <button
                      onClick={handleCancel}
                      className="px-btn flex-1 py-2 border-err! text-err!"
                    >
                      CANCELAR
                    </button>
                  ) : (
                    <button
                      onClick={onClose}
                      className="px-btn flex-1 py-2"
                    >
                      {succeeded ? "LISTO" : "CERRAR"}
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
    <div className="bg-[#060608] border-[3px] border-edge h-40 overflow-y-auto">
      {log ? (
        <pre className="font-mono text-[10px] text-text-secondary whitespace-pre-wrap leading-relaxed p-3">
          {log}
        </pre>
      ) : (
        <div className="flex items-center gap-2 p-3">
          <span className="h-1.5 w-1.5 bg-accent animate-pulse-dot" />
          <span className="text-xs text-text-tertiary">iniciando...</span>
        </div>
      )}
    </div>
  );
}
