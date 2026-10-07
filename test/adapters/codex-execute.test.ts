import { describe, it, expect, vi, beforeEach } from "vitest";
import { MODEL_CATALOG } from "../../src/config/models.js";

const h = vi.hoisted(() => ({ run: vi.fn(), env: vi.fn() }));
vi.mock("../../src/lib/process-runner.js", () => ({ runProcess: h.run }));
vi.mock("../../src/lib/worker-profile.js", () => ({ codexProfile: { envForWorker: h.env } }));
const { buildCodexArgs, CODEX_DISABLED_FEATURES, execute } = await import("../../src/adapters/codex/execute.js");

const ctx = (over: Record<string, unknown> = {}) => ({ prompt: "p", cwd: "C:/x", model: "m", timeoutSec: 5, graceSec: 1, env: { A: "1" }, onLog: () => {}, ...over }) as unknown as Parameters<typeof execute>[0];
beforeEach(() => {
  h.run.mockReset();
  h.run.mockReturnValue({ promise: Promise.resolve({ stdout: "", stderr: "", exitCode: 0, timedOut: false, durationMs: 1 }), kill: vi.fn() });
});

describe("execute (cableado de aislamiento)", () => {
  it("con sesión: runProcess recibe CODEX_HOME", async () => {
    h.env.mockResolvedValue({ CODEX_HOME: "H" });
    await execute(ctx());
    expect(h.run.mock.calls[0]![0].env).toEqual({ A: "1", CODEX_HOME: "H" });
  });
  it("sin sesión: no recibe CODEX_HOME", async () => {
    h.env.mockResolvedValue({});
    await execute(ctx());
    expect(h.run.mock.calls[0]![0].env).toEqual({ A: "1" });
  });
  it("modelo vacío: usa el modelo por defecto del catálogo", async () => {
    h.env.mockResolvedValue({});
    await execute(ctx({ model: "" }));
    const args: string[] = h.run.mock.calls[0]![0].args;
    expect(args[args.indexOf("-m") + 1]).toBe(MODEL_CATALOG.codex.defaultModel);
  });
});

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
