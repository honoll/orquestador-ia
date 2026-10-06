import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cada archivo de test usa su propia base SQLite temporal (nunca ~/.orquestador-ia).
process.env.ORQUESTADOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orq-test-"));

delete process.env.TYPESAFE_API_KEY; // los tests nunca llaman a JEV real
