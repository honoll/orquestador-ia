import { describe, it, expect } from "vitest";
import { buildPlannerArgs } from "../../src/server/planner.js";
import { CLAUDE_ISOLATION_ARGS, READ_ONLY_DISALLOWED_TOOLS } from "../../src/adapters/claude/execute.js";
import { quoteWindowsArg } from "../../src/lib/process-runner.js";

describe("buildPlannerArgs", () => {
  it("el planner también corre aislado, con Opus y su system prompt en archivo", () => {
    const a = buildPlannerArgs("C:/tmp/sys.txt");
    for (const f of CLAUDE_ISOLATION_ARGS) expect(a).toContain(f);
    expect(a).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--system-prompt-file", "C:/tmp/sys.txt"]));
  });

  it("el planner corre sin herramientas: sin --dangerously-skip-permissions y con --disallowedTools", () => {
    const a = buildPlannerArgs("C:/tmp/sys.txt");
    expect(a).not.toContain("--dangerously-skip-permissions");
    const i = a.indexOf("--disallowedTools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(a[i + 1]).toBe(READ_ONLY_DISALLOWED_TOOLS);
  });

  it("args exactos: --tools \"\" apaga todas las herramientas (también Read/Glob/Grep)", () => {
    expect(buildPlannerArgs("C:/tmp/sys.txt")).toEqual([
      "--print", "-",
      "--output-format", "stream-json",
      "--verbose",
      ...CLAUDE_ISOLATION_ARGS,
      "--tools", "",
      "--disallowedTools", READ_ONLY_DISALLOWED_TOOLS,
      "--model", "claude-opus-5-5",
      "--system-prompt-file", "C:/tmp/sys.txt",
    ]);
    expect(quoteWindowsArg("")).toBe('""');
  });
});
