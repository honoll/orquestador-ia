import { describe, it, expect } from "vitest";
import { parse } from "../../src/adapters/claude/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

describe("claude parse", () => {
  it("extrae resultado, sesión, costo y tokens del stream-json", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "system", session_id: "s-1", model: "claude-opus-5-5" },
        { type: "result", result: "hola", total_cost_usd: 0.012, usage: { input_tokens: 100, output_tokens: 20 }, session_id: "s-1" },
      ),
    }));
    expect(r.summary).toBe("hola");
    expect(r.sessionId).toBe("s-1");
    expect(r.model).toBe("claude-opus-5-5");
    expect(r.costUsd).toBe(0.012);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(20);
    expect(r.errorMessage).toBeNull();
  });

  it("clasifica 429 como transient_upstream", () => {
    const r = parse(makeProc({ exitCode: 1, stderr: "429 Too Many Requests" }));
    expect(r.errorFamily).toBe("transient_upstream");
    expect(r.errorMessage).toBe("429 Too Many Requests");
  });

  it("timeout gana sobre cualquier otro error", () => {
    const r = parse(makeProc({ exitCode: 1, timedOut: true, stderr: "boom" }));
    expect(r.errorFamily).toBe("timeout");
    expect(r.errorMessage).toBe("Process timed out");
  });

  it("ignora líneas que no son JSON", () => {
    const r = parse(makeProc({ stdout: "basura\n" + jsonl({ result: "ok" }) }));
    expect(r.summary).toBe("ok");
  });
});
