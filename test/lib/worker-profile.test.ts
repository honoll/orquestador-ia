import { describe, it, expect, vi, afterEach } from "vitest";

const h = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../src/lib/process-runner.js", () => ({ runProcess: h.run }));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orchestratorDataRoot, codexWorkerHome, createCodexProfile, checkCodexLogin, CODEX_STATUS_TTL_MS } from "../../src/lib/worker-profile.js";

const tmps: string[] = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "wp-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("perfil de trabajador de Codex", () => {
  it("la raíz es ORQUESTADOR_DATA_DIR o ~/.orquestador-ia, nunca AppData", () => {
    expect(orchestratorDataRoot({ ORQUESTADOR_DATA_DIR: "D:/datos" })).toBe("D:/datos");
    expect(orchestratorDataRoot({ USERPROFILE: "C:/Users/x" })).toBe(path.join("C:/Users/x", ".orquestador-ia"));
  });
  it("codexWorkerHome crea <raíz>/workers/codex", () => {
    const root = mk();
    const home = codexWorkerHome({ ORQUESTADOR_DATA_DIR: root });
    expect(home).toBe(path.join(root, "workers", "codex"));
    expect(fs.existsSync(home)).toBe(true);
  });
  it("con sesión: envForWorker da CODEX_HOME; sin sesión: {}", async () => {
    const root = mk();
    const env = { ORQUESTADOR_DATA_DIR: root };
    const yes = createCodexProfile({ checker: async () => true, env });
    expect(await yes.envForWorker()).toEqual({ CODEX_HOME: path.join(root, "workers", "codex") });
    const no = createCodexProfile({ checker: async () => false, env });
    expect(await no.envForWorker()).toEqual({});
    expect(await no.status()).toEqual({ home: path.join(root, "workers", "codex"), loggedIn: false });
  });
  it("cachea el estado 60 s e invalidate fuerza otra consulta", async () => {
    let t = 0;
    const checker = vi.fn(async () => true);
    const p = createCodexProfile({ checker, now: () => t, env: { ORQUESTADOR_DATA_DIR: mk() } });
    await p.status(); await p.status();
    expect(checker).toHaveBeenCalledTimes(1);
    t = CODEX_STATUS_TTL_MS + 1;
    await p.status();
    expect(checker).toHaveBeenCalledTimes(2);
    p.invalidate();
    await p.status();
    expect(checker).toHaveBeenCalledTimes(3);
  });
  it("si el checker falla, se considera sin sesión", async () => {
    const p = createCodexProfile({ checker: async () => { throw new Error("x"); }, env: { ORQUESTADOR_DATA_DIR: mk() } });
    expect((await p.status()).loggedIn).toBe(false);
  });
  it("chequeos simultáneos con caché frío comparten una sola consulta", async () => {
    let release!: (v: boolean) => void;
    const checker = vi.fn(() => new Promise<boolean>((r) => { release = r; }));
    const p = createCodexProfile({ checker, env: { ORQUESTADOR_DATA_DIR: mk() } });
    const all = Promise.all([p.status(), p.status(), p.status(), p.envForWorker()]);
    await new Promise((r) => setTimeout(r, 10));
    release(true);
    const res = await all;
    expect(checker).toHaveBeenCalledTimes(1);
    expect(res.slice(0, 3).every((x) => (x as { loggedIn: boolean }).loggedIn)).toBe(true);
  });
  it("sin carpeta escribible no truena: sin sesión y env vacío", async () => {
    const root = mk();
    const blocker = path.join(root, "archivo");
    fs.writeFileSync(blocker, "x");
    const env = { ORQUESTADOR_DATA_DIR: path.join(blocker, "sub") };
    const checker = vi.fn(async () => true);
    const p = createCodexProfile({ checker, env });
    expect(await p.status()).toEqual({ home: path.join(blocker, "sub", "workers", "codex"), loggedIn: false });
    expect(await p.envForWorker()).toEqual({});
    expect(checker).not.toHaveBeenCalled();
    expect(() => codexWorkerHome(env)).not.toThrow();
  });
});

describe("checkCodexLogin", () => {
  const withExit = (exitCode: number | null) => h.run.mockReturnValueOnce({ promise: Promise.resolve({ exitCode }), kill: vi.fn() });
  it("true solo con exitCode 0 y pasa CODEX_HOME", async () => {
    withExit(0);
    expect(await checkCodexLogin("H")).toBe(true);
    expect(h.run.mock.calls.at(-1)![0]).toMatchObject({ command: "codex", args: ["login", "status"], env: { CODEX_HOME: "H" } });
    withExit(1);
    expect(await checkCodexLogin("H")).toBe(false);
    withExit(null);
    expect(await checkCodexLogin("H")).toBe(false);
  });
});
