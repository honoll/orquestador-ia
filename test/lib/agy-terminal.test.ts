import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTerminalCommand, terminalEnv } from "../../src/lib/agy-terminal.js";
import { withoutOrchestratorSecrets } from "../../src/lib/process-runner.js";

describe("buildTerminalCommand", () => {
  it("abre una consola nueva con start y la ruta de agy entre comillas", () => {
    expect(buildTerminalCommand("C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe")).toEqual({
      command: "cmd.exe",
      args: ["/c", 'start "Antigravity - cambiar cuenta" "C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe"'],
    });
  });
});

describe("withoutOrchestratorSecrets", () => {
  it("remueve TYPESAFE_API_KEY sin mayúsculas y en mayúsculas", () => {
    const env = {
      TYPESAFE_API_KEY: "secret-value",
      typesafe_api_key: "another-secret",
      PATH: "/usr/bin",
      HOME: "/home/user",
    };
    const filtered = withoutOrchestratorSecrets(env);
    expect(filtered.TYPESAFE_API_KEY).toBeUndefined();
    expect(filtered.typesafe_api_key).toBeUndefined();
    expect(filtered.PATH).toBe("/usr/bin");
    expect(filtered.HOME).toBe("/home/user");
  });

  it("retorna una copia, no modifica el original", () => {
    const env = { TYPESAFE_API_KEY: "secret", PATH: "/bin" };
    const original = { ...env };
    withoutOrchestratorSecrets(env);
    expect(env).toEqual(original);
  });
});

describe("terminalEnv", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.TYPESAFE_API_KEY;
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.TYPESAFE_API_KEY = originalKey;
    } else {
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("remueve TYPESAFE_API_KEY del environment de la terminal", () => {
    process.env.TYPESAFE_API_KEY = "x";
    const env = terminalEnv();
    expect(env.TYPESAFE_API_KEY).toBeUndefined();
  });

  it("mantiene PATH o Path disponible", () => {
    const env = terminalEnv();
    expect(env.PATH ?? env.Path).toBeDefined();
  });
});
