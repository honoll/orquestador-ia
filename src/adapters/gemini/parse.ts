import type { AdapterExecutionResult } from "../../lib/types.js";
import type { RunProcessResult } from "../../lib/process-runner.js";

const TRANSIENT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests/i;

/**
 * Real Gemini CLI --output-format stream-json event format (confirmed from testing):
 *
 * {"type":"init","timestamp":"...","session_id":"...","model":"auto-gemini-3"}
 * {"type":"message","timestamp":"...","role":"user","content":"..."}
 * {"type":"message","timestamp":"...","role":"assistant","content":"...","delta":true}
 * {"type":"result","timestamp":"...","status":"success","stats":{"total_tokens":N,"input_tokens":N,"output_tokens":N,"cached":N,"input":N,"duration_ms":N,"tool_calls":N,"models":{...}}}
 */
interface GeminiEvent {
  type?: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  stats?: {
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cached?: number;
    duration_ms?: number;
    tool_calls?: number;
    models?: Record<string, any>;
  };
  [key: string]: unknown;
}

export function parse(proc: RunProcessResult): AdapterExecutionResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const textParts: string[] = [];

  const lines = proc.stdout.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const evt: GeminiEvent = JSON.parse(line);

      // Session info from init event
      if (evt.type === "init") {
        if (evt.session_id) sessionId = evt.session_id;
        if (evt.model) model = evt.model;
      }

      // Assistant message content
      if (evt.type === "message" && evt.role === "assistant" && evt.content) {
        textParts.push(evt.content);
      }

      // Stats from result event
      if (evt.type === "result" && evt.stats) {
        inputTokens = evt.stats.input_tokens || 0;
        outputTokens = evt.stats.output_tokens || 0;

        // Extract actual model used from stats.models keys
        if (evt.stats.models && !model?.startsWith("gemini-")) {
          const modelKeys = Object.keys(evt.stats.models);
          if (modelKeys.length > 0) {
            // Use the first non-lite model, or fallback to first
            model = modelKeys.find((k) => !k.includes("lite")) || modelKeys[0];
          }
        }
      }
    } catch {
      // Not JSON — accumulate as plain text
      if (line.trim()) {
        textParts.push(line);
      }
    }
  }

  const summary = textParts.join("").trim() || proc.stdout.trim();

  const combined = proc.stdout + proc.stderr;
  const isTransient = TRANSIENT_RE.test(combined);
  let errorMessage: string | null = null;
  let errorFamily: string | null = null;

  if (proc.exitCode !== 0 && proc.exitCode !== null) {
    errorMessage = proc.stderr.trim() || `Process exited with code ${proc.exitCode}`;
    errorFamily = isTransient ? "transient_upstream" : "unknown";
  }

  if (proc.timedOut) {
    errorMessage = "Process timed out";
    errorFamily = "timeout";
  }

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    stdout: proc.stdout,
    stderr: proc.stderr,
    summary,
    sessionId,
    model,
    costUsd: 0, // Gemini CLI doesn't report cost
    inputTokens,
    outputTokens,
    errorMessage,
    errorFamily,
    retryNotBefore: null,
  };
}
