import { describe, it, expect } from "vitest";
import { roleColor, roleTag, ROLE_TEMPLATE } from "../../ui/src/lib/roles.js";
import { parseRole } from "../../src/server/roles.js";

describe("roles (UI)", () => {
  it("color fijo por rol conocido y gris para el resto", () => {
    expect(roleColor("dev")).toBe("#60a5fa");
    expect(new Set(["dev", "qa", "imagen", "investigador", "lector", "redactor"].map(roleColor)).size).toBe(6);
    expect(roleColor("otro")).toBe("#8b8b94");
    expect(roleColor("constructor")).toBe("#8b8b94"); // no hereda de Object.prototype
  });
  it("etiqueta en mayúsculas", () => expect(roleTag("investigador")).toBe("INVESTIGADOR"));
  it("la plantilla de rol nuevo es válida", () => {
    expect(parseRole(ROLE_TEMPLATE, "nuevo-rol").escribe).toBe(false);
  });
});
