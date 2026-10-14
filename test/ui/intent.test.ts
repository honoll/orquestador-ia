import { describe, it, expect } from "vitest";
import { parseIntentFromSearch, stripIntentParams } from "../../ui/src/lib/intent.js";

describe("parseIntentFromSearch", () => {
  it("platicar y plan", () => {
    expect(parseIntentFromSearch("?platicar=1")).toEqual({ open: "platicar" });
    expect(parseIntentFromSearch("?plan=abc-123")).toEqual({ open: "plan", planId: "abc-123" });
  });
  it("rechaza ids inválidos y búsquedas sin intent", () => {
    expect(parseIntentFromSearch("")).toBeNull();
    expect(parseIntentFromSearch("?platicar=0")).toBeNull();
    expect(parseIntentFromSearch("?plan=")).toBeNull();
    expect(parseIntentFromSearch("?plan=a%20b")).toBeNull();
    expect(parseIntentFromSearch("?plan=../x")).toBeNull();
    expect(parseIntentFromSearch(`?plan=${"a".repeat(65)}`)).toBeNull();
  });
});

describe("stripIntentParams", () => {
  it("quita solo los parámetros de intent", () => {
    expect(stripIntentParams("http://x/?platicar=1")).toBe("/");
    expect(stripIntentParams("http://x/p?plan=a&k=v#h")).toBe("/p?k=v#h");
  });
});
