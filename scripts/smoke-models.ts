import os from "node:os";
import { adapters } from "../src/adapters/registry.js";
import { MODEL_CATALOG, type AdapterType } from "../src/config/models.js";

const only = process.argv[2] as AdapterType | undefined;
const rows: { adapter: string; model: string; ok: boolean; detalle: string }[] = [];

for (const [type, cat] of Object.entries(MODEL_CATALOG) as [AdapterType, (typeof MODEL_CATALOG)[AdapterType]][]) {
  if (only && type !== only) continue;
  const adapter = adapters[type];
  const found = await adapter.detect();
  if (!found.available) {
    rows.push({ adapter: type, model: "-", ok: false, detalle: "CLI no encontrado en PATH" });
    continue;
  }
  for (const m of cat.models) {
    const r = await adapter.execute({
      runId: `smoke-${type}-${m.id}`,
      prompt: "Responde solo con la palabra: ok",
      model: m.id,
      cwd: os.tmpdir(),
      timeoutSec: 180,
      onLog: () => {},
    });
    const ok = r.exitCode === 0 && !r.errorMessage && /^ok.?$/i.test(r.summary.trim());
    rows.push({ adapter: type, model: m.id, ok, detalle: ok ? `${r.inputTokens}/${r.outputTokens} tok` : (r.errorMessage ?? r.summary).slice(0, 120) });
  }
}

console.table(rows);
process.exit(rows.every((r) => r.ok) ? 0 : 1);
