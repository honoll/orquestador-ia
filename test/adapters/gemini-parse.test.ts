import { describe, it, expect } from "vitest";
import { parse } from "../../src/adapters/gemini/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

describe("gemini parse", () => {
  it("concatena deltas del asistente y toma tokens de result", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "init", session_id: "g-1", model: "gemini-2.5-flash" },
        { type: "message", role: "user", content: "hola" },
        { type: "message", role: "assistant", content: "Ho", delta: true },
        { type: "message", role: "assistant", content: "la", delta: true },
        { type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2 } },
      ),
    }));
    expect(r.sessionId).toBe("g-1");
    expect(r.summary).toBe("Hola");
    expect(r.model).toBe("gemini-2.5-flash");
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(2);
  });

  it("con modelo 'auto-*' toma el primer modelo no-lite de stats.models", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "init", session_id: "g-2", model: "auto-gemini-3" },
        { type: "result", status: "success", stats: { models: { "gemini-3-flash-lite": {}, "gemini-3-pro": {} } } },
      ),
    }));
    expect(r.model).toBe("gemini-3-pro");
  });
});
