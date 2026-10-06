import { describe, it, expect } from "vitest";
import { buildAgyArgs, buildAgyStdin } from "../../src/adapters/agy/execute.js";

describe("agy execute helpers", () => {
  it("args base: stream-json por stdin, --print= pegado y sin -p", () => {
    const a = buildAgyArgs();
    expect(a).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--print=", "--dangerously-skip-permissions"]);
    expect(a).not.toContain("-p");
  });
  it("readOnly omite --dangerously-skip-permissions", () => {
    const a = buildAgyArgs("m", undefined, { readOnly: true });
    expect(a).not.toContain("--dangerously-skip-permissions");
    expect(a).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--print=", "--model", "m"]);
  });
  it("agrega modelo y conversación", () => {
    expect(buildAgyArgs("gemini-3.8-flash-low", "c-1")).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json", "--print=", "--dangerously-skip-permissions",
      "--model", "gemini-3.8-flash-low", "--conversation", "c-1",
    ]);
  });
  it("stdin es una línea NDJSON con el prompt intacto (comillas, &, %VAR%, saltos)", () => {
    const prompt = 'di "a & b" y %PATH%\nsegunda línea';
    const line = buildAgyStdin(prompt);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ event: "user", message: { content: prompt } });
  });
});
