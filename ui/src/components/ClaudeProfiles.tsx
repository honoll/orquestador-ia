import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface ProfileStatus {
  id: string;
  label: string;
  rateLimitedUntil: string | null;
  available: boolean;
}

async function fetchProfiles(): Promise<ProfileStatus[]> {
  const res = await fetch("/api/claude-profiles");
  return res.json();
}

export function ClaudeProfiles() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");

  const { data: profiles = [] } = useQuery({
    queryKey: ["claude-profiles"],
    queryFn: fetchProfiles,
    refetchInterval: 10_000,
  });

  const addMutation = useMutation({
    mutationFn: (body: { id: string; label: string }) =>
      fetch("/api/claude-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["claude-profiles"] });
      setAdding(false);
      setNewId("");
      setNewLabel("");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/claude-profiles/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["claude-profiles"] }),
  });

  const clearMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/claude-profiles/${encodeURIComponent(id)}/clear-limit`, { method: "POST" }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["claude-profiles"] }),
  });

  if (profiles.length <= 1 && !adding) {
    return (
      <div className="pl-3.5 mt-1">
        <button
          onClick={() => setAdding(true)}
          className="text-xs text-text-tertiary hover:text-accent"
        >
          + segunda cuenta
        </button>
      </div>
    );
  }

  return (
    <div className="pl-3.5 mt-2 space-y-1.5">
      <p className="font-pixel text-[10px] uppercase text-text-tertiary mb-1.5">
        perfiles
      </p>
      {profiles.map((p) => {
        const limitLabel = p.rateLimitedUntil
          ? `rate-limit hasta ${new Date(p.rateLimitedUntil).toLocaleTimeString()}`
          : null;
        return (
          <div key={p.id} className="flex items-center gap-2">
            <div
              className={`h-2 w-2 shrink-0 ${p.available ? "bg-ok" : "bg-err"}`}
            />
            <span className="text-xs text-text-secondary truncate flex-1" title={p.id}>
              {p.label}
            </span>
            {limitLabel && (
              <button
                onClick={() => clearMutation.mutate(p.id)}
                title={limitLabel}
                className="text-xs text-err hover:text-text-primary"
              >
                rl
              </button>
            )}
            {profiles.length > 1 && (
              <button
                onClick={() => deleteMutation.mutate(p.id)}
                className="text-xs text-text-tertiary hover:text-err"
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {adding ? (
        <div className="space-y-1 pt-1">
          <input
            className="px-input w-full text-xs"
            placeholder="profile id (ej: cuenta2)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            autoFocus
          />
          <input
            className="px-input w-full text-xs"
            placeholder="nombre (ej: Claude Pro 2)"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newId.trim()) {
                addMutation.mutate({ id: newId.trim(), label: newLabel.trim() || newId.trim() });
              }
              if (e.key === "Escape") { setAdding(false); setNewId(""); setNewLabel(""); }
            }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => addMutation.mutate({ id: newId.trim(), label: newLabel.trim() || newId.trim() })}
              disabled={!newId.trim()}
              className="px-btn px-btn-pri"
            >
              agregar
            </button>
            <button
              onClick={() => { setAdding(false); setNewId(""); setNewLabel(""); }}
              className="px-btn"
            >
              cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="px-btn"
        >
          + agregar perfil
        </button>
      )}
    </div>
  );
}
