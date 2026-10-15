import { describe, it, expect } from "vitest";
import { ROLES, shade, spriteFrame, deskLabel, eventToLog, type AgentId } from "../../ui/src/lib/office.js";

const ACC: Record<AgentId, string> = { jefe: "#b91c1c", guardia: "#1e3a8a", agy: "#fde047", codex: "#e4e4e7", claude: "#fda4af", biblio: "#7c3aed", recepcion: "#52525b" };
const ids = Object.keys(ROLES) as AgentId[];

describe("spriteFrame", () => {
  it.each(ids)("%s incluye su accesorio", (id) => {
    expect(spriteFrame(id, true, 0).some((r) => r[4] === ACC[id])).toBe(true);
  });
  it("en reposo no hay texto en el monitor y los ojos están cerrados", () => {
    const f = spriteFrame("agy", false, 1);
    expect(f.some((r) => r[4] === shade(ROLES.agy.color, 1.2))).toBe(false);
    expect(f.some((r) => r[4] === "#fff")).toBe(false);
    expect(f.some((r) => r[4] === "#d4d4d8")).toBe(true);
  });
  it("trabajando hay texto y ojos abiertos", () => {
    const f = spriteFrame("agy", true, 1);
    expect(f.some((r) => r[4] === shade(ROLES.agy.color, 1.2))).toBe(true);
    expect(f.some((r) => r[4] === "#fff")).toBe(true);
  });
});

describe("shade", () => {
  it("límites", () => {
    expect(shade("#808080", 1)).toBe("rgb(128,128,128)");
    expect(shade("#ffffff", 0)).toBe("rgb(0,0,0)");
    expect(shade("#000000", 2)).toBe("rgb(255,255,255)");
    expect(shade("#ff0000", 5)).toBe("rgb(255,255,255)");
  });
});

describe("deskLabel", () => {
  it("agrega ×n solo con más de un escritorio", () => {
    expect(deskLabel("AGY", 2)).toBe("AGY ×2");
    expect(deskLabel("AGY", 1)).toBe("AGY");
  });
});

describe("eventToLog", () => {
  const now = new Date(2026, 9, 15, 9, 5);
  it("mapea eventos", () => {
    expect(eventToLog({ type: "plan:ready" }, now)).toMatchObject({ time: "09:05", agent: "jefe", text: "plan listo" });
    expect(eventToLog({ type: "plan:synthesis", status: "succeeded" }, now)?.agent).toBe("jefe");
    expect(eventToLog({ type: "plan:synthesis", status: "running" }, now)).toBeNull();
    expect(eventToLog({ type: "plan:tier", tier: "normal" }, now)).toMatchObject({ agent: "guardia", text: "tier normal" });
    expect(eventToLog({ type: "plan:guard" }, now)?.text).toBe("pausó un paso");
    expect(eventToLog({ type: "plan:step", status: "running", adapter: "codex" }, now)).toMatchObject({ agent: "codex", color: ROLES.codex.color });
    expect(eventToLog({ type: "plan:step", status: "running" }, now)).toBeNull();
    expect(eventToLog({ type: "plan:step", status: "pending", adapter: "agy" }, now)).toBeNull();
    expect(eventToLog({ type: "plan:memory", source: "semantic" }, now)?.agent).toBe("biblio");
    expect(eventToLog({ type: "memory:indexed" }, now)?.agent).toBe("biblio");
    expect(eventToLog({ type: "voice:assistant:turn-done" }, now)?.agent).toBe("recepcion");
    expect(eventToLog({ type: "plan:done", status: "completed" }, now)?.text).toBe("plan completed");
    expect(eventToLog({ type: "otro" }, now)).toBeNull();
  });
});
