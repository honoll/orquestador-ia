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
    expect(h.run.mock.calls[0]![0].args).toContain("danger-full-access");
  });
  it("sin sesión: no recibe CODEX_HOME", async () => {
    h.env.mockResolvedValue({});
    await execute(ctx());
    expect(h.run.mock.calls[0]![0].env).toEqual({ A: "1" });
    expect(h.run.mock.calls[0]![0].args).toContain("workspace-write");
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
  it("escritor (win32): workspace-write + never + sandbox elevado, sin --full-auto", () => {
    const args = buildCodexArgs("gpt-5.5", { platform: "win32" });
    expect(args).toEqual(["exec", "--json", "--sandbox", "workspace-write", "-c", "approval_policy='never'", "-c", "windows.sandbox='elevated'", "--skip-git-repo-check", ...iso, "-m", "gpt-5.5", "-"]);
    expect(args).not.toContain("--full-auto");
  });
  it("escritor con perfil de trabajador: danger-full-access + never, sin windows.sandbox", () => {
    for (const platform of ["win32", "linux"] as const)
      expect(buildCodexArgs("gpt-5.5", { platform, workerProfile: true })).toEqual(["exec", "--json", "--sandbox", "danger-full-access", "-c", "approval_policy='never'", "--skip-git-repo-check", ...iso, "-m", "gpt-5.5", "-"]);
  });
  it("readOnly con perfil sigue en read-only", () => {
    expect(buildCodexArgs(undefined, { readOnly: true, workerProfile: true })).toContain("read-only");
  });
  it("escritor (no win32): sin windows.sandbox", () => {
    expect(buildCodexArgs("gpt-5.5", { platform: "linux" })).toEqual(["exec", "--json", "--sandbox", "workspace-write", "-c", "approval_policy='never'", "--skip-git-repo-check", ...iso, "-m", "gpt-5.5", "-"]);
  });
  it("readOnly: sandbox de solo lectura + never + aislamiento (en cualquier plataforma)", () => {
    const want = ["exec", "--json", "--sandbox", "read-only", "-c", "approval_policy='never'", "--skip-git-repo-check", ...iso, "-"];
    expect(buildCodexArgs(undefined, { readOnly: true, platform: "win32" })).toEqual(want);
    expect(buildCodexArgs(undefined, { readOnly: true, platform: "linux" })).toEqual(want);
  });
  it("los valores -c no necesitan comillas bajo cmd.exe (literales TOML con comilla simple)", async () => {
    const { quoteWindowsArg } = await vi.importActual<typeof import("../../src/lib/process-runner.js")>("../../src/lib/process-runner.js");
    for (const v of ["approval_policy='never'", "windows.sandbox='elevated'"]) expect(quoteWindowsArg(v)).toBe(v);
  });
});
