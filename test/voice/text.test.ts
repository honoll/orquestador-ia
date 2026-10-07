import { describe, it, expect } from "vitest";
import { toSpeechText, SPEECH_MAX_CHARS, SUMMARY_MAX_CHARS } from "../../src/voice/text.js";

describe("toSpeechText", () => {
  it("vacío -> ''", () => {
    expect(toSpeechText("")).toBe("");
    expect(toSpeechText("   \n ")).toBe("");
  });
  it("markdown mixto", () => {
    const md = "# Título\n\nEsto es **negrita** y *cursiva* con [un enlace](http://x.com/a).\n\n- uno\n- dos\n";
    const out = toSpeechText(md);
    expect(out).toContain("Título");
    expect(out).toContain("Esto es negrita y cursiva con un enlace.");
    expect(out).toContain("uno");
    expect(out).not.toMatch(/[#*[\]]|http/);
  });
  it("bloques de código -> (código)", () => {
    const out = toSpeechText("Antes\n```ts\nconst a = 1;\n```\nDespués");
    expect(out).toContain("(código)");
    expect(out).not.toContain("const");
    expect(out).toContain("Después");
  });
  it("tablas: filas separadas por punto", () => {
    const out = toSpeechText("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(out).not.toContain("|");
    expect(out).not.toContain("---");
    expect(out).toBe("a, b. 1, 2. 3, 4.");
  });
  it("wiki links", () => {
    expect(toSpeechText("Ver [[Nota|alias]] y [[Otra]].")).toBe("Ver alias y Otra.");
  });
  it("URLs sueltas -> (enlace)", () => {
    expect(toSpeechText("Mira https://example.com/x?y=1 ahora")).toBe("Mira (enlace) ahora");
  });
  it("resumen: 5 oraciones -> 3", () => {
    const out = toSpeechText("Uno. Dos? Tres! Cuatro. Cinco.", { summary: true });
    expect(out).toBe("Uno. Dos? Tres!");
  });
  it("resumen corta en palabra a 400 chars", () => {
    const long = "palabra ".repeat(200).trim() + ".";
    const out = toSpeechText(long, { summary: true });
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out.endsWith("palabra")).toBe(true);
  });
  it("sin summary se limita a 2000", () => {
    const out = toSpeechText("palabra ".repeat(500));
    expect(out.length).toBeLessThanOrEqual(SPEECH_MAX_CHARS);
    expect(out.endsWith("palabra")).toBe(true);
  });

  describe("resumen: división en oraciones", () => {
    const sum = (t: string) => toSpeechText(t, { summary: true });
    it("no parte decimales ni versiones", () => {
      expect(sum("La versión 2.5 salió. Mide 0.3 s. Otra. Cuarta.")).toBe("La versión 2.5 salió. Mide 0.3 s. Otra.");
    });
    it("no corta en abreviaturas comunes", () => {
      expect(sum("Habló el Sr. García con la Dra. López. Fin uno. Fin dos. Fin tres.")).toBe(
        "Habló el Sr. García con la Dra. López. Fin uno. Fin dos.",
      );
      expect(sum("Por ej. Hoy llueve. Dos. Tres. Cuatro.")).toBe("Por ej. Hoy llueve. Dos. Tres.");
      expect(sum("Usa p. ej. Python. Dos. Tres. Cuatro.")).toBe("Usa p. ej. Python. Dos. Tres.");
      expect(sum("Vive en EE. UU. Desde 2020. Dos. Tres.")).toBe("Vive en EE. UU. Desde 2020. Dos. Tres.");
      expect(sum("Ver núm. 5 y aprox. 3. Dos. Tres. Cuatro.")).toBe("Ver núm. 5 y aprox. 3. Dos. Tres.");
    });
    it("maneja ¿?, ¡! y puntos suspensivos", () => {
      expect(sum("¿Listo? ¡Sí! Bueno… Y luego. Más.")).toBe("¿Listo? ¡Sí! Bueno…");
      expect(sum("Uno... Dos?! Tres. Cuatro.")).toBe("Uno... Dos?! Tres.");
    });
  });
  it("200k caracteres sin puntuación se procesan rápido (lineal)", () => {
    const big = "a ".repeat(100_000);
    const t0 = performance.now();
    toSpeechText(big, { summary: true });
    toSpeechText(big);
    toSpeechText("x. ".repeat(70_000), { summary: true });
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
