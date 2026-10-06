import { describe, it, expect } from "vitest";
import { parse } from "../../src/adapters/codex/parse.js";
import { makeProc, jsonl } from "../helpers/proc.js";

describe("codex parse", () => {
  it("une los agent_message y lee tokens de turn.completed", () => {
    const r = parse(makeProc({
      stdout: jsonl(
        { type: "thread.started", thread_id: "t-9" },
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "parte 1" } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "parte 2" } },
        { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 7, reasoning_output_tokens: 0 } },
      ),
    }));
    expect(r.sessionId).toBe("t-9");
    expect(r.summary).toBe("parte 1\nparte 2");
    expect(r.inputTokens).toBe(50);
    expect(r.outputTokens).toBe(7);
  });

  it("desanida el mensaje de error que viene como JSON en string", () => {
    const r = parse(makeProc({
      exitCode: 1,
      stdout: jsonl({ type: "turn.failed", error: { message: JSON.stringify({ error: { message: "modelo no soportado" } }) } }),
    }));
    expect(r.errorMessage).toBe("modelo no soportado");
    expect(r.summary).toBe("Error: modelo no soportado");
    expect(r.errorFamily).toBe("unknown");
  });
});
