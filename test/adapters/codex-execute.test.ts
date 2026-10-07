import { describe, it, expect } from "vitest";
import { buildCodexArgs, CODEX_DISABLED_FEATURES } from "../../src/adapters/codex/execute.js";

describe("buildCodexArgs", () => {
  const iso = ["--ignore-user-config", ...CODEX_DISABLED_FEATURES.flatMap((f) => ["--disable", f])];
  it("lista exacta de funciones apagadas", () => {
    expect(CODEX_DISABLED_FEATURES).toEqual(["plugins", "apps", "hooks", "browser_use", "computer_use", "image_generation", "skill_search", "multi_agent", "goals", "tool_suggest", "personality"]);
  });
  it("escritor: --full-auto + aislamiento + modelo + stdin", () => {
    expect(buildCodexArgs("gpt-5.5")).toEqual(["exec", "--json", "--full-auto", "--skip-git-repo-check", ...iso, "-m", "gpt-5.5", "-"]);
  });
  it("readOnly: sandbox de solo lectura + aislamiento", () => {
    expect(buildCodexArgs(undefined, { readOnly: true })).toEqual(["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", ...iso, "-"]);
  });
});
