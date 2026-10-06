import { describe, it, expect } from "vitest";
import { stepLevels } from "../../ui/src/lib/plan-levels.js";

const s = (stepKey: string | null, stepIndex: number, deps: string[] | null = []) => ({ stepKey, stepIndex, dependsOn: deps === null ? null : JSON.stringify(deps) });

describe("stepLevels", () => {
  it("agrupa pasos paralelos en el mismo nivel", () => {
    const lv = stepLevels([s("s1", 0), s("s2", 1), s("s3", 2, ["s1", "s2"]), s("s4", 3, ["s3"])]);
    expect(lv.map((l) => l.map((x) => x.stepKey))).toEqual([["s1", "s2"], ["s3"], ["s4"]]);
  });
  it("plan viejo sin claves = un paso por nivel", () => {
    const lv = stepLevels([s(null, 1, null), s(null, 0, null)]);
    expect(lv.map((l) => l.map((x) => x.stepIndex))).toEqual([[0], [1]]);
  });
  it("ignora dependencias desconocidas", () => {
    expect(stepLevels([s("s1", 0, ["zz"])]).length).toBe(1);
  });
});
