import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

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

export function AdapterUsage({ adapter }: { adapter: string }) {
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
