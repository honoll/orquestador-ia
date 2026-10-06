import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAppState } from "../context/AppStateContext";

interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  createdAt: string;
}

interface Conversation {
  conversationId: string;
  title: string;
  adapter: string;
  model: string | null;
  status: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface Plan {
  id: string;
  projectId: string | null;
  description: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

async function fetchProjects(): Promise<Project[]> {
  const res = await fetch("/api/projects");
  return res.json();
}

async function fetchConversations(projectId: string): Promise<Conversation[]> {
  const res = await fetch(`/api/tasks/conversations?projectId=${projectId}`);
  return res.json();
}

async function fetchPlans(projectId: string): Promise<Plan[]> {
  const res = await fetch(`/api/plans?projectId=${projectId}`);
  return res.json();
}

export function ProjectPanel({ onClose }: { onClose?: () => void }) {
  const queryClient = useQueryClient();
  const { selectedProjectId, setProject, conversationId, setConversation, setActivePlanId, newChat } = useAppState();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [desc, setDesc] = useState("");

  const { data: projects, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: fetchProjects,
  });

  const { data: conversations } = useQuery({
    queryKey: ["conversations", selectedProjectId],
    queryFn: () => fetchConversations(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  const { data: plans } = useQuery({
    queryKey: ["plans", selectedProjectId],
    queryFn: () => fetchPlans(selectedProjectId!),
    enabled: !!selectedProjectId,
  });

  const activeProject = projects?.find((p) => p.id === selectedProjectId);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, path, description: desc || undefined }),
      });
      return res.json();
    },
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setShowForm(false);
      setName("");
      setPath("");
      setDesc("");
      setProject(project.id);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/projects/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      setProject(null);
    },
  });

  const deletePlanMutation = useMutation({
    mutationFn: async (planId: string) => {
      await fetch(`/api/plans/${planId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plans"] });
    },
  });

  const deleteConvMutation = useMutation({
    mutationFn: async (convId: string) => {
      await fetch(`/api/tasks/conversation/${convId}`, { method: "DELETE" });
    },
    onSuccess: (_, deletedConvId) => {
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      // If we deleted the active conversation, start a new chat
      if (conversationId === deletedConvId) {
        newChat();
      }
    },
  });

  const inputClass =
    "w-full bg-transparent border-b border-edge-strong px-0 py-2 text-xs text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none transition-colors font-mono";

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between px-5 py-4">
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
          proyectos
        </span>
        <div className="flex items-center gap-2">
          {selectedProjectId && (
            <button
              onClick={() => setProject(null)}
              className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
              title="ver todos"
            >
              ← todos
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="font-mono text-[10px] text-text-secondary hover:text-accent transition-colors"
          >
            {showForm ? "cancelar" : "+ nuevo"}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title="Ocultar proyectos"
              className="font-mono text-[10px] text-text-tertiary hover:text-text-secondary transition-colors ml-1"
            >
              ›
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {/* Create form */}
        {showForm && (
          <form
            className="mb-6 animate-fade-in"
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate();
            }}
          >
            <input
              className={inputClass}
              placeholder="nombre"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <input
              className={inputClass}
              placeholder="C:\ruta\al\proyecto"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              required
            />
            <input
              className={inputClass}
              placeholder="descripcion (opcional)"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
            />
            <button
              type="submit"
              className="mt-3 w-full font-mono text-[11px] text-accent hover:text-text-primary py-2 border border-edge-strong rounded transition-colors disabled:opacity-30"
              disabled={createMutation.isPending}
            >
              crear
            </button>
          </form>
        )}

        {isLoading && (
          <p className="font-mono text-xs text-text-tertiary">cargando...</p>
        )}

        {/* Project detail view */}
        {selectedProjectId && activeProject ? (
          <div className="animate-fade-in">
            {/* Project header */}
            <div className="mb-4 pb-3 border-b border-edge">
              <div className="flex items-center justify-between mb-1">
                <p className="font-mono text-xs font-medium text-accent">
                  {activeProject.name}
                </p>
                <button
                  onClick={() => {
                    if (confirm(`Eliminar "${activeProject.name}"?`)) {
                      deleteMutation.mutate(activeProject.id);
                    }
                  }}
                  className="font-mono text-[10px] text-text-tertiary hover:text-err transition-colors"
                >
                  eliminar
                </button>
              </div>
              <p
                className="font-mono text-[10px] text-text-tertiary truncate"
                title={activeProject.path}
              >
                {activeProject.path}
              </p>
              {activeProject.description && (
                <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                  {activeProject.description}
                </p>
              )}
            </div>

            {/* Conversation history */}
            <div className="flex items-center justify-between mb-3">
              <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
                conversaciones
              </p>
              {conversations && conversations.length > 0 && (
                <button
                  onClick={() => {
                    newChat();
                  }}
                  className="font-mono text-[10px] text-text-secondary hover:text-accent transition-colors"
                >
                  + nuevo
                </button>
              )}
            </div>

            {conversations && conversations.length > 0 ? (
              <div className="space-y-1">
                {conversations.map((conv) => {
                  const isActive = conversationId === conv.conversationId;
                  return (
                    <div
                      key={conv.conversationId}
                      className={`group p-2 rounded-lg transition-colors cursor-pointer ${
                        isActive
                          ? "bg-accent-dim"
                          : "hover:bg-surface-2/50"
                      }`}
                      onClick={() => setConversation(conv.conversationId)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className={`font-mono text-[11px] truncate flex-1 ${
                          isActive ? "text-accent" : "text-text-primary"
                        }`}>
                          {conv.title}
                        </p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteConvMutation.mutate(conv.conversationId);
                            }}
                            className="font-mono text-[9px] text-transparent group-hover:text-text-tertiary hover:!text-err transition-colors"
                            title="eliminar conversacion"
                          >
                            ×
                          </button>
                          <StatusDot status={conv.status} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="font-mono text-[9px] text-text-tertiary">
                          {conv.adapter}
                        </span>
                        {conv.messageCount > 1 && (
                          <span className="font-mono text-[9px] text-text-tertiary">
                            {conv.messageCount} msgs
                          </span>
                        )}
                        <span className="font-mono text-[9px] text-text-tertiary ml-auto">
                          {formatDate(conv.updatedAt)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="font-mono text-[11px] text-text-tertiary">
                sin conversaciones
              </p>
            )}

            {/* Plans section */}
            {plans && plans.length > 0 && (
              <>
                <div className="flex items-center justify-between mt-5 mb-3">
                  <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary">
                    planes
                  </p>
                  <span className="font-mono text-[9px] text-text-tertiary">
                    {plans.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {plans.map((plan) => (
                    <div
                      key={plan.id}
                      className="group p-2 rounded-lg transition-colors cursor-pointer hover:bg-surface-2/50"
                      onClick={() => setActivePlanId(plan.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-[10px] text-text-tertiary shrink-0">◈</span>
                          <p className="font-mono text-[11px] truncate text-text-primary">
                            {plan.description.slice(0, 60)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePlanMutation.mutate(plan.id);
                            }}
                            className="font-mono text-[9px] text-transparent group-hover:text-text-tertiary hover:!text-err transition-colors"
                            title="eliminar plan"
                          >
                            ×
                          </button>
                          <PlanStatusBadge status={plan.status} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1 pl-5">
                        <span className="font-mono text-[9px] text-text-tertiary">
                          {formatDate(plan.updatedAt)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          /* Project list view */
          <>
            {projects?.length === 0 && !showForm && (
              <p className="font-mono text-xs text-text-tertiary leading-relaxed">
                sin proyectos
              </p>
            )}

            {projects?.map((p, i) => (
              <button
                key={p.id}
                onClick={() => setProject(p.id)}
                className={`w-full text-left mb-3 p-2.5 rounded-lg transition-all animate-fade-in cursor-pointer ${
                  p.id === selectedProjectId
                    ? "bg-accent-dim border border-accent/20"
                    : "hover:bg-surface-2/50 border border-transparent"
                }`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <p className="font-mono text-xs font-medium text-text-primary">
                  {p.name}
                </p>
                <p
                  className="font-mono text-[10px] text-text-tertiary truncate mt-0.5"
                  title={p.path}
                >
                  {p.path}
                </p>
                {p.description && (
                  <p className="text-[11px] text-text-secondary mt-1 leading-relaxed">
                    {p.description}
                  </p>
                )}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PlanStatusBadge({ status }: { status: string }) {
  const config: Record<string, { color: string; label: string }> = {
    generating: { color: "text-accent", label: "generando" },
    pending: { color: "text-text-tertiary", label: "pendiente" },
    running: { color: "text-accent", label: "ejecutando" },
    completed: { color: "text-ok", label: "completado" },
    failed: { color: "text-err", label: "fallido" },
    cancelled: { color: "text-text-tertiary", label: "cancelado" },
  };
  const c = config[status] ?? { color: "text-text-tertiary", label: status };
  return (
    <span className={`font-mono text-[9px] shrink-0 ${c.color}`}>
      {c.label}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded"
      ? "bg-ok"
      : status === "failed"
        ? "bg-err"
        : status === "running"
          ? "bg-accent animate-pulse-dot"
          : "bg-text-tertiary";
  return <div className={`h-1.5 w-1.5 rounded-full shrink-0 mt-1 ${color}`} />;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "ahora";
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d`;
  } catch {
    return "";
  }
}
