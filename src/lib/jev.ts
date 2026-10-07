import pino from "pino";

/**
 * Cliente mínimo de JEV (TypeSafe AI, modelo "System One": decisiones tipadas, no texto).
 * Nunca lanza: sin llave, con error de red/HTTP o respuesta inválida devuelve null y el llamador usa su alternativa.
 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_STATE_MAX_CHARS = 8000;

export interface JevQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string>;
}
export interface JevChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
export interface JevNoulAnswer { type: "noul"; noul: number }
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer;

export interface JevClient {
  configured(): boolean;
  ask(state: string, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer> | null>;
}

const log = pino({ name: "jev" });
const RETRY_STATUSES = new Set([429, 529]);

export function createJevClient(opts: { apiKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number; retryDelayMs?: number } = {}): JevClient {
  const key = () => (opts.apiKey !== undefined ? opts.apiKey : process.env.TYPESAFE_API_KEY ?? "").trim();
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryDelayMs = opts.retryDelayMs ?? 1_000;

  return {
    configured: () => key().length > 0,
    async ask(state, questions) {
      const apiKey = key();
      if (!apiKey) return null;
      const body = JSON.stringify({ state: state.slice(0, JEV_STATE_MAX_CHARS), model: JEV_MODEL, questions });
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await doFetch(JEV_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (RETRY_STATUSES.has(res.status) && attempt === 0) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
            continue;
          }
          if (!res.ok) {
            log.warn({ status: res.status }, "JEV respondió con error");
            return null;
          }
          const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
          return data && typeof data.answers === "object" && data.answers ? data.answers : null;
        } catch (err) {
          log.warn({ err: (err as Error).message }, "JEV no disponible");
          return null;
        }
      }
      return null;
    },
  };
}

export const jev: JevClient = createJevClient();
