import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ collect: vi.fn() }));
vi.mock("../../src/server/office-state.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/server/office-state.js")>("../../src/server/office-state.js");
  return { ...actual, collectOfficeInput: h.collect };
});

const { default: officeRoute } = await import("../../src/server/routes/office.js");

describe("GET /state", () => {
  it("200 con OfficeState", async () => {
    h.collect.mockResolvedValueOnce({
      now: 5, generatingPlans: [], synthesisRunning: [], steps: [], chatRuns: [], tokensByAdapter: {},
      lastTierOrGuardAt: null, guardPausedCount: 0, memoryIndexing: false, lastMemoryLoadingAt: null, memoryNotes: 1,
      voiceActive: false, whisperState: "stopped", recentPlans: [],
    });
    const res = await officeRoute.request("/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[]; queue: unknown[]; plans: unknown[] };
    expect(body.agents).toHaveLength(7);
    expect(body.queue).toEqual([]);
  });
  it("500 { error } si falla la recolección", async () => {
    h.collect.mockRejectedValueOnce(new Error("boom"));
    const res = await officeRoute.request("/state");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });
});
