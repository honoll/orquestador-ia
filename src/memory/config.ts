import os from "node:os";
import path from "node:path";

export function memoryConfig(env: NodeJS.ProcessEnv = process.env): {
  vaultPath: string;
  ollamaUrl: string;
  model: string;
  writeDir: string;
} {
  return {
    vaultPath: env.CEREBRO_PATH || path.join(env.USERPROFILE || os.homedir(), "Documents", "Cerebro"),
    ollamaUrl: env.OLLAMA_URL || "http://127.0.0.1:11434",
    model: env.MEMORY_EMBED_MODEL || "bge-m3",
    writeDir: "Orquestador/Planes",
  };
}
