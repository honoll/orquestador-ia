import { describe, it, expect } from "vitest";
import path from "node:path";
import { voiceConfig } from "../../src/voice/config.js";

describe("voiceConfig", () => {
  it("defaults del spike", () => {
    const c = voiceConfig({});
    expect(c.dir).toBe("C:\\tools\\voz");
    expect(c.whisperExe).toBe(path.join("C:\\tools\\voz", "whisper", "Release", "whisper-server.exe"));
    expect(c.whisperModel).toBe(path.join("C:\\tools\\voz", "whisper", "ggml-large-v3-turbo-q5_0.bin"));
    expect(c.whisperPort).toBe(8091);
    expect(c.piperExe).toBe(path.join("C:\\tools\\voz", "piper", "piper", "piper.exe"));
    expect(c.voiceName).toBe("es_MX-claude-high");
    expect(c.voiceModel).toBe(path.join("C:\\tools\\voz", "voces", "es_MX-claude-high.onnx"));
    expect(c.ffmpeg).toBe("ffmpeg");
  });
  it("respeta variables de entorno", () => {
    const c = voiceConfig({ VOICE_DIR: "D:\\v", WHISPER_PORT: "9000", PIPER_VOICE: "es_MX-ald-medium", FFMPEG_PATH: "D:\\ff.exe" });
    expect(c.dir).toBe("D:\\v");
    expect(c.whisperPort).toBe(9000);
    expect(c.voiceModel).toBe(path.join("D:\\v", "voces", "es_MX-ald-medium.onnx"));
    expect(c.ffmpeg).toBe("D:\\ff.exe");
  });
  it("puerto inválido cae al default", () => {
    expect(voiceConfig({ WHISPER_PORT: "abc" }).whisperPort).toBe(8091);
  });
});
