import { describe, it, expect } from "vitest";
import { quoteWindowsArg } from "../../src/lib/process-runner.js";

describe("quoteWindowsArg", () => {
  it("string vacío → par de comillas", () => expect(quoteWindowsArg("")).toBe('""'));
  it("arg simple no se toca", () => expect(quoteWindowsArg("--json")).toBe("--json"));
  it("arg con espacio se envuelve", () => expect(quoteWindowsArg("a b")).toBe('"a b"'));
  it("escapa TODAS las comillas (regresión del bug sin /g)", () =>
    expect(quoteWindowsArg('di "hola" y "adiós"')).toBe('"di \\"hola\\" y \\"adiós\\""'));
  it("duplica backslashes finales antes de la comilla de cierre", () =>
    expect(quoteWindowsArg("C:\\mi carpeta\\")).toBe('"C:\\mi carpeta\\\\"'));
});

// Regla de F1: prompts por stdin o spawn con shell:false; nunca prompts como argumento por cmd.exe.
describe("limitaciones conocidas (cmd.exe)", () => {
  it.fails('`di "a & b"` no debe dejar que `& b` escape de las comillas', () => {
    const quoted = quoteWindowsArg('di "a & b"');
    // Con comillas escapadas como \" cmd.exe cierra la cadena y `& b` queda fuera.
    expect(quoted).not.toMatch(/\\"[^"]*&/);
  });

  it.fails("%PATH% no debe expandirse en cmd.exe", () => {
    expect(quoteWindowsArg("%PATH%")).not.toMatch(/%[^%]+%/);
  });
});
