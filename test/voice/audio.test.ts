import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { buildFfmpegArgs, toWav16k } from "../../src/voice/audio.js";
import { AudioTooLongError, MAX_WAV_BYTES } from "../../src/voice/limits.js";
import type { Runner } from "../../src/voice/runner.js";

describe("buildFfmpegArgs", () => {
  it("args exactos", () => {
    expect(buildFfmpegArgs("in.webm", "out.wav")).toEqual(["-nostdin", "-loglevel", "error", "-y", "-i", "in.webm", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-t", "121", "out.wav"]);
  });
});

describe("toWav16k", () => {
  it("escribe el temporal, corre ffmpeg, devuelve el WAV y limpia", async () => {
    const seen: { cmd: string; args: string[]; inputExisted: boolean; dir: string }[] = [];
    const run: Runner = async (cmd, args) => {
      const input = args[args.indexOf("-i") + 1];
      const output = args[args.length - 1];
      seen.push({ cmd, args, inputExisted: fs.readFileSync(input).toString() === "audio-webm", dir: input });
      fs.writeFileSync(output, "WAVDATA");
      return { exitCode: 0, stderr: "" };
    };
    const out = await toWav16k(Buffer.from("audio-webm"), { run, ffmpeg: "ffmpeg" });
    expect(out.toString()).toBe("WAVDATA");
    expect(seen[0].cmd).toBe("ffmpeg");
    expect(seen[0].inputExisted).toBe(true);
    expect(fs.existsSync(seen[0].dir)).toBe(false);
  });

  it("si ffmpeg falla lanza y aun así limpia", async () => {
    let input = "";
    const run: Runner = async (_c, args) => {
      input = args[args.indexOf("-i") + 1];
      return { exitCode: 1, stderr: "boom" };
    };
    await expect(toWav16k(Buffer.from("x"), { run })).rejects.toThrow(/ffmpeg/);
    expect(fs.existsSync(input)).toBe(false);
  });

  it("si el WAV supera el máximo lanza AudioTooLongError sin cargarlo", async () => {
    const run: Runner = async (_c, args) => {
      fs.writeFileSync(args[args.length - 1], Buffer.alloc(MAX_WAV_BYTES + 1));
      return { exitCode: 0, stderr: "" };
    };
    await expect(toWav16k(Buffer.from("x"), { run })).rejects.toBeInstanceOf(AudioTooLongError);
  });
});
