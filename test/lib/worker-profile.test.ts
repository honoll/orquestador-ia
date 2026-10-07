import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { orchestratorDataRoot, codexWorkerHome, createCodexProfile, CODEX_STATUS_TTL_MS } from "../../src/lib/worker-profile.js";

describe("perfil de trabajador de Codex", () => {
  it("la raíz es ORQUESTADOR_DATA_DIR o ~/.orquestador-ia, nunca AppData", () => {
    expect(orchestratorDataRoot({ ORQUESTADOR_DATA_DIR: "D:/datos" })).toBe("D:/datos");
    expect(orchestratorDataRoot({ USERPROFILE: "C:/Users/x" })).toBe(path.join("C:/Users/x", ".orquestador-ia"));
  });
  it("codexWorkerHome crea <raíz>/workers/codex", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-"));
    const home = codexWorkerHome({ ORQUESTADOR_DATA_DIR: root });
    expect(home).toBe(path.join(root, "workers", "codex"));
    expect(fs.existsSync(home)).toBe(true);
  });
  it("con sesión: envForWorker da CODEX_HOME; sin sesión: {}", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wp-"));
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
    const p = createCodexProfile({ checker, now: () => t, env: { ORQUESTADOR_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wp-")) } });
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
    const p = createCodexProfile({ checker: async () => { throw new Error("x"); }, env: { ORQUESTADOR_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "wp-")) } });
    expect((await p.status()).loggedIn).toBe(false);
  });
});
