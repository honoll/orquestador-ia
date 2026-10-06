import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useWs } from "../context/WebSocketProvider";
import { useAppState } from "../context/AppStateContext";
import { parseStreamingText } from "../lib/parse-stream";
import { PlanView, type Plan } from "./PlanView";
import { GitHubCloneModal } from "./GitHubCloneModal";
import { FileContextPicker, buildFileContext } from "./FileContextPicker";

interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  icon: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/plan",   args: "<descripción>", description: "Genera un plan de ejecución multi-agente", icon: "◈" },
  { name: "/run",    args: "<comando>",     description: "Ejecuta un comando de terminal",            icon: "⬡" },
  { name: "/clone",  args: "<url>",         description: "Clona un repositorio de GitHub",            icon: "⬇" },
  { name: "/nuevo",                         description: "Inicia una conversación nueva",             icon: "○" },
  { name: "/clear",                         description: "Limpia el historial visual",                icon: "◻" },
  { name: "/claude", args: "<prompt>",      description: "Fuerza el uso de Claude",                  icon: "◆" },
  { name: "/codex",  args: "<prompt>",      description: "Fuerza el uso de Codex",                   icon: "◇" },
  { name: "/agy", args: "<prompt>",         description: "Fuerza el uso de Antigravity (agy)",       icon: "◎" },
  { name: "/slides", args: "<descripción>", description: "Crea presentación HTML animada",           icon: "◫" },
];

interface AdapterInfo {
  type: string;
  label: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  available: boolean;
}

interface Task {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  title: string;
  prompt: string;
  adapter: string;
  model: string | null;
  status: string;
  createdAt: string;
}

interface Run {
  id: string;
  taskId: string;
  adapter: string;
  model: string | null;
  status: string;
  summary: string | null;
  sessionId: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  adapter?: string;
  model?: string | null;
  costUsd?: number;
  sessionId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  status?: string;
  runId?: string;
  errorMessage?: string | null;
}

