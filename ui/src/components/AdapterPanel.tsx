import { useQuery } from "@tanstack/react-query";
import { useAppState } from "../context/AppStateContext";
import { AdapterUsage } from "./AdapterUsage";
import { ClaudeProfiles } from "./ClaudeProfiles";

interface AdapterInfo {
  type: string;
  label: string;
  command: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  available: boolean;
  resolvedPath: string | null;
}

async function fetchAdapters(): Promise<Record<string, AdapterInfo>> {
  const res = await fetch("/api/adapters");
  return res.json();
}


async function fetchCavemanStatus(): Promise<{ active: boolean; mode: string }> {
  const res = await fetch("/api/caveman/status");
  return res.json();
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
