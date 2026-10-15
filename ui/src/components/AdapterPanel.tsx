import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppState } from "../context/AppStateContext";

interface AdapterInfo {
  type: string;
  label: string;
  command: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  available: boolean;
  resolvedPath: string | null;
}

interface ProfileStatus {
  id: string;
  label: string;
  rateLimitedUntil: string | null;
  available: boolean;
}

async function fetchAdapters(): Promise<Record<string, AdapterInfo>> {
  const res = await fetch("/api/adapters");
  return res.json();
}

async function fetchProfiles(): Promise<ProfileStatus[]> {
  const res = await fetch("/api/claude-profiles");
  return res.json();
}

async function fetchCavemanStatus(): Promise<{ active: boolean; mode: string }> {
  const res = await fetch("/api/caveman/status");
  return res.json();
}

interface UsageSummary {
  adapter: string;
  windowHours: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalTokens: number;
  costUsd: number;
  runCount: number | null;
  rateLimitResetsAt: string | null;  // hard rate-limit (retry_not_before)
  windowResetsAt?: string | null;    // rolling window expiry (oldest msg + 5h)
  source?: "local_jsonl" | "orchestrator_db";
}

async function fetchUsage(adapter: string): Promise<UsageSummary> {
  const res = await fetch(`/api/usage/summary?adapter=${adapter}&windowHours=5`);
  return res.json();
}