export function Chat() {
  const queryClient = useQueryClient();
  const { logs, lastEvent } = useWs();
  const {
    selectedAdapter, selectedModel, setAdapter, setModel,
    selectedProjectId, conversationId, setConversation, newChat,
    activePlanId, setActivePlanId,
  } = useAppState();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [loadedConversation, setLoadedConversation] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [showCloneModal, setShowCloneModal] = useState(false);
  const [cloneInitialUrl, setCloneInitialUrl] = useState("");
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<{ path: string; content: string; truncated: boolean }[]>([]);
  const [activeShellJobId, setActiveShellJobId] = useState<string | null>(null);
  const [analyzingFiles, setAnalyzingFiles] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Command palette: show when input starts with "/" and no space yet or partial command match
  const paletteQuery = input.startsWith("/") ? input.split(" ")[0].toLowerCase() : null;
  const paletteCommands = paletteQuery !== null
    ? SLASH_COMMANDS.filter((c) => c.name.startsWith(paletteQuery))
    : [];
  const showPalette = paletteCommands.length > 0 && !input.includes("\n") && !/^\/\S+ .+/.test(input);

  const { data: adapters } = useQuery<Record<string, AdapterInfo>>({
    queryKey: ["adapters"],
    queryFn: () => fetch("/api/adapters").then((r) => r.json()),
  });

  const availableAdapters = adapters
    ? Object.values(adapters).filter((a) => a.available)
    : [];

  const currentAdapter = adapters?.[selectedAdapter];
  const resolvedModel = selectedModel || currentAdapter?.defaultModel || "";

  // Load conversation history when conversationId changes
  const loadConversation = useCallback(async (convId: string) => {
    try {
      const tasksRes = await fetch(`/api/tasks?conversationId=${convId}`);
      const tasks: Task[] = await tasksRes.json();

      const loaded: Message[] = [];

      for (const task of tasks) {
        loaded.push({ role: "user", content: task.prompt });

        const runsRes = await fetch(`/api/runs/task/${task.id}`);
        const runs: Run[] = await runsRes.json();

        if (runs.length > 0) {
          const run = runs[0];
          loaded.push({
            role: "assistant",
            content: run.summary || "(sin respuesta)",
            adapter: run.adapter,
            model: run.model,
            costUsd: run.costUsd ?? 0,
            sessionId: run.sessionId,
            inputTokens: run.inputTokens ?? 0,
            outputTokens: run.outputTokens ?? 0,
            status: run.status,
            runId: run.id,
            errorMessage: run.errorMessage,
          });
        }
      }

      setMessages(loaded);
      setLoadedConversation(convId);
    } catch {
      // silently fail
    }
  }, []);

  useEffect(() => {
    if (conversationId && conversationId !== loadedConversation) {
      loadConversation(conversationId);
    } else if (!conversationId && loadedConversation) {
      setMessages([]);
      setLoadedConversation(null);
    }
  }, [conversationId, loadedConversation, loadConversation]);

  // Load plan from context (triggered by ProjectPanel click)
  useEffect(() => {
    if (!activePlanId) {
      setActivePlan(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/plans/${activePlanId}`);
        if (!res.ok) return;
        const plan: Plan = await res.json();
        setActivePlan(plan);
      } catch { /* ignore */ }
    })();
  }, [activePlanId]);

  const sendMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const taskRes = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: prompt.slice(0, 80),
          prompt,
          adapter: selectedAdapter,
          model: resolvedModel,
          projectId: selectedProjectId || undefined,
          conversationId: conversationId || undefined,
        }),
      });
      const task: Task = await taskRes.json();

      const runRes = await fetch(`/api/tasks/${task.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const { runId } = await runRes.json();
      return { task, runId };
    },
    onSuccess: ({ task, runId }) => {
      // Set conversationId from the first task's conversation
      if (!conversationId && task.conversationId) {
        setConversation(task.conversationId);
        setLoadedConversation(task.conversationId);
      }
      setActiveRunId(runId);
    },
  });

  useEffect(() => {
    if (!activeRunId) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/runs/${activeRunId}`);
      const run: Run = await res.json();

      if (run.status !== "running") {
        clearInterval(interval);
        setActiveRunId(null);
        setMessages((prev) => {
          const filtered = prev.filter((m) => m.runId !== activeRunId);
          return [
            ...filtered,
            {
              role: "assistant" as const,
              content: run.summary ||
                (logs.get(activeRunId) ? parseStreamingText(logs.get(activeRunId)!, run.adapter) : "") ||
                "(sin respuesta)",
              adapter: run.adapter,
              model: run.model,
              costUsd: run.costUsd ?? 0,
              sessionId: run.sessionId,
              inputTokens: run.inputTokens ?? 0,
              outputTokens: run.outputTokens ?? 0,
              status: run.status,
              runId: activeRunId,
              errorMessage: run.errorMessage,
            },
          ];
        });
        queryClient.invalidateQueries({ queryKey: ["tasks"] });
        queryClient.invalidateQueries({ queryKey: ["conversations"] });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [activeRunId, logs, queryClient]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRunId, logs]);

  function selectPaletteCommand(cmd: SlashCommand) {
    setPaletteIndex(0);
    if (!cmd.args) {
      // No args — execute immediately
      processPrompt(cmd.name);
    } else {
      // Has args — fill input so user can type the rest
      const newVal = `${cmd.name} `;
      setInput(newVal);
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.style.height = "auto";
          el.style.height = Math.min(el.scrollHeight, 160) + "px";
        }
      }, 0);
    }
  }

  async function handlePlanCommand(description: string) {
    setInput("");
    try {
      const res = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description,
          projectId: selectedProjectId || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const plan: Plan = await res.json();
      // Open PlanView immediately in "generating" state — WS events will update it
      setActivePlan(plan);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: `/plan ${description}` },
        { role: "assistant", content: `Error iniciando plan: ${err.message}`, status: "failed" },
      ]);
    }
  }

  // Shell job completion listener
  useEffect(() => {
    if (!lastEvent || !activeShellJobId) return;
    const e = lastEvent as any;
    if (e.type === "shell:done" && e.jobId === activeShellJobId) {
      const log = logs.get(`sh:${activeShellJobId}`) ?? "(sin output)";
      setMessages(prev => [
        ...prev.filter(m => (m as any).shellJobId !== activeShellJobId),
        {
          role: "assistant" as const,
          content: `\`\`\`\n${log}\n\`\`\``,
          status: e.exitCode === 0 ? "succeeded" : "failed",
        },
      ]);
      setActiveShellJobId(null);
    }
  }, [lastEvent, activeShellJobId, logs]);

  /**
   * If files are attached, runs them through agy first to get an analysis summary.
   * Falls back to raw file content if agy is unavailable.
   */
  async function getFileAnalysisContext(
    files: { path: string; content: string; truncated: boolean }[],
    userPrompt: string,
    cwd?: string,
  ): Promise<string> {
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files, prompt: userPrompt, cwd }),
      });
      const data = await res.json();
      if (data.analysis) {
        return `[Análisis de archivos (agy)]\n${data.analysis}\n\n`;
      }
    } catch {
      // fall through to raw context
    }
    // Fallback: inject raw file content
    return buildFileContext(files);
  }

  function processPrompt(prompt: string) {
    if (!prompt || sendMutation.isPending || activeRunId) return;

    // /slides <descripción>
    const slidesMatch = prompt.match(/^\/slides\s+(.+)/si);
    if (slidesMatch) {
      const description = slidesMatch[1].trim();
      const slidesPrompt = `Use the frontend-slides skill to create a stunning, animation-rich HTML presentation. Topic/description: ${description}`;
      setMessages((prev) => [...prev, { role: "user", content: `/slides ${description}` }]);
      setInput("");
      (async () => {
        try {
          const taskRes = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: `slides: ${description.slice(0, 60)}`,
              prompt: slidesPrompt,
              adapter: "claude",
              model: adapters?.["claude"]?.defaultModel || resolvedModel,
              projectId: selectedProjectId || undefined,
              conversationId: conversationId || undefined,
            }),
          });
          const task: Task = await taskRes.json();
          const runRes = await fetch(`/api/tasks/${task.id}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const { runId } = await runRes.json();
          if (!conversationId && task.conversationId) {
            setConversation(task.conversationId);
            setLoadedConversation(task.conversationId);
          }
          setActiveRunId(runId);
        } catch (err: any) {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${err.message}`, status: "failed" },
          ]);
        }
      })();
      return;
    }

    // /plan
    const planMatch = prompt.match(/^\/plan\s+(.+)/si);
    if (planMatch) {
      handlePlanCommand(planMatch[1].trim());
      return;
    }

    // /run <command>
    const runMatch = prompt.match(/^\/run\s+(.+)/si);
    if (runMatch) {
      const cmd = runMatch[1].trim();
      setMessages(prev => [...prev, { role: "user" as const, content: `/run ${cmd}` }]);
      setInput("");
      (async () => {
        const res = await fetch("/api/shell/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command: cmd, cwd: undefined }),
        });
        const { jobId } = await res.json();
        setActiveShellJobId(jobId);
      })();
      return;
    }

    // /clone <url>
    const cloneMatch = prompt.match(/^\/clone\s*(.+)?/si);
    if (cloneMatch) {
      setCloneInitialUrl((cloneMatch[1] ?? "").trim());
      setShowCloneModal(true);
      setInput("");
      return;
    }

    // /nuevo
    if (prompt === "/nuevo") {
      handleNewChat();
      setInput("");
      return;
    }

    // /clear
    if (prompt === "/clear") {
      setMessages([]);
      setInput("");
      return;
    }

    // /claude, /codex, /agy — force adapter for this message
    const adapterMatch = prompt.match(/^\/(claude|codex|agy)\s+(.+)/si);
    if (adapterMatch) {
      const forcedAdapter = adapterMatch[1].toLowerCase();
      const forcedPrompt = adapterMatch[2].trim();
      const filesToAttach = [...attachedFiles];
      setMessages((prev) => [...prev, { role: "user", content: forcedPrompt }]);
      setInput("");
      setAttachedFiles([]);
      (async () => {
        try {
          // Always run files through agy first, even for forced adapter
          let effectivePrompt = forcedPrompt;
          if (filesToAttach.length > 0) {
            setAnalyzingFiles(true);
            const ctx = await getFileAnalysisContext(filesToAttach, forcedPrompt);
            setAnalyzingFiles(false);
            effectivePrompt = ctx + forcedPrompt;
          }
          const taskRes = await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: forcedPrompt.slice(0, 80),
              prompt: effectivePrompt,
              adapter: forcedAdapter,
              model: adapters?.[forcedAdapter]?.defaultModel || resolvedModel,
              projectId: selectedProjectId || undefined,
              conversationId: conversationId || undefined,
            }),
          });
          const task: Task = await taskRes.json();
          const runRes = await fetch(`/api/tasks/${task.id}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          const { runId } = await runRes.json();
          if (!conversationId && task.conversationId) {
            setConversation(task.conversationId);
            setLoadedConversation(task.conversationId);
          }
          setActiveRunId(runId);
        } catch (err: any) {
          setAnalyzingFiles(false);
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${err.message}`, status: "failed" },
          ]);
        }
      })();
      return;
    }

    // Normal prompt — run files through agy if attached, then send to selected adapter
    const filesToAttach = [...attachedFiles];
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setInput("");
    setAttachedFiles([]);

    if (filesToAttach.length > 0) {
      // Async: agy analysis → main adapter
      (async () => {
        try {
          setAnalyzingFiles(true);
          const ctx = await getFileAnalysisContext(filesToAttach, prompt);
          setAnalyzingFiles(false);
          sendMutation.mutate(ctx + prompt);
        } catch {
          setAnalyzingFiles(false);
          sendMutation.mutate(buildFileContext(filesToAttach) + prompt);
        }
      })();
    } else {
      sendMutation.mutate(prompt);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    processPrompt(input.trim());
  }

  async function handleStop() {
    if (!activeRunId) return;
    await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
    setActiveRunId(null);
  }

  function handleNewChat() {
    newChat();
    setMessages([]);
    setLoadedConversation(null);
  }

  const rawStreamContent = activeRunId ? logs.get(activeRunId) ?? "" : "";
  const streamingContent = rawStreamContent
    ? parseStreamingText(rawStreamContent, selectedAdapter)
    : "";

  // Plan view
  if (activePlan) {
    return <PlanView plan={activePlan} onClose={() => { setActivePlan(null); setActivePlanId(null); }} />;
  }

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Header bar */}
      <div className="flex items-center gap-4 px-6 h-12 border-b border-edge shrink-0">
        <select
          className="bg-transparent font-mono text-[11px] text-text-secondary appearance-none cursor-pointer hover:text-text-primary focus:outline-none transition-colors pr-4"
          value={selectedAdapter}
          onChange={(e) => setAdapter(e.target.value)}
        >
          {availableAdapters.map((a) => (
            <option key={a.type} value={a.type}>
              {a.label}
            </option>
          ))}
          {availableAdapters.length === 0 && (
            <option value="">---</option>
          )}
        </select>

        <span className="text-text-tertiary font-mono text-[10px]">/</span>

        {currentAdapter && (
          <select
            className="bg-transparent font-mono text-[11px] text-text-secondary appearance-none cursor-pointer hover:text-text-primary focus:outline-none transition-colors pr-4"
            value={resolvedModel}
            onChange={(e) => setModel(e.target.value)}
          >
            {currentAdapter.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}

        <div className="ml-auto flex items-center gap-3">
          {messages.length > 0 && (
            <button
              onClick={handleNewChat}
              className="font-mono text-[10px] text-text-tertiary hover:text-accent transition-colors"
            >
              + nuevo chat
            </button>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
          {messages.length === 0 && !activeRunId && (
            <div className="flex items-center justify-center min-h-[60vh]">
              <div className="text-center space-y-2">
                <p className="font-mono text-sm text-text-secondary tracking-tight">
                  orquestador
                </p>
                <p className="text-xs text-text-tertiary">
                  {currentAdapter?.label ?? "CLI de IA"}
                </p>
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div
              key={`${msg.runId || i}-${i}`}
              className="animate-fade-in"
              style={{ animationDelay: `${50}ms` }}
            >
              {msg.role === "user" ? (
                <div className="flex justify-end">
                  <div className="max-w-[75%] bg-surface-2 rounded-2xl rounded-br-sm px-4 py-3">
                    <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
                      {msg.content}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="prose prose-invert prose-sm max-w-none text-text-primary/90 leading-relaxed [&_p]:my-2 [&_pre]:bg-surface-2 [&_pre]:border [&_pre]:border-edge [&_pre]:rounded-lg">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code({ className, children, ...props }) {
                          const match = /language-(\w+)/.exec(className || "");
                          const code = String(children).replace(/\n$/, "");
                          if (match) {
                            return (
                              <SyntaxHighlighter
                                style={vscDarkPlus}
                                language={match[1]}
                                PreTag="div"
                                customStyle={{
                                  margin: 0,
                                  padding: "1rem",
                                  borderRadius: "0.5rem",
                                  fontSize: "0.75rem",
                                  background: "#16161a",
                                  border: "1px solid #ffffff0a",
                                }}
                              >
                                {code}
                              </SyntaxHighlighter>
                            );
                          }
                          return (
                            <code
                              className="font-mono text-[0.8em] bg-surface-2 text-accent px-1.5 py-0.5 rounded"
                              {...props}
                            >
                              {children}
                            </code>
                          );
                        },
                      }}
                    >
                      {msg.content}
                    </ReactMarkdown>
                  </div>

                  {/* Meta */}
                  <div className="flex items-center gap-3 font-mono text-[10px] text-text-tertiary">
                    {msg.adapter && (
                      <span className="text-text-tertiary/60">{msg.adapter}</span>
                    )}
                    {msg.model && <span>{msg.model}</span>}
                    {(msg.costUsd ?? 0) > 0 && (
                      <span>${msg.costUsd!.toFixed(4)}</span>
                    )}
                    {(msg.inputTokens ?? 0) > 0 && (
                      <span>{msg.inputTokens!.toLocaleString()} in</span>
                    )}
                    {(msg.outputTokens ?? 0) > 0 && (
                      <span>{msg.outputTokens!.toLocaleString()} out</span>
                    )}
                    {msg.sessionId && (
                      <span className="truncate max-w-24" title={msg.sessionId}>
                        {msg.sessionId.slice(0, 8)}
                      </span>
                    )}
                    {msg.status === "failed" && (
                      <span className="text-err" title={msg.errorMessage ?? undefined}>
                        error
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* agy file analysis indicator */}
          {analyzingFiles && (
            <div className="animate-fade-in flex items-center gap-2">
              <span className="font-mono text-sm text-sky-400">◎</span>
              <div className="h-1 w-1 rounded-full bg-sky-400 animate-pulse-dot" />
              <span className="font-mono text-xs text-sky-400/80">
                ◎ agy analizando archivos…
              </span>
            </div>
          )}

          {/* Streaming */}
          {activeRunId && (
            <div className="animate-fade-in">
              {streamingContent ? (
                <pre className="font-mono text-xs text-text-secondary whitespace-pre-wrap leading-relaxed">
                  {streamingContent}
                  <span className="streaming-cursor" />
                </pre>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="h-1 w-1 rounded-full bg-accent animate-pulse-dot" />
                  <span className="font-mono text-xs text-text-tertiary">
                    ejecutando
                  </span>
                </div>
              )}
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-edge px-6 py-4 shrink-0">
        <div className="max-w-3xl mx-auto relative">
          {/* Command palette */}
          {showPalette && (
            <div className="absolute bottom-full mb-2 left-0 right-0 bg-surface-2 border border-edge-strong rounded-xl overflow-hidden shadow-lg animate-fade-in z-50">
              <div className="px-3 pt-2 pb-1">
                <span className="font-mono text-[9px] uppercase tracking-widest text-text-tertiary">comandos</span>
              </div>
              {paletteCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); selectPaletteCommand(cmd); }}
                  onMouseEnter={() => setPaletteIndex(i)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                    i === paletteIndex ? "bg-surface-1" : "hover:bg-surface-1/50"
                  }`}
                >
                  <span className="font-mono text-[11px] text-text-tertiary w-4 shrink-0">{cmd.icon}</span>
                  <span className="font-mono text-xs text-accent shrink-0">{cmd.name}</span>
                  {cmd.args && (
                    <span className="font-mono text-[10px] text-text-tertiary shrink-0">{cmd.args}</span>
                  )}
                  <span className="font-mono text-[10px] text-text-tertiary ml-auto truncate pl-4">
                    {cmd.description}
                  </span>
                </button>
              ))}
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div className="flex items-end gap-3 bg-surface-1 rounded-xl border border-edge-strong px-4 py-3 focus-within:border-accent/30 transition-colors">
              <textarea
                ref={textareaRef}
                className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder-text-tertiary focus:outline-none leading-relaxed"
                rows={1}
                placeholder="prompt..."
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setPaletteIndex(0);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
                }}
                onKeyDown={(e) => {
                  if (showPalette) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setPaletteIndex((i) => Math.min(i + 1, paletteCommands.length - 1));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setPaletteIndex((i) => Math.max(i - 1, 0));
                      return;
                    }
                    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                      e.preventDefault();
                      selectPaletteCommand(paletteCommands[paletteIndex]);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setInput("");
                      return;
                    }
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                disabled={!!activeRunId || analyzingFiles}
              />
              {/* File attach button — only when a project is selected */}
              {selectedProjectId && !activeRunId && (
                <button
                  type="button"
                  onClick={() => setShowFilePicker(true)}
                  title="Adjuntar archivos como contexto"
                  className={`shrink-0 font-mono text-sm pb-0.5 transition-colors ${
                    attachedFiles.length > 0 ? "text-accent" : "text-text-tertiary hover:text-text-secondary"
                  }`}
                >
                  📎{attachedFiles.length > 0 && <span className="text-[10px] ml-0.5">{attachedFiles.length}</span>}
                </button>
              )}
              {activeRunId || activeShellJobId ? (
                <button
                  type="button"
                  onClick={activeShellJobId
                    ? () => { fetch(`/api/shell/${activeShellJobId}/kill`, { method: "POST" }); setActiveShellJobId(null); }
                    : handleStop}
                  className="shrink-0 font-mono text-xs text-err hover:text-text-primary transition-colors pb-0.5"
                >
                  detener
                </button>
              ) : analyzingFiles ? (
                <span className="shrink-0 font-mono text-[10px] text-sky-400/70 pb-0.5">
                  ◎ agy…
                </span>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim() || sendMutation.isPending}
                  className="shrink-0 font-mono text-xs text-text-tertiary hover:text-accent disabled:opacity-20 disabled:cursor-default transition-colors pb-0.5"
                >
                  enviar
                </button>
              )}
            </div>
          </form>

          {/* Attached files chips */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {attachedFiles.map(f => (
                <div key={f.path} className="flex items-center gap-1 bg-surface-2 border border-edge rounded-lg px-2 py-0.5">
                  <span className="font-mono text-[10px] text-text-secondary truncate max-w-[160px]">{f.path}</span>
                  {f.truncated && <span className="font-mono text-[9px] text-text-tertiary">…</span>}
                  <button
                    onClick={() => setAttachedFiles(prev => prev.filter(x => x.path !== f.path))}
                    className="font-mono text-[10px] text-text-tertiary hover:text-err transition-colors ml-0.5"
                  >×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showCloneModal && (
        <GitHubCloneModal
          initialUrl={cloneInitialUrl}
          onClose={() => setShowCloneModal(false)}
          onCloned={() => setShowCloneModal(false)}
        />
      )}
      {showFilePicker && selectedProjectId && (
        <FileContextPicker
          projectId={selectedProjectId}
          onAttach={(files) => { setAttachedFiles(prev => [...prev, ...files]); setShowFilePicker(false); }}
          onClose={() => setShowFilePicker(false)}
        />
      )}
    </div>
  );
}
