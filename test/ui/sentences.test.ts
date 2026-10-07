import { describe, it, expect } from "vitest";
import { createSentenceStreamer as serverStreamer } from "../../src/voice/assistant/text.js";
import { findSentenceEnd as serverFind } from "../../src/voice/text.js";
import { createSentenceStreamer as uiStreamer, findSentenceEnd as uiFind } from "../../ui/src/lib/sentences.js";

type Streamer = (onSentence: (s: string) => void) => { push(d: string): void; flush(): void };

const streamCases: { name: string; deltas: string[]; expected: string[]; afterFlush?: string[] }[] = [
  {
    name: "emite oraciones completas, sin cortar decimales, y nunca la marca",
    deltas: ["El", " mar es inmenso. El", " sonido 2.5 veces. ", "<<<ACCION plan {}>>>"],
    expected: ["El mar es inmenso.", "El sonido 2.5 veces."],
  },
  { name: "no corta abreviaturas", deltas: ["Habla con el Sr. Pérez hoy. Luego "], expected: ["Habla con el Sr. Pérez hoy."], afterFlush: ["Habla con el Sr. Pérez hoy.", "Luego"] },
  { name: "flush emite el resto", deltas: ["Hola. Qué ", "tal"], expected: ["Hola."], afterFlush: ["Hola.", "Qué tal"] },
  { name: "flush no emite marcas parciales", deltas: ["Listo. ¿Lo arranco? <<<ACC"], expected: ["Listo.", "¿Lo arranco?"] },
  { name: "cierres tras el signo", deltas: ['Dijo "vamos." Y '], expected: ['Dijo "vamos."'], afterFlush: ['Dijo "vamos."', "Y"] },
  { name: "una marca a medio llegar (<<) no se habla", deltas: ["Va. Oye <<"], expected: ["Va."], afterFlush: ["Va.", "Oye"] },
  { name: "carácter a carácter da lo mismo", deltas: [..."Hola. ¿Qué tal? Bien, 3.5 gracias."], expected: ["Hola.", "¿Qué tal?"], afterFlush: ["Hola.", "¿Qué tal?", "Bien, 3.5 gracias."] },
];

const findCases: { text: string; from?: number }[] = [
  { text: "Hola. Qué tal" },
  { text: "Sin final" },
  { text: "Valor 2.5 veces. Sigue" },
  { text: "El Dr. López llegó. Ok" },
  { text: 'Dijo "ya." Luego' },
  { text: "Hola.", from: 0 },
  { text: "Uno. Dos. Tres. ", from: 5 },
  { text: "¿Qué? ¡Sí! Bueno… vale\nfin" },
];

describe.each<[string, Streamer, (t: string, f?: number) => number]>([
  ["servidor", serverStreamer, serverFind],
  ["UI", uiStreamer, uiFind],
])("troceador de oraciones (%s)", (_name, make, find) => {
  it.each(streamCases)("$name", ({ deltas, expected, afterFlush }) => {
    const out: string[] = [];
    const s = make((x) => out.push(x));
    for (const d of deltas) s.push(d);
    expect(out).toEqual(expected);
    s.flush();
    expect(out).toEqual(afterFlush ?? expected);
  });

  it("flush deja el troceador reutilizable", () => {
    const out: string[] = [];
    const s = make((x) => out.push(x));
    s.push("Hola <<<ACCION x");
    s.flush();
    s.push("Otra. ");
    expect(out).toEqual(["Hola", "Otra."]);
  });

  it.each(findCases)("findSentenceEnd $text", ({ text, from }) => {
    expect(find(text, from)).toBe(serverFind(text, from));
  });
});

describe("la copia de la UI coincide con el servidor", () => {
  it("mismas salidas en todos los casos, entrega por entrega", () => {
    for (const c of streamCases) {
      const a: string[] = [];
      const b: string[] = [];
      const sa = serverStreamer((x) => a.push(x));
      const sb = uiStreamer((x) => b.push(x));
      for (const d of c.deltas) {
        sa.push(d);
        sb.push(d);
        expect(b).toEqual(a);
      }
      sa.flush();
      sb.flush();
      expect(b).toEqual(a);
    }
  });
});
