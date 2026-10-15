import { describe, it, expect } from "vitest";
import { stripStepStatus } from "../../src/server/step-status.js";
import { stripStatusLine } from "../../ui/src/lib/step-status.js";

const cases: [string, string, string][] = [
  ["quita la línea final", "Listo.\n<<<ESTADO terminado>>>", "Listo."],
  ["quita con detalle y espacios finales", 'Hecho\n  <<<ESTADO necesita {"detalle":"una llave"}>>>  \n\n', "Hecho"],
  ["solo el bloque", "<<<ESTADO bloqueado>>>", ""],
  ["no toca un bloque a media respuesta", "Cita:\n<<<ESTADO terminado>>>\nY sigo.", "Cita:\n<<<ESTADO terminado>>>\nY sigo."],
  ["no toca un estado inválido", "Ok\n<<<ESTADO quizas>>>", "Ok\n<<<ESTADO quizas>>>"],
  ["no toca el bloque pegado al texto", "Ok <<<ESTADO terminado>>>", "Ok <<<ESTADO terminado>>>"],
  ["sin bloque solo recorta el final", "Hola\n\n", "Hola"],
];

describe("strip de la línea <<<ESTADO>>> (servidor y UI)", () => {
  for (const [impl, fn] of [["servidor", stripStepStatus], ["ui", stripStatusLine]] as const) {
    for (const [name, input, expected] of cases) {
      it(`${impl}: ${name}`, () => expect(fn(input)).toBe(expected));
    }
  }
});
