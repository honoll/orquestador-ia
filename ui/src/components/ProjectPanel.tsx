import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAppState } from "../context/AppStateContext";
import { statusStyle } from "../lib/pixel";

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
  pauseReason?: string | null;
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

  // Sin proyecto seleccionado: las pláticas que no pertenecen a ninguno (p. ej. las del asistente de voz).
  const { data: looseConversations } = useQuery({
    queryKey: ["conversations", "none"],
    queryFn: () => fetchConversations("none"),
    enabled: !selectedProjectId,
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
    "px-input mb-2 w-full text-xs";

  return (
    <div className="flex flex-col h-full">
      <header className="flex flex-wrap items-center justify-between gap-2 px-5 py-4">
        <span className="font-pixel text-[12px] uppercase text-text-primary">
          proyectos
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {selectedProjectId && (
            <button
              onClick={() => setProject(null)}
              className="px-btn whitespace-nowrap"
              title="ver todos"
            >
              ← todos
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-btn whitespace-nowrap"
          >
            {showForm ? "cancelar" : "+ nuevo"}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title="Ocultar proyectos"
              className="px-btn whitespace-nowrap"
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
              className={`${inputClass} font-mono`}
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
              className="px-btn px-btn-pri mt-1 w-full"
              disabled={createMutation.isPending}
            >
              crear
            </button>
          </form>
        )}

        {isLoading && (
          <p className="text-text-tertiary">cargando...</p>
        )}

        {/* Project detail view */}
        {selectedProjectId && activeProject ? (
          <div className="animate-fade-in">
            {/* Project header */}
            <div className="px-panel mb-4 border-accent! bg-[#1b1638]! px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
                <p className="min-w-0 break-words text-white">
                  {activeProject.name}
                </p>
                <button
                  onClick={() => {
                    if (confirm(`Eliminar "${activeProject.name}"?`)) {
                      deleteMutation.mutate(activeProject.id);
                    }
                  }}
                  className="px-btn whitespace-nowrap hover:text-err"
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
                <p className="text-xs text-text-secondary mt-1">
                  {activeProject.description}
                </p>
              )}
            </div>

            {/* Conversation history */}
            <div className="flex flex-wrap items-center justify-between gap-1 mb-3">
              <p className="font-pixel text-[11px] uppercase text-text-tertiary">
                conversaciones
              </p>
              {conversations && conversations.length > 0 && (
                <button
                  onClick={() => {
                    newChat();
                  }}
                  className="px-btn whitespace-nowrap"
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
                      className={`group cursor-pointer border-[3px] px-2 py-1 ${
                        isActive
                          ? "border-accent bg-[#1b1638] shadow-[3px_3px_0_#000]"
                          : "border-transparent hover:bg-surface-2/50"
                      }`}
                      onClick={() => setConversation(conv.conversationId)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className={`truncate flex-1 ${
                          isActive ? "text-white" : "text-text-primary"
                        }`}>
                          {conv.title}
                        </p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteConvMutation.mutate(conv.conversationId);
                            }}
                            className="text-transparent group-hover:text-text-tertiary hover:!text-err"
                            title="eliminar conversacion"
                          >
                            ×
                          </button>
                          <StatusDot status={conv.status} />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-text-tertiary">
                          {conv.adapter}
                        </span>
                        {conv.messageCount > 1 && (
                          <span className="text-xs text-text-tertiary">
                            {conv.messageCount} msgs
                          </span>
                        )}
                        <span className="text-xs text-text-tertiary ml-auto">
                          {formatDate(conv.updatedAt)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-text-tertiary">
                sin conversaciones
              </p>
            )}

            {/* Plans section */}
            {plans && plans.length > 0 && (
              <>
                <div className="flex items-center justify-between mt-5 mb-3">
                  <p className="font-pixel text-[11px] uppercase text-text-tertiary">
                    planes
                  </p>
                  <span className="text-xs text-text-tertiary">
                    {plans.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {plans.map((plan) => (
                    <div
                      key={plan.id}
                      className="group cursor-pointer border-[3px] border-transparent px-2 py-1 hover:bg-surface-2/50"
                      onClick={() => setActivePlanId(plan.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="truncate text-text-primary">
                            {plan.description.slice(0, 60)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              deletePlanMutation.mutate(plan.id);
                            }}
                            className="text-transparent group-hover:text-text-tertiary hover:!text-err"
                            title="eliminar plan"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      {/* El estado va en la fila de la fecha: en columnas angostas dejaba el título en "Haz …". */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-text-tertiary">
                          {formatDate(plan.updatedAt)}
                        </span>
                        <PlanStatusBadge status={plan.status} paused={!!plan.pauseReason} />
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
              <p className="text-text-tertiary">
                sin proyectos
              </p>
            )}

            {projects?.map((p, i) => (
              <button
                key={p.id}
                onClick={() => setProject(p.id)}
                className={`w-full text-left mb-2 px-2 py-1 animate-fade-in cursor-pointer border-[3px] ${
                  p.id === selectedProjectId
                    ? "border-accent bg-[#1b1638] shadow-[3px_3px_0_#000]"
                    : "border-transparent hover:bg-surface-2/50"
                }`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <p className="text-text-primary">
                  {p.name}
                </p>
                <p
                  className="font-mono text-[10px] text-text-tertiary truncate mt-0.5"
                  title={p.path}
                >
                  {p.path}
                </p>
                {p.description && (
                  <p className="text-xs text-text-secondary mt-1">
                    {p.description}
                  </p>
                )}
              </button>
            ))}

            {looseConversations && looseConversations.length > 0 && (
              <div className="mt-5">
                <p className="mb-3 font-pixel text-[11px] uppercase text-text-tertiary">
                  Pláticas sin proyecto
                </p>
                <div className="space-y-1">
                  {looseConversations.map((conv) => {
                    const isActive = conversationId === conv.conversationId;
                    return (
                      <button
                        key={conv.conversationId}
                        type="button"
                        onClick={() => setConversation(conv.conversationId)}
                        className={`w-full border-[3px] px-2 py-1 text-left ${
                          isActive ? "border-accent bg-[#1b1638] shadow-[3px_3px_0_#000]" : "border-transparent hover:bg-surface-2/50"
                        }`}
                      >
                        <p className={`truncate ${isActive ? "text-white" : "text-text-primary"}`}>
                          {conv.title}
                        </p>
                        <p className="text-xs text-text-tertiary">{formatDate(conv.updatedAt)}</p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function PlanStatusBadge({ status, paused }: { status: string; paused?: boolean }) {
  const c = status === "generating" ? { icon: "…", color: "var(--color-accent)", label: "generando" } : statusStyle(status, paused);
  return (
    <span className="text-xs shrink-0" style={{ color: c.color }}>
      <span aria-hidden="true">{c.icon} </span>{c.label}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const s = statusStyle(status);
  return <span className="shrink-0" style={{ color: s.color }} title={s.label}><span aria-hidden="true">{s.icon}</span><span className="sr-only">{s.label}</span></span>;
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
