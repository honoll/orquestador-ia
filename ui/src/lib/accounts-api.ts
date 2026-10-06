export interface WindowUsage {
  windowHours: number;
  usedTokens: number;
  limitTokens: number | null;
  limitSource: "manual" | "calibrated" | null;
  pct: number | null;
  resetsAt: number | null;
}

export interface AccountView {
  id: string;
  label: string;
  active: boolean;
  manualLimit5h: number | null;
  manualLimit7d: number | null;
  calibratedLimit5h: number | null;
  quotaBlockedUntil: string | null;
  notes: string | null;
  usage: { short: WindowUsage; long: WindowUsage };
  warn: { warn: boolean; reason: string | null };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const accountsApi = {
  list: () => fetch("/api/accounts").then((r) => json<AccountView[]>(r)),
  active: () => fetch("/api/accounts/active").then((r) => json<{ account: AccountView | null }>(r)),
  create: (label: string) =>
    fetch("/api/accounts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label }) }).then((r) => json<AccountView>(r)),
  activate: (id: string) => fetch(`/api/accounts/${id}/activate`, { method: "POST" }).then((r) => json<void>(r)),
  update: (id: string, patch: Partial<Pick<AccountView, "label" | "manualLimit5h" | "manualLimit7d" | "notes">>) =>
    fetch(`/api/accounts/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).then((r) => json<AccountView>(r)),
  remove: (id: string) => fetch(`/api/accounts/${id}`, { method: "DELETE" }).then((r) => json<void>(r)),
  openSwitchTerminal: () => fetch("/api/accounts/switch-terminal", { method: "POST" }).then((r) => json<{ ok: true }>(r)),
  session: () => fetch("/api/usage/session").then((r) => json<{ since: string; tokens: number }>(r)),
};
