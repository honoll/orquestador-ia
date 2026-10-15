// Espejo de src/server/office-state.ts (la UI no importa código del servidor).
// En un .ts (no en OfficeView.tsx) para que las pruebas de lógica pura y el tsc de la raíz (sin jsx) lo importen.
export interface AgentState { id: import("./office").AgentId; working: boolean; desks: number; activity: string; model: string; tokens: number; paused?: boolean; seats?: AgySeat[] }
export interface AgySeat {
  local: boolean; account: string; pool: string | null; working: boolean; activity: string; model: string | null; role: string | null;
  planId: string | null; stepKey: string | null; progress: { done: number; total: number } | null;
}
export interface QueueItem { planId: string; stepId: string; stepKey: string | null; description: string; adapter: string; status: "running" | "pending" | "paused"; project: string | null }
export interface PlanSummary { id: string; description: string; status: string; pauseReason: string | null; updatedAt: string }
export interface OfficeState { agents: AgentState[]; queue: QueueItem[]; plans: PlanSummary[]; generatedAt: string }
