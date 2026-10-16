// Revisa el escenario local (OFFICE_ESCENARIO_DIR o C:\tools\escenario): validación del servidor + alcance desde el elevador.
import { escenarioDir, readEscenario } from "../src/server/escenario.js";
import { toFloorMap, unreachable } from "../ui/src/office/world/gen3";

const dir = process.argv[2] ?? escenarioDir();
const { pisos, warnings } = readEscenario(dir);
for (const w of warnings) console.error(`✗ ${w}`);
if (!pisos.length) {
  console.error(warnings.length ? "escenario inválido" : `sin escenario en ${dir}`);
  process.exit(1);
}
let malos = 0;
pisos.forEach((p, i) => {
  const f = toFloorMap(p, i + 1), u = unreachable(f);
  malos += u.length;
  console.log(`${u.length ? "✗" : "✓"} piso ${f.piso} · ${f.nombre} · ${p.ancho}×${p.alto}${u.length ? ` · inalcanzables: ${u.map((t) => t.join(",")).join(" ")}` : ""}`);
  console.log(f.filas.join("\n"));
});
process.exit(malos ? 1 : 0);
