import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildPiperArgs, synthesize } from "../../src/voice/piper.js";
import { voiceConfig } from "../../src/voice/config.js";
import type { Runner } from "../../src/voice/runner.js";

const cfg = voiceConfig({});
const present = () => true;

describe("buildPiperArgs", () => {
  it("args exactos", () => {
    expect(buildPiperArgs("m.onnx", "o.wav")).toEqual(["--model", "m.onnx", "--output_file", "o.wav"]);
  });
});

describe("synthesize", () => {
  it("texto por stdin, lee el WAV y limpia el temporal", async () => {
    let call: { cmd: string; args: string[]; stdin?: string } | null = null;
    const run: Runner = async (cmd, args, o) => {
      call = { cmd, args, stdin: o?.stdin };
      fs.writeFileSync(args[3], "WAV");
      return { exitCode: 0, stderr: "" };
    };
    const out = await synthesize("Hola, ¿qué tal?", { run, cfg, exists: present });
    expect(out?.toString()).toBe("WAV");
    expect(call!.cmd).toBe(cfg.piperExe);
    expect(call!.args.slice(0, 3)).toEqual(["--model", cfg.voiceModel, "--output_file"]);
    expect(call!.stdin).toBe("Hola, ¿qué tal?");
    expect(fs.existsSync(path.dirname(call!.args[3]))).toBe(false);
  });
  it("exit != 0 -> null y limpia", async () => {
    let out = "";
    const run: Runner = async (_c, args) => { out = args[3]; return { exitCode: 1, stderr: "x" }; };
    expect(await synthesize("hola", { run, cfg, exists: present })).toBeNull();
    expect(fs.existsSync(path.dirname(out))).toBe(false);
  });
  it("el runner lanza -> null", async () => {
    const run: Runner = async () => { throw new Error("boom"); };
    expect(await synthesize("hola", { run, cfg, exists: present })).toBeNull();
  });
  it("exe o voz inexistentes -> null sin ejecutar", async () => {
    let called = false;
    const run: Runner = async () => { called = true; return { exitCode: 0, stderr: "" }; };
    expect(await synthesize("hola", { run, cfg, exists: () => false })).toBeNull();
    expect(called).toBe(false);
  });
  it("sin salida aunque exit 0 -> null", async () => {
    const run: Runner = async () => ({ exitCode: 0, stderr: "" });
    expect(await synthesize("hola", { run, cfg, exists: present })).toBeNull();
  });
});
