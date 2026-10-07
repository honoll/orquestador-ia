import path from "node:path";

export interface VoiceConfig {
  dir: string;
  whisperExe: string;
  whisperModel: string;
  whisperPort: number;
  piperExe: string;
  voiceModel: string;
  voiceName: string;
  ffmpeg: string;
}

export function voiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const dir = env.VOICE_DIR || "C:\\tools\\voz";
  const port = Number.parseInt(env.WHISPER_PORT ?? "", 10);
  const voiceName = env.PIPER_VOICE || "es_MX-claude-high";
  return {
    dir,
    whisperExe: path.join(dir, "whisper", "Release", "whisper-server.exe"),
    whisperModel: path.join(dir, "whisper", "ggml-large-v3-turbo-q5_0.bin"),
    whisperPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : 8091,
    piperExe: path.join(dir, "piper", "piper", "piper.exe"),
    voiceModel: path.join(dir, "voces", `${voiceName}.onnx`),
    voiceName,
    ffmpeg: env.FFMPEG_PATH || "ffmpeg",
  };
}
