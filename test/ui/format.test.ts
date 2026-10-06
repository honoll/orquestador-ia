import { describe, it, expect } from "vitest";
import { formatTokens, formatIn } from "../../ui/src/lib/format.js";

describe("formato", () => {
  it("tokens", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(11_710)).toBe("11.7k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
  it("tiempo restante", () => {
    expect(formatIn(0)).toBe("ya");
    expect(formatIn(35 * 60_000)).toBe("35 min");
    expect(formatIn(2 * 3_600_000 + 10 * 60_000)).toBe("2 h 10 min");
    expect(formatIn(3 * 3_600_000)).toBe("3 h");
  });
});
