import { createOllamaEmbedder, type Embedder } from "./ollama.js";

/** La consulta de recuperación (un solo embedding) no espera más de esto. */
export const MEMORY_QUERY_TIMEOUT_MS = 10_000;

/** Embedder de consultas de memoria (compartido por planes y asistente de voz). */
export function queryEmbedder(): Embedder {
  return createOllamaEmbedder({ timeoutMs: MEMORY_QUERY_TIMEOUT_MS });
}
