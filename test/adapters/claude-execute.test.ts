import { describe, it, expect } from "vitest";
import { buildClaudeArgs, CLAUDE_ISOLATION_ARGS, READ_ONLY_DISALLOWED_TOOLS } from "../../src/adapters/claude/execute.js";

describe("buildClaudeArgs", () => {
  it("escritor: aislado + salta permisos", () => {
    expect(buildClaudeArgs("claude-opus-5-5")).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose",
      ...CLAUDE_ISOLATION_ARGS,
      "--dangerously-skip-permissions", "--model", "claude-opus-5-5",
    ]);
  });
  it("readOnly: aislado + tools prohibidas, sin saltar permisos ni repetir --strict-mcp-config", () => {
    const a = buildClaudeArgs(undefined, undefined, { readOnly: true });
    expect(a).toEqual([
      "--print", "-", "--output-format", "stream-json", "--verbose",
      ...CLAUDE_ISOLATION_ARGS,
      "--disallowedTools", READ_ONLY_DISALLOWED_TOOLS,
    ]);
    expect(a.filter((x) => x === "--strict-mcp-config")).toHaveLength(1);
  });
  it("aislamiento exacto", () => {
    expect(CLAUDE_ISOLATION_ARGS).toEqual(["--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands"]);
  });
  it("agrega --resume con sesión", () => {
    expect(buildClaudeArgs(undefined, "abc")).toContain("--resume");
  });
});
