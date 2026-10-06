import { describe, it, expect } from "vitest";
import { extractJsonFromOutput } from "../../src/server/planner.js";
import { jsonl } from "../helpers/proc.js";

describe("extractJsonFromOutput", () => {
  it("lee el JSON desde el evento result", () => {
    const out = jsonl({ type: "result", result: 'Aquí va:\n{"steps":[{"description":"x"}]}' });
    expect(extractJsonFromOutput(out).steps[0].description).toBe("x");
  });

  it("arma el JSON a partir de deltas", () => {
    const out = jsonl(
      { type: "content_block_delta", delta: { text: '{"steps":' } },
      { type: "content_block_delta", delta: { text: "[]}" } },
    );
    expect(extractJsonFromOutput(out)).toEqual({ steps: [] });
  });

  it("lanza error si no hay JSON", () => {
    expect(() => extractJsonFromOutput(jsonl({ result: "sin json" }))).toThrow("No JSON found");
  });
});