/** Format milliseconds remaining as "Xh Ymin" or "Ymin Zs" */
function formatTimeLeft(ms: number): string {
  if (ms <= 0) return "ahora";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min ${s}s`;
  return `${s}s`;
}

/** Token budgets per 5h rolling window (input+output, excluding cache).
 *  Claude Pro: ~1.23M derived empirically (490.8k = 40% on Pro plan). */
const TOKEN_BUDGETS: Record<string, number> = {
  claude: 1_230_000,
  codex:  300_000,
};

function AdapterUsage({ adapter }: { adapter: string }) {
  const budget = TOKEN_BUDGETS[adapter] ?? 100_000;

  const { data: usage } = useQuery({
    queryKey: ["usage", adapter],
    queryFn: () => fetchUsage(adapter),
    refetchInterval: 15_000,
  });

  // Countdown ticker for reset time
  const [, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { if (tickRef.current) clearInterval(tickRef.current); };
  }, []);

  if (!usage) return null;

  const pct = Math.min(100, Math.round((usage.totalTokens / budget) * 100));

  // Hard rate-limit active (retry_not_before from a failed run)
  const rateLimitResetsAt = usage.rateLimitResetsAt ? new Date(usage.rateLimitResetsAt) : null;
  const rateLimitMsLeft = rateLimitResetsAt ? rateLimitResetsAt.getTime() - Date.now() : null;
  const isRateLimited = rateLimitMsLeft !== null && rateLimitMsLeft > 0;

  // Rolling window reset (when oldest token expires)
  const windowResetsAt = usage.windowResetsAt ? new Date(usage.windowResetsAt) : null;
  const windowMsLeft = windowResetsAt ? windowResetsAt.getTime() - Date.now() : null;
  const showWindowReset = windowMsLeft !== null && windowMsLeft > 0;

  const barColor = isRateLimited
    ? "bg-err"
    : pct >= 80
      ? "bg-warn"
      : "bg-ok";

  const isRealData = usage.source === "local_jsonl";

  return (
    <div className="pl-3.5 mt-2 space-y-1 text-xs">
      <p className="font-pixel text-[10px] uppercase text-text-tertiary">
        uso {isRealData ? "real" : "orquestador"} (5h)
      </p>

      {/* Progress bar */}
      <div className="h-2.5 w-full border-2 border-edge-strong bg-black">
        <div
          className={`h-full ${barColor}`}
          style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className={isRateLimited ? "text-err" : "text-text-secondary"}>
          {pct}% usado
        </span>
        <span className="text-text-tertiary">
          {(usage.totalTokens / 1000).toFixed(1)}k tok
        </span>
      </div>

      {/* Window reset (like Claude.ai "Se restablece en") */}
      {showWindowReset && windowMsLeft !== null && !isRateLimited && (
        <p className="text-text-tertiary">
          restablece en {formatTimeLeft(windowMsLeft)}
        </p>
      )}

      {/* Hard rate-limit (separate from window reset) */}
      {isRateLimited && rateLimitMsLeft !== null && (
        <p className="text-err">
          rate-limit · espera {formatTimeLeft(rateLimitMsLeft)}
        </p>
      )}

      {usage.costUsd > 0 && (
        <p className="text-text-tertiary">
          ${usage.costUsd.toFixed(4)} USD
        </p>
      )}
    </div>
  );
}

function ClaudeProfiles() {
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

export function AdapterPanel() {
  const { selectedAdapter, selectedModel, setAdapter } = useAppState();

  const { data: adapters, isLoading } = useQuery({
    queryKey: ["adapters"],
    queryFn: fetchAdapters,
    refetchInterval: 30_000,
  });

  const { data: cavemanStatus } = useQuery({
    queryKey: ["caveman-status"],
    queryFn: fetchCavemanStatus,
    refetchInterval: 5_000,
  });

  const currentAdapter = adapters?.[selectedAdapter];
  const activeModel = selectedModel || currentAdapter?.defaultModel || "";

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-5">
      <p className="font-pixel text-[12px] uppercase text-text-primary mb-3">
        adapters
      </p>

      {isLoading && (
        <p className="text-text-tertiary">detectando...</p>
      )}

      {adapters &&
        Object.values(adapters).map((a, i) => {
          const isActiveAdapter = a.type === selectedAdapter;
          return (
            <div
              key={a.type}
              className={`mb-4 animate-fade-in ${
                isActiveAdapter ? "bg-surface-2/50 -mx-2 px-2 py-2" : ""
              }`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div
                  className={`h-2 w-2 ${a.available ? "bg-ok" : "bg-text-tertiary"}`}
                />
                <button
                  className={`font-pixel text-[12px] uppercase text-left ${
                    isActiveAdapter
                      ? "text-accent"
                      : a.available
                        ? "text-text-primary hover:text-accent cursor-pointer"
                        : "text-text-tertiary cursor-default"
                  }`}
                  disabled={!a.available}
                  onClick={() => {
                    if (a.available) setAdapter(a.type, a.defaultModel);
                  }}
                >
                  {a.command}
                </button>
              </div>

              {a.available ? (
                <>
                  <p
                    className="font-code text-text-tertiary truncate mb-2 pl-3.5"
                    title={a.resolvedPath ?? undefined}
                  >
                    {a.resolvedPath}
                  </p>
                  <div className="flex flex-col items-stretch gap-0.5 pl-3.5">
                    {a.models.map((m) => {
                      const isSelected = isActiveAdapter && m.id === activeModel;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setAdapter(a.type, m.id)}
                          className={`border-[3px] px-2 text-left cursor-pointer ${
                            isSelected
                              ? "border-accent bg-[#1b1638] text-white shadow-[3px_3px_0_#000]"
                              : isActiveAdapter && m.id === a.defaultModel && !selectedModel
                                ? "border-accent/50 bg-accent-dim text-accent hover:text-white"
                                : "border-transparent text-text-secondary hover:text-text-primary hover:bg-surface-2"
                          }`}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                  {a.type === "claude" && <ClaudeProfiles />}
                  {a.type !== "agy" && <AdapterUsage adapter={a.type} />}
                  {isActiveAdapter && cavemanStatus?.active && (
                    <div className="pl-3.5 mt-1">
                      <span className="px-tag text-warn">
                        [caveman:{cavemanStatus.mode}]
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-text-tertiary pl-3.5">
                  no encontrado
                </p>
              )}
            </div>
          );
        })}
    </div>
  );
}
