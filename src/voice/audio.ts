import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { voiceConfig } from "./config.js";
import { AudioTooLongError, MAX_AUDIO_SECONDS, MAX_WAV_BYTES } from "./limits.js";
import { defaultRunner, type Runner } from "./runner.js";

export type { Runner } from "./runner.js";

export function buildFfmpegArgs(input: string, output: string): string[] {
  // -t corta la salida a MAX+1 s: así un audio larguísimo no genera cientos de MB en %TEMP%.
  return [
    "-nostdin", "-loglevel", "error", "-y", "-i", input,
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    "-t", String(MAX_AUDIO_SECONDS + 1),
    output,
  ];
}

/** Convierte cualquier audio a WAV 16 kHz mono PCM s16. Lanza si ffmpeg falla o AudioTooLongError si pasa de 120 s; siempre borra los temporales. */
export async function toWav16k(audio: Buffer, opts: { run?: Runner; ffmpeg?: string } = {}): Promise<Buffer> {
  const run = opts.run ?? defaultRunner;
  const ffmpeg = opts.ffmpeg ?? voiceConfig().ffmpeg;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voz-in-"));
  try {
    const input = path.join(dir, "entrada.bin");
    const output = path.join(dir, "salida.wav");
    await fs.writeFile(input, audio);
    const r = await run(ffmpeg, buildFfmpegArgs(input, output), { timeoutSec: 60 });
    if (r.exitCode !== 0) throw new Error(`ffmpeg falló (${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`);
    if ((await fs.stat(output)).size > MAX_WAV_BYTES) throw new AudioTooLongError();
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
