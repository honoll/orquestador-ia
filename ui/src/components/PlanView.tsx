import { useState, useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWs } from "../context/WebSocketProvider";
import { useAppState } from "../context/AppStateContext";
import { parseStreamingText } from "../lib/parse-stream";
import { stepLevels } from "../lib/plan-levels";
import { formatTokens } from "../lib/format";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ResizableGroup, ResizableHandle, ResizablePanel } from "./ResizableDivider";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";

// ─── Save Plan Modal ───────────────────────────────────────────────────────────

interface Project { id: string; name: string; path: string; }

function SavePlanModal({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>(plan.projectId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/projects").then(r => r.json()).then(setProjects).catch(() => {});
  }, []);

  async function handleSaveToProject() {
    if (!selectedProject) return;
    setSaving(true);
    await fetch(`/api/plans/${plan.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: selectedProject }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function downloadAs(format: "json" | "md") {
    let content = "";
    let filename = "";
    if (format === "json") {
      content = JSON.stringify({ ...plan }, null, 2);
      filename = `plan-${plan.id.slice(0, 8)}.json`;
    } else {
      const lines = [
        `# Plan: ${plan.description}`,
        ``,
        `**Estado:** ${plan.status}  `,
        `**Pasos:** ${plan.steps.length}`,
        ``,
      ];
      plan.steps.forEach((s, i) => {
        lines.push(`## Paso ${i + 1}: ${s.description}`);
        lines.push(`- **Adapter:** ${s.adapter}${s.model ? ` (${s.model})` : ""}`);
        if (s.reason) lines.push(`- **Razón:** ${s.reason}`);
        lines.push(``);
        lines.push(`**Prompt:**`);
        lines.push("```");
        lines.push(s.prompt);
        lines.push("```");
        if (s.result) {
          lines.push(`**Resultado:**`);
          lines.push("```");
          lines.push(s.result);
          lines.push("```");
        }
        lines.push("");
      });
      content = lines.join("\n");
      filename = `plan-${plan.id.slice(0, 8)}.md`;
    }
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Modal */}
      <div className="relative z-10 bg-surface-1 border border-edge rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden animate-fade-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
          <span className="font-mono text-xs text-text-primary">guardar plan</span>
          <button onClick={onClose} className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors">✕</button>
        </div>

        <div className="p-5 space-y-5">
          {/* Assign to project */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">asignar a proyecto</p>
            {projects.length === 0 ? (
              <p className="font-mono text-[10px] text-text-tertiary">no hay proyectos creados</p>
            ) : (
              <div className="flex gap-2">
                <select
                  value={selectedProject}
                  onChange={e => setSelectedProject(e.target.value)}
                  className="flex-1 bg-surface-0 border border-edge rounded-lg px-3 py-2 font-mono text-xs text-text-primary focus:outline-none focus:border-accent"
                >
                  <option value="">— seleccionar proyecto —</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleSaveToProject}
                  disabled={!selectedProject || saving}
                  className="font-mono text-[11px] text-accent hover:text-text-primary border border-accent/30 rounded-lg px-3 py-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {saving ? "..." : saved ? "✓" : "guardar"}
                </button>
              </div>
            )}
            {plan.projectId && (
              <p className="font-mono text-[10px] text-text-tertiary">
                actualmente en: <span className="text-accent">{projects.find(p => p.id === plan.projectId)?.name ?? plan.projectId}</span>
              </p>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-edge" />

          {/* Download */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">descargar</p>
            <div className="flex gap-2">
              <button
                onClick={() => downloadAs("md")}
                className="flex-1 font-mono text-[11px] text-text-secondary hover:text-text-primary border border-edge hover:border-edge-strong rounded-lg px-3 py-2 transition-colors text-left"
              >
                📄 markdown
              </button>
              <button
                onClick={() => downloadAs("json")}
                className="flex-1 font-mono text-[11px] text-text-secondary hover:text-text-primary border border-edge hover:border-edge-strong rounded-lg px-3 py-2 transition-colors text-left"
              >
                {"{ }"} JSON
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PlanStep {
  id: string;
  planId: string;
  stepIndex: number;
  description: string;
  adapter: "claude" | "codex" | "agy";
  model: string | null;
  reason: string | null;
  prompt: string;
  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
  result: string | null;
  errorMessage: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  stepKey: string | null;
  dependsOn: string | null;
  writes: number | null;
  estimatedTokens: number | null;
  readOnly: number;
  guardFlags: string | null;
  guardApproved: number;
}

export interface Plan {
  id: string;
  description: string;
  status: string;
  projectId: string | null;
  errorMessage?: string | null;
  chatHistory?: string | null;
  createdAt: string;
  steps: PlanStep[];
  estimatedTokens: number | null;
  budgetTokens: number | null;
  usedTokens: number;
  maxParallel: number;
  pauseReason: "quota" | "budget" | "guard" | null;
  tier: "trivial" | "normal" | "critical" | null;
  tierConfidence: number | null;
  tierSource: "jev" | "fallback" | null;
  synthesis: string | null;
  synthesisStatus: "running" | "succeeded" | "failed" | null;
  synthesisError: string | null;
}

// ─── adapter styling ───────────────────────────────────────────────────────────

const A_COLOR: Record<string, string> = {
  claude: "text-violet-400",
  codex:  "text-emerald-400",
  agy: "text-sky-400",
};

const A_BORDER: Record<string, string> = {
  claude: "border-violet-400/30",
  codex:  "border-emerald-400/30",
  agy: "border-sky-400/30",
};

const A_BG: Record<string, string> = {
  claude: "bg-violet-400/10",
  codex:  "bg-emerald-400/10",
  agy: "bg-sky-400/10",
};

const A_RING: Record<string, string> = {
  claude: "ring-violet-400/50",
  codex:  "ring-emerald-400/50",
  agy: "ring-sky-400/50",
};

const A_ICON: Record<string, string> = {
  claude: "◆",
  codex:  "◇",
  agy: "◎",
};

const STATUS_DOT: Record<string, string> = {
  pending:   "bg-text-tertiary/40",
  running:   "bg-accent animate-pulse-dot",
  succeeded: "bg-ok",
  failed:    "bg-err",
  cancelled: "bg-text-tertiary/40",
  skipped:   "bg-text-tertiary/40",
};

// ─── Generating overlay ────────────────────────────────────────────────────────

function GeneratingView({
  plan,
  genLog,
  onCancel,
}: {
  plan: Plan;
  genLog: string;
  onCancel: () => void;
}) {
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [genLog]);

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 h-12 border-b border-edge shrink-0">
        <span className="font-mono text-xs text-text-secondary">/plan</span>
        {plan.tier && (
          <span className="font-mono text-[10px] text-text-secondary">
            tier: {TIER_TEXT[plan.tier]} ({tierShort(plan)})
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" />
            <span className="font-mono text-[10px] text-text-tertiary">generando plan...</span>
          </div>
          <button
            onClick={onCancel}
            className="font-mono text-[11px] text-err hover:text-text-primary border border-err/30 rounded px-2.5 py-1 transition-colors"
          >
            detener
          </button>
        </div>
      </div>

      {/* Description */}
      <div className="px-6 pt-6 pb-2 max-w-3xl mx-auto w-full">
        <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary mb-1">analizando tarea</p>
        <p className="text-sm text-text-primary leading-relaxed">{plan.description}</p>
      </div>

      {/* Animated adapter icons */}
      <div className="flex items-center justify-center gap-8 py-8">
        {["claude", "codex", "agy"].map((a, i) => (
          <div
            key={a}
            className="flex flex-col items-center gap-2 animate-fade-in"
            style={{ animationDelay: `${i * 150}ms` }}
          >
            <div className={`h-10 w-10 rounded-xl border flex items-center justify-center ${A_BG[a]} ${A_BORDER[a]} ${i === 0 ? "ring-2 ring-offset-2 ring-offset-surface-0 " + A_RING[a] : ""}`}>
              <span className={`text-lg ${A_COLOR[a]}`}>{A_ICON[a]}</span>
            </div>
            <span className={`font-mono text-[9px] uppercase tracking-widest ${A_COLOR[a]}`}>{a}</span>
          </div>
        ))}
      </div>

      {/* Streaming Claude thinking */}
      <div className="flex-1 overflow-hidden px-6 pb-6 max-w-3xl mx-auto w-full">
        <p className="font-mono text-[9px] uppercase tracking-widest text-text-tertiary mb-2">pensamiento</p>
        <div className="bg-surface-1 rounded-xl border border-edge h-full overflow-hidden">
          {genLog ? (
            <pre
              ref={logRef}
              className="font-mono text-[10px] whitespace-pre-wrap leading-relaxed p-4 h-full overflow-y-auto"
            >
              {genLog.split('\n').map((line, i, arr) => (
                <span
                  key={i}
                  className={/\[esperando/.test(line) ? 'text-amber-400 font-semibold' : 'text-text-secondary'}
                >
                  {line}{i < arr.length - 1 ? '\n' : ''}
                </span>
              ))}
              <span className="streaming-cursor" />
            </pre>
          ) : (
            <div className="flex items-center gap-2 p-4">
              <div className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" />
              <span className="font-mono text-[10px] text-text-tertiary">esperando respuesta de claude...</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Flow diagram ──────────────────────────────────────────────────────────────

function FlowDiagram({ steps }: { steps: PlanStep[] }) {
  const levels = stepLevels(steps);
  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-2 scrollbar-hide">
      {levels.map((level, li) => {
        const levelDone = level.every((st) => st.status === "succeeded");
        return (
          <div key={li} className="flex items-center shrink-0">
            <div className="flex flex-col gap-1">
              {level.map((step) => {
                const isRunning = step.status === "running";
                const isDone = step.status === "succeeded";
                const isFailed = step.status === "failed";
                const isCancelled = step.status === "cancelled";
                const isSkipped = step.status === "skipped";
                const mutedLabel = isCancelled ? "cancelado" : isSkipped ? "omitido" : null;
                return (
                  <div
                    key={step.id}
                    title={mutedLabel ?? undefined}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all ${mutedLabel ? "opacity-50 border-dashed " : ""}${
                      isRunning
                        ? `${A_BG[step.adapter]} ${A_BORDER[step.adapter]} ring-2 ring-offset-1 ring-offset-surface-0 ${A_RING[step.adapter]}`
                        : isDone
                          ? "bg-ok/10 border-ok/20"
                          : isFailed
                            ? "bg-err/10 border-err/20"
                            : "bg-surface-1 border-edge"
                    }`}
                  >
                    <span
                      className={`text-[11px] ${
                        isRunning ? A_COLOR[step.adapter] : isDone ? "text-ok" : isFailed ? "text-err" : "text-text-tertiary"
                      }`}
                    >
                      <span aria-hidden="true">{isDone ? "✓" : isFailed ? "✗" : isCancelled ? "⊘" : isSkipped ? "↷" : A_ICON[step.adapter]}</span>
                      {mutedLabel && <span className="sr-only">{mutedLabel}</span>}
                    </span>
                    <div className="flex flex-col">
                      <span className="font-mono text-[10px] text-text-tertiary leading-none">{step.stepKey ?? step.stepIndex + 1}</span>
                      <span
                        className={`font-mono text-[10px] leading-none mt-0.5 max-w-[80px] truncate ${
                          isRunning ? A_COLOR[step.adapter] : isDone ? "text-ok" : "text-text-secondary"
                        }`}
                      >
                        {step.adapter}
                      </span>
                      <span className="font-mono text-[10px] leading-none mt-0.5 text-text-tertiary">
                        {step.writes === 0 ? "lee" : "escribe"}
                      </span>
                    </div>
                    {isRunning && (
                      <span className="h-1 w-1 rounded-full bg-accent animate-pulse-dot shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>

            {li < levels.length - 1 && (
              <div className="flex items-center px-1">
                <div className={`h-px w-4 ${levelDone ? "bg-ok/40" : "bg-edge"}`} />
                <span className={`text-[10px] -ml-0.5 ${levelDone ? "text-ok/40" : "text-text-tertiary/30"}`}>›</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step card ─────────────────────────────────────────────────────────────────

function StepCard({
  step,
  streamLog,
  stepFiles = [],
  onEdit,
  onRetry,
  onFileClick,
}: {
  step: PlanStep;
  streamLog: string;
  stepFiles?: ChangedFile[];
  onEdit: (step: PlanStep, newPrompt: string) => void;
  onRetry?: (step: PlanStep) => void;
  onFileClick?: (file: ChangedFile) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState(step.prompt);
  const streamRef = useRef<HTMLPreElement>(null);
  const stepDeps = (() => {
    try {
      const v = JSON.parse(step.dependsOn ?? "[]");
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  })();

  useEffect(() => {
    if (step.status === "running" && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamLog, step.status]);

  return (
    <div
      className={`rounded-xl border p-4 transition-all ${
        step.status === "running"
          ? `${A_BG[step.adapter]} ${A_BORDER[step.adapter]}`
          : step.status === "succeeded"
            ? "border-ok/15 bg-surface-1"
            : step.status === "failed"
              ? "border-err/20 bg-surface-1"
              : "border-edge bg-surface-1"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Status + index */}
        <div className="flex flex-col items-center gap-1 pt-0.5 shrink-0">
          <div className={`h-2 w-2 rounded-full ${STATUS_DOT[step.status]}`} />
          <span className="font-mono text-[10px] text-text-tertiary">{step.stepIndex + 1}</span>
        </div>

        <div className="flex-1 min-w-0">
          {/* Header row */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-text-primary leading-snug">
              {step.description}
            </span>
            <span
              className={`font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${A_BG[step.adapter]} ${A_BORDER[step.adapter]}`}
            >
              <span className={A_COLOR[step.adapter]}>{A_ICON[step.adapter]} {step.adapter}</span>
              {step.model && (
                <span className="text-text-tertiary ml-1">{step.model.split("-").slice(-1)[0]}</span>
              )}
            </span>
            <span
              className={`font-mono text-[9px] border rounded px-1 shrink-0 ${
                step.writes === 0 ? "text-ok border-ok/30" : "text-accent border-accent/30"
              }`}
            >
              {step.writes === 0 ? "lee" : "escribe"}
            </span>
            {step.readOnly === 1 && (
              <span className="font-mono text-[10px] border border-edge rounded px-1 text-text-secondary shrink-0">solo lectura</span>
            )}
            {step.guardApproved === 1 && (
              <span className="font-mono text-[10px] border border-ok/40 rounded px-1 text-ok shrink-0">aprobado</span>
            )}
            {((step.inputTokens ?? 0) + (step.outputTokens ?? 0) > 0) && (
              <span className="font-mono text-[10px] text-text-tertiary shrink-0">
                {formatTokens((step.inputTokens ?? 0) + (step.outputTokens ?? 0))}
              </span>
            )}
            {step.estimatedTokens ? (
              <span className="font-mono text-[10px] text-text-tertiary shrink-0">~{formatTokens(step.estimatedTokens)} est.</span>
            ) : null}
          </div>
          {stepDeps.length > 0 && (
            <p className="font-mono text-[10px] text-text-tertiary mt-1">depende de: {stepDeps.join(", ")}</p>
          )}

          {step.reason && (
            <p className="font-mono text-[10px] text-text-tertiary mt-1 leading-relaxed">
              {step.reason}
            </p>
          )}

          {/* Running: streaming */}
          {step.status === "running" && (
            <div className="mt-3">
              {streamLog ? (
                <pre
                  ref={streamRef}
                  className="font-mono text-xs text-text-secondary whitespace-pre-wrap leading-relaxed max-h-52 overflow-y-auto bg-surface-0/60 rounded-lg p-3"
                >
                  {streamLog}
                  <span className="streaming-cursor" />
                </pre>
              ) : (
                <div className="flex items-center gap-2">
                  <div className={`h-1 w-1 rounded-full ${A_COLOR[step.adapter].replace("text-", "bg-")} animate-pulse-dot`} />
                  <span className={`font-mono text-xs ${A_COLOR[step.adapter]}`}>ejecutando en {step.adapter}...</span>
                </div>
              )}
            </div>
          )}

          {/* Succeeded */}
          {step.status === "succeeded" && step.result && (
            <div className="mt-3">
              <button
                onClick={() => setExpanded(!expanded)}
                className="font-mono text-[10px] text-text-secondary hover:text-accent transition-colors"
              >
                {expanded ? "▲ ocultar resultado" : "▼ ver resultado"}
              </button>
              {expanded && (
                <pre className="mt-2 font-mono text-xs text-text-secondary whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto bg-surface-0 rounded-lg p-3 border border-edge">
                  {step.result}
                </pre>
              )}
              <div className="flex items-center gap-3 mt-2 font-mono text-[10px] text-text-tertiary">
                {(step.costUsd ?? 0) > 0 && <span>${step.costUsd!.toFixed(4)}</span>}
                {(step.inputTokens ?? 0) > 0 && <span>{step.inputTokens!.toLocaleString()} in</span>}
                {(step.outputTokens ?? 0) > 0 && <span>{step.outputTokens!.toLocaleString()} out</span>}
                {stepFiles.length > 0 && (
                  <button
                    onClick={() => setShowFiles((v) => !v)}
                    className="text-text-tertiary hover:text-ok transition-colors flex items-center gap-1"
                  >
                    <span>📄</span>
                    <span>{stepFiles.length} archivo{stepFiles.length !== 1 ? "s" : ""}</span>
                    <span className="text-[8px]">{showFiles ? "▲" : "▼"}</span>
                  </button>
                )}
              </div>
              {showFiles && stepFiles.length > 0 && (
                <div className="mt-2 rounded-lg border border-edge bg-surface-0 overflow-hidden">
                  {stepFiles.map((f) => {
                    const name = f.filePath.split("/").pop() ?? f.filePath;
                    const ext = name.split(".").pop()?.toLowerCase() ?? "";
                    const isCode = ["ts","tsx","js","jsx","dart","py","go","rs","json","yaml","yml","css","html","md","sh"].includes(ext);
                    return (
                      <button
                        key={f.filePath}
                        onClick={() => onFileClick?.(f)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-1 transition-colors text-left border-b border-edge last:border-b-0"
                        title={f.filePath}
                      >
                        <span className="text-[10px]">{isCode ? "📝" : "📄"}</span>
                        <span className="font-mono text-[10px] text-text-secondary truncate flex-1">{name}</span>
                        <span className="font-mono text-[9px] text-text-tertiary shrink-0 truncate max-w-[120px]">{f.filePath.split("/").slice(0, -1).join("/")}</span>
                        <span className="font-mono text-[9px] text-text-tertiary shrink-0">→</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Failed */}
          {step.status === "failed" && (
            <div className="mt-2 space-y-2">
              {step.errorMessage && (
                <p className="font-mono text-xs text-err leading-relaxed">{step.errorMessage}</p>
              )}
              {onRetry && (
                <button
                  onClick={() => onRetry(step)}
                  className="font-mono text-[10px] text-ok hover:text-text-primary border border-ok/30 bg-ok/5 rounded px-2.5 py-1 transition-colors flex items-center gap-1.5"
                >
                  ↺ reintentar este paso
                </button>
              )}
            </div>
          )}

          {/* Edit prompt */}
          {editing ? (
            <div className="mt-3 space-y-2">
              <textarea
                className="w-full bg-surface-0 border border-edge-strong rounded-lg px-3 py-2 font-mono text-xs text-text-primary focus:outline-none focus:border-accent resize-none"
                rows={6}
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { onEdit(step, editPrompt); setEditing(false); }}
                  className="font-mono text-[10px] text-accent hover:text-text-primary border border-edge-strong rounded px-2 py-1 transition-colors"
                >
                  guardar
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
                >
                  cancelar
                </button>
              </div>
            </div>
          ) : (
            step.status === "pending" && (
              <button
                onClick={() => setEditing(true)}
                className="mt-2 font-mono text-[10px] text-text-tertiary hover:text-accent transition-colors"
              >
                editar prompt
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ─── File Preview Panel ────────────────────────────────────────────────────────

interface ChangedFile {
  filePath: string;
  content: string;
  timestamp: string;
}

const detectLanguage = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    dart: "dart", py: "python",
    json: "json", css: "css",
    html: "html", sh: "bash",
    sql: "sql", md: "markdown",
    go: "go", rs: "rust",
  };
  return map[ext] ?? "text";
};

function FilePreviewPanel({
  files,
  onClose,
}: {
  files: ChangedFile[];
  onClose: () => void;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Auto-select the most recent file
  useEffect(() => {
    if (files.length > 0) {
      setSelectedPath(files[files.length - 1].filePath);
    }
  }, [files.length]);

  const selected = files.find((f) => f.filePath === selectedPath);

  if (files.length === 0) return null;

  return (
    <div className="flex flex-col h-full border-l border-edge bg-surface-0 animate-fade-in" style={{ minWidth: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-10 border-b border-edge shrink-0">
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
          archivos modificados
        </span>
        <div className="flex items-center gap-3">
          <span className="font-mono text-[9px] text-text-tertiary">
            {files.length} {files.length === 1 ? "archivo" : "archivos"}
          </span>
          <button
            onClick={onClose}
            className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            ✕
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="flex border-b border-edge overflow-x-auto shrink-0 scrollbar-hide">
        {files.map((f) => {
          const name = f.filePath.split("/").pop() ?? f.filePath;
          const isSelected = f.filePath === selectedPath;
          return (
            <button
              key={f.filePath}
              onClick={() => setSelectedPath(f.filePath)}
              className={`shrink-0 px-3 py-2 font-mono text-[10px] border-r border-edge transition-colors whitespace-nowrap ${
                isSelected
                  ? "bg-surface-1 text-accent border-b-2 border-b-accent"
                  : "text-text-tertiary hover:text-text-secondary hover:bg-surface-1/50"
              }`}
              title={f.filePath}
            >
              <span className="flex items-center gap-1.5">
                <span className="h-1 w-1 rounded-full bg-ok shrink-0" />
                {name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Path breadcrumb */}
      {selected && (
        <div className="px-3 py-1.5 border-b border-edge shrink-0">
          <p
            className="font-mono text-[9px] text-text-tertiary truncate"
            title={selected.filePath}
          >
            {selected.filePath}
          </p>
        </div>
      )}

      {/* File content */}
      <div className="flex-1 overflow-auto">
        {selected ? (
          selected.content === "[archivo demasiado grande para previsualizar]" ? (
            <p className="font-mono text-[10px] text-text-tertiary p-4">{selected.content}</p>
          ) : (
            <SyntaxHighlighter
              language={detectLanguage(selected.filePath)}
              style={vscDarkPlus}
              showLineNumbers
              wrapLines
              customStyle={{
                margin: 0,
                padding: "0.5rem",
                background: "transparent",
                fontSize: "10px",
                fontFamily: "ui-monospace, monospace",
                flex: 1,
                overflow: "auto",
              }}
              lineNumberStyle={{ minWidth: "2.5em", color: "#4a5568", userSelect: "none" }}
            >
              {selected.content ?? ""}
            </SyntaxHighlighter>
          )
        ) : null}
      </div>
    </div>
  );
}

// ─── Plan Summary (shown when plan is completed) ───────────────────────────────

function PlanSummary({ plan }: { plan: Plan }) {
  if (plan.status !== "completed") return null;

  const succeededSteps = plan.steps.filter((s) => s.status === "succeeded");
  const totalCost = plan.steps.reduce((acc, s) => acc + (s.costUsd ?? 0), 0);

  // Count user messages from chatHistory (amendment count)
  let amendmentCount = 0;
  if (plan.chatHistory) {
    try {
      const msgs: Array<{ role: string; content: string }> = JSON.parse(plan.chatHistory);
      amendmentCount = msgs.filter((m) => m.role === "user").length;
    } catch { /* ignore */ }
  }

  return (
    <div className="mb-5 rounded-lg border border-ok/20 bg-ok/5 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-ok font-mono text-xs">✓ Plan completado</span>
        {totalCost > 0 && (
          <span className="font-mono text-[10px] text-text-tertiary ml-auto">
            ${totalCost.toFixed(4)} total
          </span>
        )}
      </div>

      {/* Succeeded steps */}
      {succeededSteps.length > 0 && (
        <div className="space-y-2">
          {succeededSteps.map((step) => {
            const extract = step.result
              ? step.result.length > 300
                ? step.result.slice(0, 300) + "..."
                : step.result
              : null;
            return (
              <div
                key={step.id}
                className="rounded border border-edge bg-surface-1 px-3 py-2 space-y-1"
              >
                <p className="font-mono text-[11px] text-text-primary">{step.description}</p>
                {extract && (
                  <p className="font-mono text-[10px] text-text-tertiary whitespace-pre-wrap line-clamp-3">
                    {extract}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Amendments note */}
      {amendmentCount > 0 && (
        <div className="border-t border-edge/50 pt-2 flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-tertiary">
            Cambios solicitados: {amendmentCount} solicitud{amendmentCount !== 1 ? "es" : ""} —{" "}
            <span className="italic">Ver historial en el panel inferior</span>
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Plan Chat (modification requests) ────────────────────────────────────────

interface PlanMessage {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

function buildPlanContext(plan: Plan): string {
  const stepsSummary = plan.steps
    .map((s, i) => {
      const status = s.status === "succeeded" ? "✓" : s.status === "failed" ? "✗" : "○";
      const result = s.result ? `\n    Resultado: ${s.result.slice(0, 300)}` : "";
      const err = s.errorMessage ? `\n    Error: ${s.errorMessage}` : "";
      return `  ${status} Paso ${i + 1} [${s.adapter}]: ${s.description}${result}${err}`;
    })
    .join("\n");
  return `[CONTEXTO DEL PLAN]\nDescripción: ${plan.description}\nEstado: ${plan.status}\nPasos:\n${stepsSummary}\n[FIN CONTEXTO]`;
}

function PlanChat({ plan }: { plan: Plan }) {
  const { logs, lastEvent } = useWs();
  const { selectedAdapter, selectedModel, selectedProjectId } = useAppState();
  const [messages, setMessages] = useState<PlanMessage[]>([]);
  const [input, setInput] = useState("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [hybridMode, setHybridMode] = useState(false);
  const [hybridPhase, setHybridPhase] = useState<"claude" | "codex" | null>(null);
  const hybridPendingPrompt = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<PlanMessage[]>([]);

  // Keep historyRef in sync with messages state
  useEffect(() => { historyRef.current = messages; }, [messages]);

  // Load chat history from DB on mount
  useEffect(() => {
    fetch(`/api/plans/${plan.id}/chat-history`)
      .then((r) => r.json())
      .then((data) => {
        if (data.messages && data.messages.length > 0) {
          setMessages(data.messages.map((m: PlanMessage) => ({ ...m, streaming: false })));
        }
      })
      .catch(() => {});
  }, [plan.id]);

  // Save chat history to DB
  const saveHistory = useCallback(async (msgs: PlanMessage[]) => {
    try {
      await fetch(`/api/plans/${plan.id}/chat-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs.map((m) => ({ role: m.role, content: m.content })) }),
      });
    } catch { /* ignore */ }
  }, [plan.id]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Stream live logs into the last assistant message
  const rawStream = activeRunId ? (logs.get(activeRunId) ?? "") : "";
  const activeParseAdapter = hybridMode && hybridPhase === "codex" ? "codex"
    : hybridMode && hybridPhase === "claude" ? "claude"
    : selectedAdapter;
  const streamedText = rawStream ? parseStreamingText(rawStream, activeParseAdapter) : "";

  useEffect(() => {
    if (!activeRunId || !streamedText) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last?.streaming) {
        return [...prev.slice(0, -1), { ...last, content: streamedText }];
      }
      return [...prev, { role: "assistant", content: streamedText, streaming: true }];
    });
  }, [streamedText, activeRunId]);

  const finishRun = useCallback((finalContent: string) => {
    setMessages((prev) => {
      const updated = prev.map((m, i) =>
        i === prev.length - 1 && m.streaming ? { ...m, content: finalContent, streaming: false } : m,
      );
      historyRef.current = updated;
      return updated;
    });
    setActiveRunId(null);
    setIsRunning(false);
    setHybridPhase(null);
    // Save after state update using the ref which was already updated above
    setTimeout(() => saveHistory(historyRef.current), 0);
  }, [saveHistory]);

  const startCodexStage = useCallback(async (claudeInstructions: string) => {
    const codexPrompt = `${hybridPendingPrompt.current}\n\n[INSTRUCCIONES DE CLAUDE PARA IMPLEMENTAR]\n${claudeInstructions}`;
    setHybridPhase("codex");
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "◇ Codex implementando cambios...", streaming: true },
    ]);
    try {
      const taskRes = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "[híbrido] codex implementa",
          prompt: codexPrompt,
          adapter: "codex",
          projectId: selectedProjectId || plan.projectId || undefined,
        }),
      });
      const task = await taskRes.json();
      const runRes = await fetch(`/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { runId } = await runRes.json();
      setActiveRunId(runId);
    } catch {
      finishRun("Error al iniciar Codex.");
    }
  }, [selectedProjectId, plan.projectId, finishRun]);

  // Detect run completion
  useEffect(() => {
    if (!lastEvent || !activeRunId) return;
    const e = lastEvent as any;
    if (e.type === "run:done" && e.runId === activeRunId) {
      const content = parseStreamingText(logs.get(activeRunId) ?? "", activeParseAdapter) || "(sin respuesta)";
      if (hybridMode && hybridPhase === "claude") {
        setMessages((prev) =>
          prev.map((m, i) =>
            i === prev.length - 1 && m.streaming ? { ...m, content, streaming: false } : m,
          ),
        );
        setActiveRunId(null);
        startCodexStage(content);
      } else {
        finishRun(content);
      }
    }
  }, [lastEvent, activeRunId, hybridMode, hybridPhase, activeParseAdapter, logs, startCodexStage, finishRun]);

  // Poll run status to detect completion (fallback if WS misses the event)
  useEffect(() => {
    if (!activeRunId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/runs/${activeRunId}`);
        const run = await res.json();
        if (run.status !== "running") {
          clearInterval(interval);
          const finalContent = parseStreamingText(logs.get(activeRunId) ?? "", activeParseAdapter)
            || run.summary || run.result || "(sin respuesta)";
          if (hybridMode && hybridPhase === "claude") {
            setMessages((prev) =>
              prev.map((m, i) =>
                i === prev.length - 1 && m.streaming ? { ...m, content: finalContent, streaming: false } : m,
              ),
            );
            setActiveRunId(null);
            startCodexStage(finalContent);
          } else {
            finishRun(finalContent);
          }
        }
      } catch { /* ignore */ }
    }, 1500);
    return () => clearInterval(interval);
  }, [activeRunId, logs, activeParseAdapter, hybridMode, hybridPhase, startCodexStage, finishRun]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning) return;

    const planContext = buildPlanContext(plan);
    const fullPrompt = hybridMode
      ? `${planContext}\n\nSolicitud de modificación: ${text}\n\nTu tarea: analiza la solicitud y el contexto del plan. Produce instrucciones detalladas y precisas de qué código debe crear o modificar Codex para implementar este cambio. Sé específico: incluye nombres de archivos, funciones a modificar, lógica a agregar. No escribas el código tú mismo — solo las instrucciones para Codex.`
      : `${planContext}\n\nSolicitud de modificación: ${text}`;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setIsRunning(true);

    if (hybridMode) {
      hybridPendingPrompt.current = `${planContext}\n\nSolicitud original: ${text}`;
      setHybridPhase("claude");
      setMessages((prev) => [...prev, { role: "assistant", content: "◆ Claude analizando...", streaming: true }]);
    }

    try {
      const taskRes = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: text.slice(0, 80),
          prompt: fullPrompt,
          adapter: hybridMode ? "claude" : selectedAdapter,
          model: hybridMode ? (selectedModel || undefined) : (selectedModel || undefined),
          projectId: selectedProjectId || plan.projectId || undefined,
        }),
      });
      const task = await taskRes.json();
      const runRes = await fetch(`/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { runId } = await runRes.json();
      setActiveRunId(runId);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Error al enviar la solicitud." },
      ]);
      setIsRunning(false);
      setHybridPhase(null);
    }
  }, [input, isRunning, plan, selectedAdapter, selectedModel, selectedProjectId, hybridMode]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="bg-surface-0 flex flex-col h-full">
      {/* Toggle header */}
      <div className="flex items-center px-6 py-2 border-b border-edge/50 gap-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
          solicitar cambios
        </span>
        {/* Hybrid mode toggle */}
        <button
          onClick={() => setHybridMode((v) => !v)}
          disabled={isRunning}
          title={hybridMode ? "Modo híbrido activo: Claude razona → Codex implementa" : "Activar modo híbrido"}
          className={`ml-1 flex items-center gap-1 px-2 py-0.5 rounded border font-mono text-[9px] transition-all ${
            hybridMode
              ? "bg-violet-400/10 border-violet-400/40 text-violet-400"
              : "border-edge text-text-tertiary hover:text-text-secondary hover:border-edge-strong"
          }`}
        >
          ◆→◇ híbrido
        </button>
        {isRunning && (
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" />
            <span className="font-mono text-[9px] text-text-tertiary">
              {hybridPhase === "claude" ? "◆ claude razonando..." : hybridPhase === "codex" ? "◇ codex implementando..." : "respondiendo..."}
            </span>
          </span>
        )}
      </div>

      {/* Messages */}
      {messages.length > 0 && (
        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-3 min-h-0">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              {msg.role === "assistant" && (
                <span className="font-mono text-[10px] text-text-tertiary shrink-0 mt-1">
                  {msg.content?.startsWith("◇") ? "◇" : msg.content?.startsWith("◆") ? "◆" :
                    selectedAdapter === "claude" ? "◆" : selectedAdapter === "codex" ? "◇" : "◎"}
                </span>
              )}
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-accent/10 border border-accent/20 text-text-primary"
                    : "bg-surface-1 border border-edge text-text-secondary"
                }`}
              >
                {msg.content}
                {msg.streaming && <span className="streaming-cursor" />}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input bar */}
      <div className="flex items-end gap-3 px-6 py-3">
        <textarea
          ref={textareaRef}
          className="flex-1 bg-surface-1 border border-edge rounded-xl px-4 py-2.5 font-mono text-xs text-text-primary placeholder-text-tertiary focus:outline-none focus:border-accent resize-none transition-colors"
          placeholder="pide modificaciones al plan... (Enter para enviar)"
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            // Auto-resize
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
          }}
          onKeyDown={handleKeyDown}
          disabled={isRunning}
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || isRunning}
          className="shrink-0 font-mono text-[11px] text-accent hover:text-text-primary border border-accent/30 rounded-xl px-4 py-2.5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {isRunning ? "..." : "enviar"}
        </button>
      </div>
    </div>
  );
}

// ─── Presupuesto, pausa y síntesis ─────────────────────────────────────────────

function BudgetBar({ plan, disabled, onSave }: { plan: Plan; disabled: boolean; onSave: (p: { budgetTokens?: number | null; maxParallel?: number }) => void }) {
  const [draft, setDraft] = useState(plan.budgetTokens?.toString() ?? "");
  useEffect(() => setDraft(plan.budgetTokens?.toString() ?? ""), [plan.budgetTokens]);
  const pct = plan.budgetTokens ? Math.min(100, Math.round((plan.usedTokens * 100) / plan.budgetTokens)) : null;
  return (
    <div className="mx-4 my-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-text-tertiary">
      <span>tokens: {formatTokens(plan.usedTokens)}{plan.budgetTokens ? ` / ${formatTokens(plan.budgetTokens)}` : " (sin tope)"}</span>
      {pct !== null && (
        <span className="relative h-1 w-32 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <span className={`absolute inset-y-0 left-0 ${pct >= 100 ? "bg-err" : "bg-ok"}`} style={{ width: `${pct}%` }} />
        </span>
      )}
      {plan.estimatedTokens ? <span>estimado por Opus: ~{formatTokens(plan.estimatedTokens)}</span> : null}
      <label className="flex items-center gap-1">
        tope
        <input
          aria-label="Tope de tokens del plan"
          inputMode="numeric"
          disabled={disabled}
          className="w-24 rounded border border-edge bg-surface-0 px-1 py-0.5 text-text-primary disabled:opacity-50"
          value={draft}
          placeholder="sin tope"
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={() => {
            const next = draft ? Number(draft) : null;
            if (next !== plan.budgetTokens) onSave({ budgetTokens: next });
          }}
        />
      </label>
      <label className="flex items-center gap-1">
        en paralelo
        <select
          aria-label="Pasos en paralelo"
          disabled={disabled}
          className="rounded border border-edge bg-surface-0 px-1 py-0.5 text-text-primary disabled:opacity-50"
          value={plan.maxParallel}
          onChange={(e) => onSave({ maxParallel: Number(e.target.value) })}
        >
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
  );
}

const TIER_TEXT = { trivial: "trivial", normal: "normal", critical: "crítico" } as const;

function tierShort(plan: Plan): string {
  return plan.tierSource === "jev" ? `JEV ${Math.round((plan.tierConfidence ?? 0) * 100)} %` : "sin JEV";
}

function tierDetail(plan: Plan): string {
  return plan.tierSource === "jev"
    ? `JEV · confianza ${Math.round((plan.tierConfidence ?? 0) * 100)} %`
    : "sin JEV: se trató como normal";
}

function TierBadge({ plan }: { plan: Plan }) {
  if (!plan.tier) return null;
  const tone = plan.tier === "critical" ? "text-err border-err/40" : plan.tier === "trivial" ? "text-ok border-ok/40" : "text-text-secondary border-edge";
  const detail = tierDetail(plan);
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tone}`} title={detail}>
      {TIER_TEXT[plan.tier]}<span className="sr-only"> ({detail})</span>
    </span>
  );
}

function CriticalBanner({ plan, busy, onApprove }: { plan: Plan; busy: boolean; onApprove: () => void }) {
  const untouched = plan.steps.every((s) => s.status === "pending");
  if (plan.tier !== "critical" || plan.status !== "pending" || plan.pauseReason || !untouched || busy) return null;
  return (
    <div role="status" className="mx-4 my-2 flex flex-wrap items-center gap-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-text-primary">
      <span>Plan crítico: revisa los pasos (incluye una revisión de Opus al final) y apruébalo para ejecutarlo.</span>
      <button onClick={onApprove} className="ml-auto rounded border border-err/50 px-2 py-0.5 text-err hover:text-text-primary">aprobar y ejecutar</button>
    </div>
  );
}

function GuardBanner({ plan, onApprove, onCancel, onContinue }: { plan: Plan; onApprove: (stepId: string) => void; onCancel: () => void; onContinue: () => void }) {
  if (plan.status !== "pending" || plan.pauseReason !== "guard") return null;
  const step = plan.steps.find((s) => s.guardFlags && s.guardApproved !== 1 && s.status === "pending");
  if (!step) {
    // Pausa de guardia sin paso marcado (p. ej. se editó su prompt): no dejar el plan sin salida.
    return (
      <div role="status" className="mx-4 my-2 flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent-dim px-3 py-2 font-mono text-[11px] text-text-primary">
        <span>Plan pausado por la guardia, pero ya no hay pasos marcados. Continúa para volver a evaluarlos.</span>
        <button onClick={onContinue} className="ml-auto rounded border border-ok/40 px-2 py-0.5 text-ok hover:text-text-primary">continuar</button>
      </div>
    );
  }
  let flags: { label: string; probability: number; source: string }[] = [];
  try { flags = JSON.parse(step.guardFlags!); } catch { /* sin detalle */ }
  return (
    <div role="alert" className="mx-4 my-2 space-y-2 rounded-lg border border-err/40 bg-err/10 px-3 py-2 font-mono text-[11px] text-text-primary">
      <p>La guardia detuvo el paso <strong>{step.stepKey ?? step.stepIndex + 1} — {step.description}</strong> antes de lanzarlo:</p>
      <ul className="list-disc pl-5">
        {flags.map((f, i) => <li key={i}>{f.label} · {f.source === "jev" ? `JEV ${Math.round(f.probability * 100)} %` : "regla local"}</li>)}
      </ul>
      <div className="flex gap-2">
        <button onClick={() => onApprove(step.id)} className="rounded border border-ok/40 px-2 py-0.5 text-ok hover:text-text-primary">aprobar este paso</button>
        <button onClick={onCancel} className="rounded border border-edge px-2 py-0.5 text-text-secondary hover:text-text-primary">cancelar</button>
      </div>
    </div>
  );
}

function PauseBanner({ plan, onContinue }: { plan: Plan; onContinue: () => void }) {
  if (plan.status !== "pending" || !plan.pauseReason || plan.pauseReason === "guard") return null;
  const text = plan.pauseReason === "budget"
    ? `Plan pausado por presupuesto: llevas ${formatTokens(plan.usedTokens)} de ${formatTokens(plan.budgetTokens ?? 0)} tokens.`
    : "Plan pausado por cuota de Antigravity. Cambia de cuenta en el panel de cuentas y continúa.";
  return (
    <div role="status" className="mx-4 my-2 flex flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent-dim px-3 py-2 font-mono text-[11px] text-text-primary">
      <span>{text}</span>
      <button onClick={onContinue} className="ml-auto rounded border border-ok/40 px-2 py-0.5 text-ok hover:text-text-primary">
        {plan.pauseReason === "budget" ? "continuar (+50 %)" : "continuar"}
      </button>
    </div>
  );
}

function SynthesisCard({ plan, onRetry }: { plan: Plan; onRetry: () => void }) {
  if (!plan.synthesisStatus) return null;
  return (
    <section aria-label="Respuesta final" className="mb-5 rounded-lg border border-accent/30 bg-surface-1 p-4">
      <h3 className="mb-2 font-mono text-xs text-accent">respuesta final · Opus 5.5</h3>
      {plan.synthesisStatus === "running" && <p className="font-mono text-[11px] text-text-tertiary">Opus está juntando las respuestas…</p>}
      {plan.synthesisStatus === "succeeded" && plan.synthesis && (
        <div className="prose prose-invert prose-sm max-w-none text-text-primary/90 leading-relaxed [&_p]:my-2 [&_pre]:bg-surface-2 [&_pre]:border [&_pre]:border-edge [&_pre]:rounded-lg"><ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.synthesis}</ReactMarkdown></div>
      )}
      {plan.synthesisStatus === "failed" && (
        <div className="space-y-2 font-mono text-[11px]">
          <p className="text-err">La síntesis falló: {plan.synthesisError}</p>
          <button onClick={onRetry} className="rounded border border-accent/40 px-2 py-0.5 text-accent hover:text-text-primary">reintentar síntesis</button>
        </div>
      )}
    </section>
  );
}

// ─── Main PlanView ─────────────────────────────────────────────────────────────

export function PlanView({
  plan: initialPlan,
  onClose,
}: {
  plan: Plan;
  onClose: () => void;
}) {
  const { lastEvent, logs } = useWs();
  const queryClient = useQueryClient();
  const [plan, setPlan] = useState<Plan>(initialPlan);
  const [mode, setMode] = useState<"idle" | "running-all" | "step-by-step">("idle");
  const [waitingForNext, setWaitingForNext] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);
  const [showFilePreview, setShowFilePreview] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isGenerating = plan.status === "generating";
  const genLog = logs.get(`gen:${plan.id}`) ?? "";

  // Listen for WS events
  useEffect(() => {
    if (!lastEvent) return;
    const e = lastEvent as any;

    // Live file changes
    if (e.type === "file:change" && e.planId === plan.id) {
      setChangedFiles((prev) => {
        const existing = prev.findIndex((f) => f.filePath === e.filePath);
        const entry: ChangedFile = { filePath: e.filePath, content: e.content, timestamp: e.timestamp };
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = entry;
          return next;
        }
        return [...prev, entry];
      });
      setShowFilePreview(true);
      return;
    }

    // Generation complete
    if (e.type === "plan:ready" && e.planId === plan.id) {
      setPlan(e.plan);
      return;
    }

    // Generation failed/cancelled
    if (e.type === "plan:error" && e.planId === plan.id) {
      setPlan((prev) => ({ ...prev, status: "failed" }));
      return;
    }

    if (!["plan:step", "plan:done", "plan:budget", "plan:synthesis", "plan:tier", "plan:guard"].includes(e.type)) return;
    if (e.planId !== plan.id) return;

    if (e.type === "plan:step") {
      setPlan((prev) => ({
        ...prev,
        steps: prev.steps.map((s) =>
          s.id === e.stepId ? { ...s, status: e.status, errorMessage: e.error ?? s.errorMessage } : s,
        ),
      }));
      if (e.status === "succeeded" && mode === "step-by-step") {
        setWaitingForNext(true);
        setMode("idle");
      }
    }

    if (e.type === "plan:tier") {
      setPlan((p) => ({ ...p, tier: e.tier, tierConfidence: e.confidence, tierSource: e.source }));
    }

    if (e.type === "plan:guard") {
      setPlan((p) => ({
        ...p,
        steps: p.steps.map((s) => (s.id === e.stepId ? { ...s, guardFlags: JSON.stringify(e.flags) } : s)),
      }));
    }

    if (e.type === "plan:budget") {
      setPlan((p) => ({ ...p, usedTokens: e.usedTokens, budgetTokens: e.budgetTokens }));
    }

    if (e.type === "plan:synthesis") {
      setPlan((p) => ({ ...p, synthesisStatus: e.status, synthesis: e.synthesis ?? p.synthesis, synthesisError: e.error ?? null }));
    }

    if (e.type === "plan:done") {
      setPlan((p) => ({ ...p, status: e.status, pauseReason: e.paused ?? null }));
      setMode("idle");
      setWaitingForNext(false);
      queryClient.invalidateQueries({ queryKey: ["plans"] });
      if (e.paused === "guard") {
        fetch(`/api/plans/${e.planId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p: Plan | null) => { if (p) setPlan(p); })
          .catch(() => {});
      }
    }
  }, [lastEvent, plan.id, mode, queryClient]);

  // Refresh plan on mount; if already completed, load persisted file changes
  useEffect(() => {
    if (!isGenerating) {
      fetch(`/api/plans/${plan.id}`)
        .then((r) => r.json())
        .then((p: Plan) => {
          setPlan(p);
          fetch(`/api/plans/${p.id}/file-changes`)
            .then((r) => r.json())
            .then((rows: Array<{ filePath: string; content: string; changedAt: string }>) => {
              if (rows.length > 0) {
                setChangedFiles(
                  rows.map((row) => ({
                    filePath: row.filePath,
                    content: row.content,
                    timestamp: row.changedAt,
                  }))
                );
                setShowFilePreview(true);
              }
            })
            .catch(() => {});
        })
        .catch(() => {});
    }
  }, [plan.id, isGenerating]);

  /** POST que muestra el error 409 del backend junto a los controles en vez de un alert. */
  async function postAction(path: string, fallbackMode: "idle" | "running-all" | "step-by-step" = "idle") {
    setActionError(null);
    try {
      const res = await fetch(`/api/plans/${plan.id}/${path}`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(body.error ?? `Error ${res.status}`);
        setMode(fallbackMode);
        return null;
      }
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
      setMode(fallbackMode);
      return null;
    }
  }

  /** Tras un POST rechazado, el estado optimista se descarta y se vuelve a leer el plan. */
  async function reloadPlan() {
    try {
      const res = await fetch(`/api/plans/${plan.id}`);
      if (res.ok) setPlan((await res.json()) as Plan);
    } catch { /* se queda el estado local */ }
  }

  async function handleRunAll() {
    setPlan((p) => ({ ...p, pauseReason: null }));
    setMode("running-all");
    await postAction("run-all");
  }

  async function handleRunNext() {
    setPlan((p) => ({ ...p, pauseReason: null }));
    setMode("step-by-step");
    setWaitingForNext(false);
    const r = await postAction("run-next");
    // Nada que arrancar (todo hecho o dependencias sin cumplir): salir del modo paso a paso.
    if (r && (r.blocked || r.done)) {
      setMode("idle");
      if (r.blocked) setActionError("Ningún paso puede arrancar: sus dependencias no se han completado.");
    }
  }

  async function handleContinue() {
    setMode("running-all");
    const r = await postAction("continue");
    if (r) setPlan((p) => ({ ...p, pauseReason: null, status: "running" }));
  }

  async function handleRetrySynthesis() {
    setPlan((p) => ({ ...p, synthesisStatus: "running", synthesisError: null }));
    if (!(await postAction("synthesis/retry"))) await reloadPlan();
  }

  async function handleSettings(patch: { budgetTokens?: number | null; maxParallel?: number }) {
    setActionError(null);
    try {
      const res = await fetch(`/api/plans/${plan.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<Plan> & { error?: string };
      if (!res.ok) {
        setActionError(body.error ?? `Error ${res.status}`);
        return;
      }
      setPlan((p) => ({ ...p, budgetTokens: body.budgetTokens ?? null, maxParallel: body.maxParallel ?? p.maxParallel }));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleResume() {
    // Reset failed steps to pending in local state immediately for responsive UI
    setPlan((p) => ({ ...p, pauseReason: null }));
    setMode("running-all");
    setPlan((prev) => ({
      ...prev,
      status: "running",
      steps: prev.steps.map((s) =>
        s.status === "failed" || s.status === "cancelled" ? { ...s, status: "pending", errorMessage: null } : s,
      ),
    }));
    if (!(await postAction("resume"))) await reloadPlan();
  }

  async function handleRetryStep(stepId: string) {
    setMode("running-all");
    setPlan((prev) => ({
      ...prev,
      status: "running",
      steps: prev.steps.map((s) =>
        s.id === stepId ? { ...s, status: "pending", errorMessage: null } : s,
      ),
    }));
    if (!(await postAction(`steps/${stepId}/retry`))) await reloadPlan();
  }

  async function handleApproveStep(stepId: string) {
    setMode("running-all");
    const r = await postAction(`steps/${stepId}/approve`);
    if (r) {
      setPlan((p) => ({ ...p, pauseReason: null, status: "running", steps: p.steps.map((s) => (s.id === stepId ? { ...s, guardApproved: 1 } : s)) }));
    }
    if (!r) await reloadPlan();
  }

  async function handleStop() {
    if (isGenerating) {
      await fetch(`/api/plans/${plan.id}/cancel-generation`, { method: "POST" });
    } else {
      await fetch(`/api/plans/${plan.id}/cancel`, { method: "POST" });
      setPlan((prev) => ({
        ...prev,
        steps: prev.steps.map((s) =>
          s.status === "pending" || s.status === "running" ? { ...s, status: "cancelled" } : s,
        ),
      }));
      setMode("idle");
    }
  }

  async function handleEditStep(step: PlanStep, newPrompt: string) {
    await fetch(`/api/plans/${plan.id}/steps/${step.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: newPrompt }),
    });
    // Igual que el servidor: el prompt nuevo borra banderas/aprobación de la guardia y quita su pausa.
    setPlan((prev) => ({
      ...prev,
      pauseReason: prev.pauseReason === "guard" ? null : prev.pauseReason,
      steps: prev.steps.map((s) => (s.id === step.id ? { ...s, prompt: newPrompt, guardFlags: null, guardApproved: 0 } : s)),
    }));
  }

  // Show generating view
  if (isGenerating) {
    return (
      <GeneratingView
        plan={plan}
        genLog={genLog}
        onCancel={handleStop}
      />
    );
  }

  // Generation failed or cancelled before steps were created
  if ((plan.status === "failed" || plan.status === "cancelled") && plan.steps.length === 0) {
    const wasCancelled = plan.status === "cancelled";
    return (
      <div className="flex flex-col h-full bg-surface-0">
        <div className="flex items-center gap-4 px-6 h-12 border-b border-edge shrink-0">
          <button onClick={onClose} className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors">
            ← volver
          </button>
          <span className="font-mono text-xs text-text-secondary">/plan</span>
        </div>
        <div className="flex items-center justify-center flex-1 px-8">
          <div className="text-center space-y-3 max-w-lg">
            <p className={`font-mono text-xs ${wasCancelled ? "text-text-tertiary" : "text-err"}`}>
              {wasCancelled ? "generación cancelada" : "error generando plan"}
            </p>
            <p className="font-mono text-[10px] text-text-tertiary">{plan.description}</p>
            {!wasCancelled && plan.errorMessage && (
              <pre className="mt-3 font-mono text-[10px] text-err/80 whitespace-pre-wrap text-left bg-err/5 border border-err/20 rounded-lg p-3">
                {plan.errorMessage}
              </pre>
            )}
          </div>
        </div>
        <PlanChat plan={{ ...plan, steps: [] }} />
      </div>
    );
  }

  // Igual que el backend: cancelados no cuentan como hechos.
  const allDone = plan.steps.length > 0 && plan.steps.every((s) => s.status === "succeeded" || s.status === "skipped");
  const synthesisRunning = plan.synthesisStatus === "running";
  const isRunning = mode !== "idle" || plan.status === "running" || synthesisRunning || plan.steps.some((s) => s.status === "running");
  const isPaused = plan.status === "pending" && !!plan.pauseReason;
  const pendingCount = plan.steps.filter((s) => s.status === "pending").length;
  const failedCount = plan.steps.filter((s) => s.status === "failed").length;
  const cancelledCount = plan.steps.filter((s) => s.status === "cancelled").length;
  const hasCancelled = cancelledCount > 0;
  const succeededCount = plan.steps.filter((s) => s.status === "succeeded").length;
  const totalCost = plan.steps.reduce((acc, s) => acc + (s.costUsd ?? 0), 0);
  // Plan has failed/pending steps that can be resumed
  const criticalUntouched = plan.tier === "critical" && plan.status === "pending" && plan.steps.every((s) => s.status === "pending");
  const canResume = !isRunning && !allDone && (failedCount > 0 || pendingCount > 0);

  return (
    <>
    {showSaveModal && <SavePlanModal plan={plan} onClose={() => setShowSaveModal(false)} />}
    <div className="flex flex-col h-full bg-surface-0">

      {/* ── Header (fixed, outside resizable group) ── */}
      <div className="flex items-center gap-2 px-4 min-h-12 py-2 border-b border-edge shrink-0 flex-wrap">
        <button
          onClick={onClose}
          className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
        >
          ← volver
        </button>
        <span className="font-mono text-xs text-text-secondary">/plan</span>
        <TierBadge plan={plan} />

        <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
          {changedFiles.length > 0 && (
            <button
              onClick={() => setShowFilePreview((v) => !v)}
              className={`font-mono text-[10px] border rounded px-2 py-0.5 transition-colors ${
                showFilePreview
                  ? "text-ok border-ok/30 bg-ok/10"
                  : "text-text-tertiary border-edge hover:text-ok hover:border-ok/30"
              }`}
              title="ver archivos modificados"
            >
              📄 {changedFiles.length}
            </button>
          )}
          {plan.steps.length > 0 && (
            <button
              onClick={() => setShowSaveModal(true)}
              className="font-mono text-[11px] text-text-tertiary hover:text-text-secondary border border-edge hover:border-edge-strong rounded px-2.5 py-1 transition-colors"
            >
              guardar
            </button>
          )}
          {canResume && failedCount > 0 && (
            <button
              onClick={handleResume}
              className="font-mono text-[11px] text-ok hover:text-text-primary border border-ok/30 bg-ok/5 rounded px-2.5 py-1 transition-colors animate-fade-in flex items-center gap-1.5"
            >
              ↺ continuar
              <span className="font-mono text-[9px] text-err/70">
                ({failedCount} fallido{failedCount > 1 ? "s" : ""} + {pendingCount} pendiente{pendingCount !== 1 ? "s" : ""})
              </span>
            </button>
          )}
          {!allDone && !isRunning && failedCount === 0 && !plan.pauseReason && plan.status !== "completed" && (
            <>
              {!criticalUntouched && (
              <button
                onClick={hasCancelled ? handleResume : handleRunAll}
                className="font-mono text-[11px] text-ok hover:text-text-primary border border-ok/30 rounded px-2.5 py-1 transition-colors"
              >
                {plan.status === "cancelled" || plan.status === "failed" || hasCancelled ? "reanudar todo" : "ejecutar todo"}
              </button>
              )}
              {/* paso a paso no reanuda pasos cancelados; para un plan cancelado solo se ofrece reanudar todo */}
              {plan.status !== "cancelled" && !hasCancelled && !criticalUntouched && (
                <button
                  onClick={handleRunNext}
                  className="font-mono text-[11px] text-accent hover:text-text-primary border border-accent/30 rounded px-2.5 py-1 transition-colors"
                >
                  paso a paso
                </button>
              )}
            </>
          )}
          {waitingForNext && (
            <button
              onClick={handleRunNext}
              className="font-mono text-[11px] text-accent hover:text-text-primary border border-accent/30 rounded px-2.5 py-1 transition-colors animate-fade-in"
            >
              continuar →
            </button>
          )}
          {isRunning && !waitingForNext && (
            <span className="font-mono text-[10px] text-accent">{synthesisRunning ? "sintetizando…" : "ejecutando…"}</span>
          )}
          {isRunning && !waitingForNext && (
            <button
              onClick={handleStop}
              className="font-mono text-[11px] text-err hover:text-text-primary border border-err/30 rounded px-2.5 py-1 transition-colors"
            >
              detener
            </button>
          )}
          {!isRunning && plan.status === "completed" && (
            <span className="font-mono text-[10px] text-ok flex items-center gap-1.5">
              ✓ completado
              {totalCost > 0 && <span className="text-text-tertiary">${totalCost.toFixed(4)}</span>}
            </span>
          )}
          {!isRunning && isPaused && (
            <span className="font-mono text-[10px] text-accent">pausado</span>
          )}
          {!isRunning && plan.status === "cancelled" && (
            <span className="font-mono text-[10px] text-text-tertiary">cancelado</span>
          )}
          {!isRunning && plan.status === "pending" && !plan.pauseReason && !allDone && (
            <span className="font-mono text-[10px] text-text-tertiary">pendiente</span>
          )}
        </div>
      </div>

      <BudgetBar plan={plan} disabled={isRunning} onSave={handleSettings} />
      {actionError && <p role="alert" className="mx-4 font-mono text-[10px] text-err">{actionError}</p>}
      <PauseBanner plan={plan} onContinue={handleContinue} />
      <CriticalBanner plan={plan} busy={mode !== "idle"} onApprove={handleRunAll} />
      <GuardBanner plan={plan} onApprove={handleApproveStep} onCancel={handleStop} onContinue={handleContinue} />

      {/* ── Resizable body: [plan+preview] / [chat] ── */}
      <ResizableGroup direction="vertical" className="flex-1 min-h-0">

        {/* Top panel: plan info + steps (+ optional file preview side) */}
        <ResizablePanel defaultSize={68} minSize={25} className="min-h-0 overflow-hidden">
          <ResizableGroup direction="horizontal" className="h-full">

            {/* Steps column — single unified scroll */}
            <ResizablePanel defaultSize={60} minSize={30} className="min-w-0 overflow-hidden">
              <div className="h-full overflow-y-auto px-6 py-5">
                <div className="max-w-3xl mx-auto">
                {/* Plan description + diagram + stats */}
                <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary mb-1">plan</p>
                <p className="text-sm text-text-primary leading-relaxed mb-4">{plan.description}</p>
                <SynthesisCard plan={plan} onRetry={handleRetrySynthesis} />
                <PlanSummary plan={plan} />
                {plan.steps.length > 0 && (
                  <div className="mb-2">
                    <FlowDiagram steps={plan.steps} />
                  </div>
                )}
                <div className="flex items-center gap-3 mt-3 mb-5 font-mono text-[10px] text-text-tertiary">
                  <span>{plan.steps.length} pasos</span>
                  {succeededCount > 0 && <span className="text-ok">{succeededCount} completados</span>}
                  {failedCount > 0 && <span className="text-err">{failedCount} fallido{failedCount > 1 ? "s" : ""}</span>}
                  {pendingCount > 0 && <span>{pendingCount} pendientes</span>}
                  {isRunning && (
                    <span className="flex items-center gap-1 text-accent">
                      <span className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" />
                      ejecutando
                    </span>
                  )}
                </div>
                {/* Steps list */}
                <div className="space-y-3">
                  {plan.steps.map((step) => {
                    // Files changed during this step's execution window
                    const stepFiles = step.startedAt
                      ? changedFiles.filter((f) => {
                          if (!step.startedAt) return false;
                          const t = f.timestamp;
                          const end = step.finishedAt ?? new Date().toISOString();
                          return t >= step.startedAt && t <= end;
                        })
                      : [];
                    return (
                      <StepCard
                        key={step.id}
                        step={step}
                        streamLog={logs.get(step.id) ?? ""}
                        stepFiles={stepFiles}
                        onEdit={handleEditStep}
                        onRetry={isRunning ? undefined : (s) => handleRetryStep(s.id)}
                        onFileClick={(f) => {
                          // Ensure file is in changedFiles list and open preview
                          setChangedFiles((prev) => {
                            const exists = prev.some((x) => x.filePath === f.filePath);
                            return exists ? prev : [...prev, f];
                          });
                          setShowFilePreview(true);
                        }}
                      />
                    );
                  })}
                </div>
                </div>
              </div>
            </ResizablePanel>

            {/* File preview column (optional) */}
            {showFilePreview && changedFiles.length > 0 && (
              <>
                <ResizableHandle direction="horizontal" />
                <ResizablePanel defaultSize={40} minSize={20} className="min-w-0 overflow-hidden">
                  <FilePreviewPanel
                    files={changedFiles}
                    onClose={() => setShowFilePreview(false)}
                  />
                </ResizablePanel>
              </>
            )}

          </ResizableGroup>
        </ResizablePanel>

        {/* Vertical drag handle */}
        <ResizableHandle direction="vertical" />

        {/* Bottom panel: modification chat */}
        <ResizablePanel defaultSize={32} minSize={10} className="min-h-0 overflow-hidden">
          <PlanChat plan={plan} />
        </ResizablePanel>

      </ResizableGroup>
    </div>
    </>
  );
}
