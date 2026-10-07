import { describe, it, expect } from "vitest";
import {
  AUTO_READ_KEY,
  appendTranscript,
  dictationUnavailableReason,
  formatElapsed,
  micErrorMessage,
  pickMimeType,
  readAutoRead,
  speechUnavailableReason,
  transcribingLabel,
  writeAutoRead,
  type VoiceStatus,
} from "../../ui/src/lib/voice-utils.js";

const ok: VoiceStatus = { whisper: { available: true, state: "ready" }, piper: { available: true, voice: "es_MX-claude-high" } };

describe("appendTranscript", () => {
  it("agrega al texto existente con un espacio", () => {
    expect(appendTranscript("hola", " qué tal ")).toBe("hola qué tal");
  });
  it("no duplica espacios ni saltos al final", () => {
    expect(appendTranscript("hola ", "qué")).toBe("hola qué");
    expect(appendTranscript("hola\n", "qué")).toBe("hola\nqué");
  });
  it("caja vacía o solo espacios: queda solo lo dictado", () => {
    expect(appendTranscript("", "hola")).toBe("hola");
    expect(appendTranscript("  ", "hola")).toBe("hola");
  });
  it("transcripción vacía no cambia nada", () => {
    expect(appendTranscript("hola", "  ")).toBe("hola");
  });
});

describe("formatElapsed", () => {
  it("minutos y segundos", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(7_900)).toBe("0:07");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(-5)).toBe("0:00");
  });
});

describe("errores y disponibilidad", () => {
  it("mensajes de micrófono", () => {
    expect(micErrorMessage({ name: "NotAllowedError" })).toMatch(/permiso/);
    expect(micErrorMessage({ name: "NotFoundError" })).toMatch(/ningún micrófono/);
    expect(micErrorMessage({ name: "NotReadableError" })).toMatch(/ocupado/);
    expect(micErrorMessage(new Error("x"))).toMatch(/No se pudo grabar/);
    expect(micErrorMessage(null)).toMatch(/No se pudo grabar/);
  });
  it("dictado y lectura según el estado", () => {
    expect(dictationUnavailableReason(ok, false)).toBeNull();
    expect(speechUnavailableReason(ok, false)).toBeNull();
    expect(dictationUnavailableReason(undefined, true)).toMatch(/Comprobando/);
    expect(dictationUnavailableReason(undefined, false)).toMatch(/No se pudo consultar/);
    const sinWhisper = { ...ok, whisper: { available: false, state: "stopped" as const } };
    expect(dictationUnavailableReason(sinWhisper, false)).toMatch(/whisper/i);
    expect(speechUnavailableReason(sinWhisper, false)).toBeNull();
    const sinPiper = { ...ok, piper: { available: false, voice: "x" } };
    expect(speechUnavailableReason(sinPiper, false)).toMatch(/Piper/);
  });
  it("etiqueta de transcripción según el estado de Whisper", () => {
    expect(transcribingLabel("ready")).toBe("transcribiendo…");
    expect(transcribingLabel(undefined)).toBe("transcribiendo…");
    expect(transcribingLabel("starting")).toMatch(/~40 s/);
    expect(transcribingLabel("warming")).toMatch(/preparando Whisper/);
  });
});

describe("pickMimeType", () => {
  it("prefiere webm con opus y cae a webm", () => {
    expect(pickMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickMimeType((t) => t === "audio/webm")).toBe("audio/webm");
    expect(pickMimeType(() => false)).toBeUndefined();
  });
});

describe("preferencia de lectura automática", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("guarda y lee", () => {
    const s = mem();
    expect(readAutoRead(s)).toBe(false);
    writeAutoRead(s, true);
    expect(s.getItem(AUTO_READ_KEY)).toBe("1");
    expect(readAutoRead(s)).toBe(true);
    writeAutoRead(s, false);
    expect(readAutoRead(s)).toBe(false);
  });
  it("tolera almacenamiento ausente o que lanza", () => {
    const roto = { getItem: () => { throw new Error("bloqueado"); }, setItem: () => { throw new Error("bloqueado"); } };
    expect(readAutoRead(roto)).toBe(false);
    expect(() => writeAutoRead(roto, true)).not.toThrow();
    expect(readAutoRead(null)).toBe(false);
    expect(() => writeAutoRead(undefined, true)).not.toThrow();
  });
});
