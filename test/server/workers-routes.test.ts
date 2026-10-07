import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  status: vi.fn(async () => ({ home: "C:/perfil/codex", loggedIn: true })),
  invalidate: vi.fn(),
  open: vi.fn(),
}));
vi.mock("../../src/lib/worker-profile.js", () => ({ codexProfile: { status: h.status, invalidate: h.invalidate } }));
vi.mock("../../src/lib/codex-terminal.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/codex-terminal.js")>("../../src/lib/codex-terminal.js");
  return { ...actual, openCodexLoginTerminal: h.open };
});

const { default: workersRoute } = await import("../../src/server/routes/workers.js");
const { buildCodexLoginCommand } = await import("../../src/lib/codex-terminal.js");

beforeEach(() => { h.status.mockClear(); h.invalidate.mockClear(); h.open.mockReset(); });

describe("GET /status", () => {
  it("con sesión: codex aislado", async () => {
    h.status.mockResolvedValueOnce({ home: "H", loggedIn: true });
    const res = await workersRoute.request("/status");
    expect(await res.json()).toEqual({ claude: { isolated: true }, agy: { isolated: true }, codex: { isolated: true, home: "H" } });
  });
  it("?fresh=1 invalida el caché antes de consultar; sin él no", async () => {
    await workersRoute.request("/status");
    expect(h.invalidate).not.toHaveBeenCalled();
    await workersRoute.request("/status?fresh=1");
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.invalidate.mock.invocationCallOrder[0]).toBeLessThan(h.status.mock.invocationCallOrder.at(-1)!);
  });
  it("sin sesión: codex no aislado, claude/agy siempre true", async () => {
    h.status.mockResolvedValueOnce({ home: "H", loggedIn: false });
    const body = (await (await workersRoute.request("/status")).json()) as { codex: { isolated: boolean }; claude: { isolated: boolean }; agy: { isolated: boolean } };
    expect(body.codex.isolated).toBe(false);
    expect(body.claude.isolated).toBe(true);
    expect(body.agy.isolated).toBe(true);
  });
});

describe("POST /codex/login-terminal", () => {
  it("abre la terminal con el home del perfil e invalida el caché", async () => {
    const res = await workersRoute.request("/codex/login-terminal", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(h.open).toHaveBeenCalledWith("C:/perfil/codex");
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });
  it("501 si la terminal no está soportada", async () => {
    h.open.mockImplementation(() => { throw new Error("solo Windows"); });
    const res = await workersRoute.request("/codex/login-terminal", { method: "POST" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "solo Windows" });
  });
});

describe("buildCodexLoginCommand", () => {
  it("arma el comando de cmd", () => {
    expect(buildCodexLoginCommand()).toEqual({ command: "cmd.exe", args: ["/c", 'start "Codex - perfil de trabajadores" cmd /k codex login'] });
  });
});
