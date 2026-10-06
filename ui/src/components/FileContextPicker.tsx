import { useState, useEffect } from "react";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  relativePath: string;
}

interface SelectedFile {
  path: string;
  content: string;
  truncated: boolean;
}

interface FileContextPickerProps {
  projectId: string;
  onAttach: (files: SelectedFile[]) => void;
  onClose: () => void;
}

export function FileContextPicker({ projectId, onAttach, onClose }: FileContextPickerProps) {
  const [currentDir, setCurrentDir] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [attaching, setAttaching] = useState(false);

  useEffect(() => {
    loadDir(currentDir);
  }, [projectId, currentDir]);

  async function loadDir(dir: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/files?dir=${encodeURIComponent(dir)}`);
      const data = await res.json();
      setFiles(data.files || []);
    } catch { /* ignore */ }
    setLoading(false);
  }

  function toggleFile(path: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleAttach() {
    if (selected.size === 0) return;
    setAttaching(true);
    const result: SelectedFile[] = [];
    for (const filePath of selected) {
      try {
        const res = await fetch(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (data.content !== undefined) result.push({ path: filePath, content: data.content, truncated: data.truncated });
      } catch { /* ignore */ }
    }
    setAttaching(false);
    onAttach(result);
  }

  const breadcrumbs = currentDir ? currentDir.replace(/\\/g, "/").split("/") : [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 bg-surface-1 border border-edge rounded-2xl shadow-2xl w-full max-w-sm mx-4 mb-4 sm:mb-0 overflow-hidden animate-fade-in">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono text-[10px] text-text-tertiary shrink-0">📎</span>
            {/* Breadcrumb */}
            <button
              onClick={() => setCurrentDir("")}
              className="font-mono text-[10px] text-text-tertiary hover:text-accent transition-colors shrink-0"
            >
              raíz
            </button>
            {breadcrumbs.map((part, i) => (
              <span key={i} className="flex items-center gap-1">
                <span className="font-mono text-[10px] text-text-tertiary">/</span>
                <button
                  onClick={() => setCurrentDir(breadcrumbs.slice(0, i + 1).join("/"))}
                  className="font-mono text-[10px] text-text-secondary hover:text-accent transition-colors truncate max-w-[80px]"
                >
                  {part}
                </button>
              </span>
            ))}
          </div>
          <button onClick={onClose} className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary ml-2 shrink-0">✕</button>
        </div>

        {/* File list */}
        <div className="max-h-64 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-3">
              <span className="font-mono text-[10px] text-text-tertiary">cargando...</span>
            </div>
          ) : files.length === 0 ? (
            <div className="px-4 py-3">
              <span className="font-mono text-[10px] text-text-tertiary">directorio vacío</span>
            </div>
          ) : (
            files.map(f => (
              <div
                key={f.relativePath}
                className={`flex items-center gap-2.5 px-4 py-2 cursor-pointer transition-colors ${
                  f.type === "file" && selected.has(f.relativePath)
                    ? "bg-accent/10"
                    : "hover:bg-surface-2/50"
                }`}
                onClick={() => {
                  if (f.type === "dir") setCurrentDir(f.relativePath);
                  else toggleFile(f.relativePath);
                }}
              >
                {f.type === "dir" ? (
                  <span className="font-mono text-[11px] text-text-tertiary shrink-0">📁</span>
                ) : (
                  <div className={`h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                    selected.has(f.relativePath) ? "bg-accent border-accent" : "border-edge-strong"
                  }`}>
                    {selected.has(f.relativePath) && <span className="text-surface-0 text-[8px]">✓</span>}
                  </div>
                )}
                <span className={`font-mono text-xs truncate ${
                  f.type === "dir" ? "text-text-secondary" : "text-text-primary"
                }`}>
                  {f.name}
                </span>
                {f.type === "dir" && (
                  <span className="font-mono text-[10px] text-text-tertiary ml-auto shrink-0">›</span>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-edge">
          <span className="font-mono text-[10px] text-text-tertiary">
            {selected.size > 0 ? `${selected.size} archivo${selected.size > 1 ? "s" : ""} seleccionado${selected.size > 1 ? "s" : ""}` : "selecciona archivos"}
          </span>
          <button
            onClick={handleAttach}
            disabled={selected.size === 0 || attaching}
            className="font-mono text-[11px] text-accent hover:text-text-primary border border-accent/30 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {attaching ? "cargando..." : "adjuntar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function buildFileContext(files: { path: string; content: string; truncated: boolean }[]): string {
  if (files.length === 0) return "";
  const lines = ["The following files are provided as context:\n"];
  for (const f of files) {
    lines.push(`--- File: ${f.path} ---`);
    lines.push(f.content);
    if (f.truncated) lines.push("[...truncated]");
    lines.push("");
  }
  lines.push("---\n");
  return lines.join("\n");
}
