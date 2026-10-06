import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "../../src/adapters/claude/execute.js";

describe("buildClaudeArgs", () => {
  it("por defecto salta permisos (headless)", () => {
    expect(buildClaudeArgs("claude-opus-5-5")).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", "claude-opus-5-5",
    ]);
  });
  it("readOnly omite --dangerously-skip-permissions", () => {
    expect(buildClaudeArgs(undefined, undefined, { readOnly: true })).not.toContain("--dangerously-skip-permissions");
  });
  it("agrega --resume con sesión", () => {
    expect(buildClaudeArgs(undefined, "abc")).toContain("--resume");
  });
});
