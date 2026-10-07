import { describe, expect, it } from "vitest";
import { float32ToWav } from "../../ui/src/lib/wav.js";

async function bytes(b: Blob) {
  return new DataView(await b.arrayBuffer());
}
const tag = (v: DataView, o: number) =>
  String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));

describe("float32ToWav", () => {
  it("escribe una cabecera RIFF/WAVE PCM mono 16 kHz s16", async () => {
    const blob = float32ToWav(new Float32Array(10));
    expect(blob.type).toBe("audio/wav");
    const v = await bytes(blob);
    expect(tag(v, 0)).toBe("RIFF");
    expect(tag(v, 8)).toBe("WAVE");
    expect(tag(v, 12)).toBe("fmt ");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(v, 36)).toBe("data");
  });

  it("calcula los tamaños", async () => {
    const blob = float32ToWav(new Float32Array(100), 8000);
    expect(blob.size).toBe(44 + 200);
    const v = await bytes(blob);
    expect(v.getUint32(4, true)).toBe(36 + 200);
    expect(v.getUint32(40, true)).toBe(200);
    expect(v.getUint32(24, true)).toBe(8000);
  });

  it("convierte y recorta a ±1", async () => {
    const v = await bytes(float32ToWav(new Float32Array([0, 0.5, -0.5, 1, -1, 3, -3])));
    const s = (i: number) => v.getInt16(44 + i * 2, true);
    expect(s(0)).toBe(0);
    expect(s(1)).toBe(16384);
    expect(s(2)).toBe(-16384);
    expect(s(3)).toBe(32767);
    expect(s(4)).toBe(-32768);
    expect(s(5)).toBe(32767);
    expect(s(6)).toBe(-32768);
  });

  it("audio vacío produce solo la cabecera", async () => {
    expect(float32ToWav(new Float32Array(0)).size).toBe(44);
  });
});
