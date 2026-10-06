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
      ? "bg-amber-400"
      : "bg-ok";

  const isRealData = usage.source === "local_jsonl";

  return (
    <div className="pl-3.5 mt-2 space-y-1">
      <p className="font-mono text-[9px] uppercase tracking-widest text-text-tertiary">
        uso {isRealData ? "real" : "orquestador"} (5h)
      </p>

      {/* Progress bar */}
      <div className="h-1 w-full bg-surface-0 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.max(pct, pct > 0 ? 2 : 0)}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <span className={`font-mono text-[9px] ${isRateLimited ? "text-err" : "text-text-secondary"}`}>
          {pct}% usado
        </span>
        <span className="font-mono text-[9px] text-text-tertiary">
          {(usage.totalTokens / 1000).toFixed(1)}k tok
        </span>
      </div>

      {/* Window reset (like Claude.ai "Se restablece en") */}
      {showWindowReset && windowMsLeft !== null && !isRateLimited && (
        <p className="font-mono text-[9px] text-text-tertiary">
          restablece en {formatTimeLeft(windowMsLeft)}
        </p>
      )}

      {/* Hard rate-limit (separate from window reset) */}
      {isRateLimited && rateLimitMsLeft !== null && (
        <p className="font-mono text-[9px] text-err">
          rate-limit · espera {formatTimeLeft(rateLimitMsLeft)}
        </p>
      )}

      {usage.costUsd > 0 && (
        <p className="font-mono text-[9px] text-text-tertiary">
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
          className="font-mono text-[9px] text-text-tertiary hover:text-accent transition-colors"
        >
          + segunda cuenta
        </button>
      </div>
    );
  }

  return (
    <div className="pl-3.5 mt-2 space-y-1.5">
      <p className="font-mono text-[9px] uppercase tracking-widest text-text-tertiary mb-1.5">
        perfiles
      </p>
      {profiles.map((p) => {
        const limitLabel = p.rateLimitedUntil
          ? `rate-limit hasta ${new Date(p.rateLimitedUntil).toLocaleTimeString()}`
          : null;
        return (
          <div key={p.id} className="flex items-center gap-2">
            <div
              className={`h-1.5 w-1.5 rounded-full shrink-0 ${p.available ? "bg-ok" : "bg-err"}`}
            />
            <span className="font-mono text-[10px] text-text-secondary truncate flex-1" title={p.id}>
              {p.label}
            </span>
            {limitLabel && (
              <button
                onClick={() => clearMutation.mutate(p.id)}
                title={limitLabel}
                className="font-mono text-[9px] text-err hover:text-text-primary transition-colors"
              >
                rl
              </button>
            )}
            {profiles.length > 1 && (
              <button
                onClick={() => deleteMutation.mutate(p.id)}
                className="font-mono text-[9px] text-text-tertiary hover:text-err transition-colors"
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
            className="w-full bg-surface-0 border border-edge rounded px-2 py-1 font-mono text-[10px] text-text-primary focus:outline-none focus:border-accent"
            placeholder="profile id (ej: cuenta2)"
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            autoFocus
          />
          <input
            className="w-full bg-surface-0 border border-edge rounded px-2 py-1 font-mono text-[10px] text-text-primary focus:outline-none focus:border-accent"
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
              className="font-mono text-[9px] text-accent hover:text-text-primary disabled:opacity-30 transition-colors"
            >
              agregar
            </button>
            <button
              onClick={() => { setAdding(false); setNewId(""); setNewLabel(""); }}
              className="font-mono text-[9px] text-text-tertiary hover:text-text-secondary transition-colors"
            >
              cancelar
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="font-mono text-[9px] text-text-tertiary hover:text-accent transition-colors"
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
      <p className="font-mono text-[10px] uppercase tracking-widest text-text-tertiary mb-4">
        adapters
      </p>

      {isLoading && (
        <p className="font-mono text-xs text-text-tertiary">detectando...</p>
      )}

      {adapters &&
        Object.values(adapters).map((a, i) => {
          const isActiveAdapter = a.type === selectedAdapter;
          return (
            <div
              key={a.type}
              className={`mb-4 animate-fade-in rounded-lg transition-colors ${
                isActiveAdapter ? "bg-surface-2/50 -mx-2 px-2 py-2" : ""
              }`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div
                  className={`h-1.5 w-1.5 rounded-full ${a.available ? "bg-ok" : "bg-text-tertiary"}`}
                />
                <button
                  className={`font-mono text-xs font-medium transition-colors text-left ${
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
                    className="font-mono text-[10px] text-text-tertiary truncate mb-2 pl-3.5"
                    title={a.resolvedPath ?? undefined}
                  >
                    {a.resolvedPath}
                  </p>
                  <div className="flex flex-wrap gap-1 pl-3.5">
                    {a.models.map((m) => {
                      const isSelected = isActiveAdapter && m.id === activeModel;
                      return (
                        <button
                          key={m.id}
                          onClick={() => setAdapter(a.type, m.id)}
                          className={`font-mono text-[10px] px-1.5 py-0.5 rounded transition-all cursor-pointer ${
                            isSelected
                              ? "bg-accent text-surface-0 font-medium"
                              : isActiveAdapter && m.id === a.defaultModel && !selectedModel
                                ? "bg-accent-dim text-accent hover:bg-accent hover:text-surface-0"
                                : "text-text-tertiary hover:text-text-secondary hover:bg-surface-2"
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
                      <span className="font-mono text-[9px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 border border-amber-500/30">
                        [caveman:{cavemanStatus.mode}]
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <p className="font-mono text-[10px] text-text-tertiary pl-3.5">
                  no encontrado
                </p>
              )}
            </div>
          );
        })}
    </div>
  );
}
