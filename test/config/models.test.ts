import { describe, it, expect } from "vitest";
import { MODEL_CATALOG, PLANNER_MODEL, ROUTABLE_ADAPTERS } from "../../src/config/models.js";
import { adapters } from "../../src/adapters/registry.js";

describe("catálogo de modelos", () => {
  it("el planner es Opus 5.5 y está en el catálogo de claude", () => {
    expect(PLANNER_MODEL).toBe("claude-opus-5-5");
    expect(MODEL_CATALOG.claude.models.map((m) => m.id)).toContain(PLANNER_MODEL);
  });

  it("cada default está en su propia lista y no hay ids repetidos", () => {
    for (const [type, cat] of Object.entries(MODEL_CATALOG)) {
      const ids = cat.models.map((m) => m.id);
      expect(ids, type).toContain(cat.defaultModel);
      expect(new Set(ids).size, type).toBe(ids.length);
    }
  });

  it("los adapters leen del catálogo", () => {
    for (const type of Object.keys(MODEL_CATALOG) as (keyof typeof MODEL_CATALOG)[]) {
      expect(adapters[type].meta.models).toBe(MODEL_CATALOG[type].models);
      expect(adapters[type].meta.defaultModel).toBe(MODEL_CATALOG[type].defaultModel);
    }
  });

  it("no quedan modelos retirados", () => {
    const all = Object.values(MODEL_CATALOG).flatMap((c) => c.models.map((m) => m.id));
    for (const old of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-6", "claude-sonnet-4-5-20250929", "o3", "gpt-5.4"]) {
      expect(all).not.toContain(old);
    }
  });

  it("gemini CLI está retirado y agy es ruteable", () => {
    expect(Object.keys(MODEL_CATALOG)).not.toContain("gemini");
    expect(ROUTABLE_ADAPTERS).toEqual(["claude", "codex", "agy"]);
  });
});
