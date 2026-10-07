import fs from "node:fs";
import { Hono } from "hono";
import { voiceConfig } from "../../voice/config.js";
import { whisper } from "../../voice/whisper.js";
import { toWav16k } from "../../voice/audio.js";
import { synthesize } from "../../voice/piper.js";
import { toSpeechText } from "../../voice/text.js";

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
/** 120 s de WAV 16 kHz mono s16 (+ cabecera). */
export const MAX_WAV_BYTES = 120 * 16000 * 2 + 44;

const app = new Hono();

app.get("/status", (c) => {
  const cfg = voiceConfig();
  return c.json({
    whisper: { available: fs.existsSync(cfg.whisperExe) && fs.existsSync(cfg.whisperModel), state: whisper.status() },
    piper: { available: fs.existsSync(cfg.piperExe) && fs.existsSync(cfg.voiceModel), voice: cfg.voiceName },
  });
});

app.post("/transcribe", async (c) => {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (!type.startsWith("audio/")) return c.json({ error: "El cuerpo debe ser audio (Content-Type audio/*)" }, 415);
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > MAX_AUDIO_BYTES) return c.json({ error: "Audio demasiado grande (máx. 10 MB)" }, 413);
  const body = Buffer.from(await c.req.arrayBuffer());
  if (body.length > MAX_AUDIO_BYTES) return c.json({ error: "Audio demasiado grande (máx. 10 MB)" }, 413);
  if (body.length === 0) return c.json({ error: "Audio vacío" }, 400);

  let wav: Buffer;
  try {
    wav = await toWav16k(body);
  } catch {
    return c.json({ error: "No se pudo convertir el audio" }, 503);
  }
  if (wav.length > MAX_WAV_BYTES) return c.json({ error: "Audio demasiado largo (máx. 120 s)" }, 413);

  const text = await whisper.transcribe(wav);
  if (text === null) return c.json({ error: "Whisper no está disponible o falló la transcripción" }, 503);
  return c.json({ text });
});

app.post("/speak", async (c) => {
  let body: { text?: unknown; summary?: unknown } = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON inválido" }, 400);
  }
  if (typeof body.text !== "string") return c.json({ error: "Falta text" }, 400);
  const speech = toSpeechText(body.text, { summary: body.summary === true });
  if (!speech) return c.json({ error: "No hay texto que leer" }, 400);
  const wav = await synthesize(speech);
  if (!wav) return c.json({ error: "Piper no está disponible o falló la síntesis" }, 503);
  return c.body(new Uint8Array(wav), 200, { "Content-Type": "audio/wav" });
});

export default app;
