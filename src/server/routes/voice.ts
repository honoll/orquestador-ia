import fs from "node:fs";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { voiceConfig } from "../../voice/config.js";
import { whisper } from "../../voice/whisper.js";
import { toWav16k } from "../../voice/audio.js";
import { AudioTooLongError, MAX_WAV_BYTES } from "../../voice/limits.js";
import { synthesize } from "../../voice/piper.js";
import { toSpeechText } from "../../voice/text.js";
import { originGuard } from "../origin-guard.js";
import { browserProcessNames, duckEnabled, getDucker, type DuckReason } from "../../voice/duck.js";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export { MAX_WAV_BYTES };
export const MAX_SPEAK_BODY_BYTES = 64 * 1024;

const limitBody = (maxSize: number, msg: string) =>
  bodyLimit({ maxSize, onError: (c) => c.json({ error: msg }, 413) });

const app = new Hono();
app.use("*", originGuard());

/** Tope de trabajos pesados simultáneos (Piper / ffmpeg+Whisper): al excederlo, 429. */
export const MAX_CONCURRENT_JOBS = 2;
const FULL = Symbol("full");
const active = { speak: 0, transcribe: 0 };
async function withSlot<T>(kind: "speak" | "transcribe", fn: () => Promise<T>): Promise<T | typeof FULL> {
  if (active[kind] >= MAX_CONCURRENT_JOBS) return FULL;
  active[kind]++;
  try {
    return await fn();
  } finally {
    active[kind]--;
  }
}
const isJson = (c: Context) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json");
const BUSY = { error: "Demasiadas solicitudes de voz en curso; reintenta en un momento" };
const NOT_JSON = { error: "El cuerpo debe ser JSON (Content-Type application/json)" };

app.get("/status", (c) => {
  const cfg = voiceConfig();
  return c.json({
    whisper: { available: fs.existsSync(cfg.whisperExe) && fs.existsSync(cfg.whisperModel), state: whisper.status() },
    piper: { available: fs.existsSync(cfg.piperExe) && fs.existsSync(cfg.voiceModel), voice: cfg.voiceName },
    duck: { supported: getDucker().supported(), enabled: duckEnabled() },
  });
});

app.post("/transcribe", limitBody(MAX_AUDIO_BYTES, "Audio demasiado grande (máx. 10 MB)"), async (c) => {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (!type.startsWith("audio/")) return c.json({ error: "El cuerpo debe ser audio (Content-Type audio/*)" }, 415);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return c.json({ error: "Audio demasiado grande (máx. 10 MB)" }, 413);
  const out = await withSlot("transcribe", () => transcribeBody(c));
  return out === FULL ? c.json(BUSY, 429) : out;
});

async function transcribeBody(c: Context) {
  const body = Buffer.from(await c.req.arrayBuffer());
  if (body.length > MAX_AUDIO_BYTES) return c.json({ error: "Audio demasiado grande (máx. 10 MB)" }, 413);
  if (body.length === 0) return c.json({ error: "Audio vacío" }, 400);

  let wav: Buffer;
  try {
    wav = await toWav16k(body);
  } catch (err) {
    if (err instanceof AudioTooLongError) return c.json({ error: "Audio demasiado largo (máx. 120 s)" }, 413);
    return c.json({ error: "No se pudo convertir el audio" }, 503);
  }
  if (wav.length > MAX_WAV_BYTES) return c.json({ error: "Audio demasiado largo (máx. 120 s)" }, 413);

  const text = await whisper.transcribe(wav);
  if (text === null) return c.json({ error: "Whisper no está disponible o falló la transcripción" }, 503);
  return c.json({ text });
}

app.post("/speak", limitBody(MAX_SPEAK_BODY_BYTES, "Texto demasiado grande (máx. 64 KB)"), async (c) => {
  if (!isJson(c)) return c.json(NOT_JSON, 415);
  let body: { text?: unknown; summary?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }
  if (typeof body.text !== "string") return c.json({ error: "Falta text" }, 400);
  const speech = toSpeechText(body.text, { summary: body.summary === true });
  if (!speech) return c.json({ error: "No hay texto que leer" }, 400);
  const wav = await withSlot("speak", () => synthesize(speech));
  if (wav === FULL) return c.json(BUSY, 429);
  if (!wav) return c.json({ error: "Piper no está disponible o falló la síntesis" }, 503);
  return c.body(new Uint8Array(wav), 200, { "Content-Type": "audio/wav" });
});

const MAX_DUCK_BODY_BYTES = 1024;

app.post("/duck", limitBody(MAX_DUCK_BODY_BYTES, "Cuerpo demasiado grande"), async (c) => {
  if (!isJson(c)) return c.json(NOT_JSON, 415);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }
  const b = (body && typeof body === "object" ? body : {}) as { reason?: unknown; on?: unknown };
  if (b.reason !== "mic" && b.reason !== "speak") return c.json({ error: "reason debe ser mic o speak" }, 400);
  if (typeof b.on !== "boolean") return c.json({ error: "on debe ser booleano" }, 400);
  const reason: DuckReason = b.reason;
  const ducker = getDucker();
  const st = b.on
    ? await ducker.acquire(reason, browserProcessNames(c.req.header("user-agent")))
    : await ducker.release(reason);
  return c.json({ supported: st.supported, active: st.active });
});

export default app;
