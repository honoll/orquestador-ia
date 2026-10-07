import { memoryConfig } from "./config.js";

export type Embedder = (texts: string[]) => Promise<number[][] | null>;

interface Opts {
  url?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Cliente de embeddings de Ollama. Nunca lanza: ante cualquier fallo devuelve null. */
export function createOllamaEmbedder(opts: Opts = {}): Embedder {
  const cfg = memoryConfig();
  const url = (opts.url ?? cfg.ollamaUrl).replace(/\/+$/, "");
  const model = opts.model ?? cfg.model;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return async (texts) => {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        const res = await fetchImpl(`${url}/api/embed`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // keep_alive: el modelo queda cargado 30 min (la primera consulta de un plan no paga la carga).
          body: JSON.stringify({ model, input: texts, keep_alive: "30m" }),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { embeddings?: unknown };
        const emb = json?.embeddings;
        if (!Array.isArray(emb) || emb.length !== texts.length) return null;
        const dim = Array.isArray(emb[0]) ? emb[0].length : 0;
        const valid = dim > 0 && emb.every((v) =>
          Array.isArray(v) && v.length === dim && v.every((x) => typeof x === "number" && Number.isFinite(x)));
        if (!valid) return null;
        return emb as number[][];
      })();
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => { ctrl.abort(); resolve(null); }, timeoutMs);
      });
      return await Promise.race([work, timeout]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export async function ollamaHealth(opts: Omit<Opts, "timeoutMs"> = {}): Promise<{ ok: boolean; modelAvailable: boolean }> {
  const cfg = memoryConfig();
  const url = (opts.url ?? cfg.ollamaUrl).replace(/\/+$/, "");
  const model = opts.model ?? cfg.model;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, modelAvailable: false };
    const json = (await res.json()) as { models?: { name?: string }[] };
    const names = (json.models ?? []).map((m) => m.name ?? "");
    return { ok: true, modelAvailable: names.some((n) => n === model || n === `${model}:latest`) };
  } catch {
    return { ok: false, modelAvailable: false };
  }
}
