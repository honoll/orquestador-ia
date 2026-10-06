import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse, extractResetAt } from "../../src/adapters/agy/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

const fx = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "agy", f), "utf8");
const NOW = Date.parse("2026-10-06T12:00:00Z");

describe("agy parse", () => {
  it("lee el JSON de print mode (fixture real)", () => {
    const r = parse(makeProc({ stdout: fx("print-ok.json") }));
    expect(r.summary).toBe("ok");
    expect(r.sessionId).toBe("a07d71af-c976-4a5a-b562-5d1e032faa07");
    expect(r.inputTokens).toBe(11632);
    expect(r.outputTokens).toBe(78);
    expect(r.errorMessage).toBeNull();
    expect(r.exitCode).toBe(0);
  });

  it("lee stream-json (fixture real): modelo, sesión, texto y tokens", () => {
    const r = parse(makeProc({ stdout: fx("stream-stdin-ok.jsonl") }));
    expect(r.summary).toBe("ok");
    expect(r.model).toBe("gemini-3.8-flash-low");
    expect(r.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.inputTokens).toBeGreaterThan(10000);
  });

  it("result ERROR con exit 0 se reporta como fallo (exitCode 1)", () => {
    const r = parse(makeProc({ stdout: jsonl({ event: "result", result: { status: "ERROR", response: "", error: "algo falló", usage: { input_tokens: 0, output_tokens: 0 } } }) }));
    expect(r.exitCode).toBe(1);
    expect(r.errorMessage).toBe("algo falló");
    expect(r.errorFamily).toBe("unknown");
  });

  it("error de cuota → quota_exhausted con hora de reinicio ISO", () => {
    const r = parse(makeProc({
      exitCode: 1,
      stdout: jsonl({ event: "result", result: { status: "ERROR", error: "RESOURCE_EXHAUSTED: quota exceeded, resets at 2026-10-06T15:30:00Z", usage: { input_tokens: 0, output_tokens: 0 } } }),
    }), NOW);
    expect(r.errorFamily).toBe("quota_exhausted");
    expect(r.retryNotBefore).toBe("2026-10-06T15:30:00.000Z");
  });

  it("sin evento result y exit distinto de 0 usa stderr sin el prefijo 'error:'", () => {
    const r = parse(makeProc({ exitCode: 2, stderr: "error: stream input message is missing the \"event\" field\n" }));
    expect(r.errorMessage).toBe('stream input message is missing the "event" field');
  });

  it("timeout gana", () => {
    const r = parse(makeProc({ exitCode: 1, timedOut: true }));
    expect(r.errorFamily).toBe("timeout");
  });
});

describe("extractResetAt", () => {
  it("ISO", () => expect(extractResetAt("retry after 2026-10-06T13:00:00Z", NOW)).toBe("2026-10-06T13:00:00.000Z"));
  it("relativo en horas", () => expect(extractResetAt("try again in 2 hours", NOW)).toBe("2026-10-06T14:00:00.000Z"));
  it("relativo en minutos", () => expect(extractResetAt("vuelve a intentar en 30 minutos", NOW)).toBe("2026-10-06T12:30:00.000Z"));
  it("null si no hay pista", () => expect(extractResetAt("quota exceeded", NOW)).toBeNull());
});
