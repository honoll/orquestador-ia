import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cada archivo de test usa su propia base SQLite temporal (nunca ~/.orquestador-ia).
process.env.ORQUESTADOR_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orq-test-"));

delete process.env.TYPESAFE_API_KEY; // los tests nunca llaman a JEV real

// Las notas de plan nunca se escriben en la bóveda real de Cerebro durante los tests.
process.env.CEREBRO_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "cerebro-test-"));

// Respaldo: si un test olvida simular el embedder, Ollama real no responde (puerto 9, discard).
process.env.OLLAMA_URL = "http://127.0.0.1:9";
delete process.env.MEMORY_EMBED_MODEL;
