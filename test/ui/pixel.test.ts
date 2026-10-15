import { describe, it, expect } from "vitest";
import { avatarRoleFor, statusStyle } from "../../ui/src/lib/pixel.js";

describe("avatarRoleFor", () => {
  it("claude con opus → jefe", () => {
    expect(avatarRoleFor("claude", "claude-opus-5-5")).toBe("jefe");
    expect(avatarRoleFor("claude", "Claude-OPUS-4")).toBe("jefe");
  });
  it("claude con otro modelo o sin modelo → claude", () => {
    expect(avatarRoleFor("claude", "claude-sonnet-4-6")).toBe("claude");
    expect(avatarRoleFor("claude", "claude-haiku-4-5")).toBe("claude");
    expect(avatarRoleFor("claude")).toBe("claude");
    expect(avatarRoleFor("claude", null)).toBe("claude");
  });
  it("codex y agy → su personaje (aunque el modelo diga opus)", () => {
    expect(avatarRoleFor("codex", "gpt-5")).toBe("codex");
    expect(avatarRoleFor("agy", "claude-opus-4-6-thinking")).toBe("agy");
  });
  it("desconocido, null o undefined → claude", () => {
    expect(avatarRoleFor("gemini", "x")).toBe("claude");
    expect(avatarRoleFor(null)).toBe("claude");
    expect(avatarRoleFor(undefined)).toBe("claude");
  });
});

describe("statusStyle", () => {
  const cases: [string, string, string, string][] = [
    ["succeeded", "✓", "var(--color-ok)", "hecho"],
    ["completed", "✓", "var(--color-ok)", "completado"],
    ["running", "▶", "var(--color-blue)", "ejecutando"],
    ["paused", "⏸", "var(--color-warn)", "pausado"],
    ["pending", "•", "var(--color-text-secondary)", "en cola"],
    ["failed", "✗", "var(--color-err)", "falló"],
    ["cancelled", "⊘", "var(--color-text-secondary)", "cancelado"],
    ["skipped", "↷", "var(--color-text-secondary)", "omitido"],
  ];
  it.each(cases)("%s → %s %s %s", (status, icon, color, label) => {
    expect(statusStyle(status)).toEqual({ icon, color, label });
  });
  it("pending con pausa → ⏸ pausado amarillo", () => {
    expect(statusStyle("pending", true)).toEqual({ icon: "⏸", color: "var(--color-warn)", label: "pausado" });
  });
  it("paused no depende del flag", () => {
    expect(statusStyle("paused", false).icon).toBe("⏸");
  });
  it("desconocido → • gris con el estado como etiqueta", () => {
    expect(statusStyle("raro")).toEqual({ icon: "•", color: "var(--color-text-secondary)", label: "raro" });
  });
});
