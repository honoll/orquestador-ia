import { describe, it, expect } from "vitest";
import { buildClaudeArgs } from "../../src/adapters/claude/execute.js";

describe("buildClaudeArgs", () => {
  it("por defecto salta permisos (headless)", () => {
    expect(buildClaudeArgs("claude-opus-5-5")).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--model", "claude-opus-5-5",
    ]);
  });
  it("readOnly omite --dangerously-skip-permissions, niega las tools que escriben o salen a la red y no carga MCP", () => {
    const args = buildClaudeArgs("claude-opus-5-5", undefined, { readOnly: true });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose",
      "--disallowedTools", "Bash Edit Write NotebookEdit WebFetch WebSearch", "--strict-mcp-config",
      "--model", "claude-opus-5-5",
    ]);
  });
  it("sin readOnly no niega tools ni toca MCP", () => {
    const args = buildClaudeArgs();
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--strict-mcp-config");
  });
  it("agrega --resume con sesión", () => {
    expect(buildClaudeArgs(undefined, "abc")).toContain("--resume");
  });
});
