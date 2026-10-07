import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { voiceConfig, type VoiceConfig } from "./config.js";
import { defaultRunner, type Runner } from "./runner.js";

export function buildPiperArgs(model: string, out: string): string[] {
  return ["--model", model, "--output_file", out];
}

/** Texto -> WAV con Piper (texto por stdin). null si falla o faltan el exe/la voz. Nunca lanza. */
export async function synthesize(
  text: string,
  opts: { run?: Runner; cfg?: VoiceConfig; exists?: (p: string) => boolean } = {},
): Promise<Buffer | null> {
  const cfg = opts.cfg ?? voiceConfig();
  const run = opts.run ?? defaultRunner;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  let dir: string | null = null;
  try {
    if (!text.trim() || !exists(cfg.piperExe) || !exists(cfg.voiceModel)) return null;
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "voz-out-"));
    const out = path.join(dir, "salida.wav");
    const r = await run(cfg.piperExe, buildPiperArgs(cfg.voiceModel, out), { stdin: text, timeoutSec: 60 });
    if (r.exitCode !== 0) return null;
    return await fsp.readFile(out);
  } catch {
    return null;
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
