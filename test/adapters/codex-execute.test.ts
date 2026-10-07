import { describe, it, expect } from "vitest";
import { buildCodexArgs } from "../../src/adapters/codex/execute.js";

describe("codex execute: args", () => {
  it("por defecto escribe (--full-auto) y lee el prompt de stdin", () => {
    expect(buildCodexArgs("gpt-x")).toEqual(["exec", "--json", "--full-auto", "--skip-git-repo-check", "-m", "gpt-x", "-"]);
  });
  it("readOnly usa --sandbox read-only en lugar de --full-auto", () => {
    const a = buildCodexArgs(undefined, { readOnly: true });
    expect(a).not.toContain("--full-auto");
    expect(a).toEqual(["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
  });
});
