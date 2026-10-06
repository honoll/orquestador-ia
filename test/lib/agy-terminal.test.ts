import { describe, it, expect } from "vitest";
import { buildTerminalCommand } from "../../src/lib/agy-terminal.js";

describe("buildTerminalCommand", () => {
  it("abre una consola nueva con start y la ruta de agy entre comillas", () => {
    expect(buildTerminalCommand("C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe")).toEqual({
      command: "cmd.exe",
      args: ["/c", 'start "Antigravity - cambiar cuenta" "C:\\Users\\x\\AppData\\Local\\agy\\bin\\agy.exe"'],
    });
  });
});
