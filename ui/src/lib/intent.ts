export type Intent = { open: "platicar" } | { open: "plan"; planId: string };

const PLAN_ID = /^[A-Za-z0-9-]{1,64}$/;

/** `?platicar=1` o `?plan=<id>` (lanzadores externos) → intención de la UI. */
export function parseIntentFromSearch(search: string): Intent | null {
  const p = new URLSearchParams(search);
  if (p.get("platicar") === "1") return { open: "platicar" };
  const planId = p.get("plan");
  if (planId && PLAN_ID.test(planId)) return { open: "plan", planId };
  return null;
}

/** Devuelve ruta+query+hash sin los parámetros de intent. */
export function stripIntentParams(url: string): string {
  const u = new URL(url, "http://localhost");
  u.searchParams.delete("platicar");
  u.searchParams.delete("plan");
  return u.pathname + u.search + u.hash;
}
