import { describe, it, expect } from "vitest";
import { buildPlannerArgs } from "../../src/server/planner.js";
import { CLAUDE_ISOLATION_ARGS } from "../../src/adapters/claude/execute.js";

describe("buildPlannerArgs", () => {
  it("el planner también corre aislado, con Opus y su system prompt en archivo", () => {
    const a = buildPlannerArgs("C:\\tmp\\sys.txt");
    for (const f of CLAUDE_ISOLATION_ARGS) expect(a).toContain(f);
    expect(a).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--system-prompt-file", "C:\\tmp\\sys.txt"]));
  });
});
