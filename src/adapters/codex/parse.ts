import type { AdapterExecutionResult } from "../../lib/types.js";
import type { RunProcessResult } from "../../lib/process-runner.js";

const TRANSIENT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests/i;

/**
 * Real Codex --json JSONL event format (confirmed from testing):
 *
 * {"type":"thread.started","thread_id":"..."}
 * {"type":"turn.started"}
 * {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 * {"type":"turn.completed","usage":{"input_tokens":N,"cached_input_tokens":N,"output_tokens":N,"reasoning_output_tokens":N}}
 * {"type":"error","message":"..."}
 * {"type":"turn.failed","error":{"message":"..."}}
 */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  message?: string;
  error?: { message?: string };
  [key: string]: unknown;
}

export function parse(proc: RunProcessResult): AdapterExecutionResult {
  let threadId: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  const textParts: string[] = [];
  let lastError: string | null = null;

  const lines = proc.stdout.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const evt: CodexEvent = JSON.parse(line);

      if (evt.thread_id) threadId = evt.thread_id;

      // Extract text from item.completed events
      if (evt.type === "item.completed" && evt.item?.text) {
        textParts.push(evt.item.text);
      }

      // Usage from turn.completed
      if (evt.type === "turn.completed" && evt.usage) {
        inputTokens = evt.usage.input_tokens || 0;
        outputTokens = evt.usage.output_tokens || 0;
      }

      // Error events
      if (evt.type === "error" && evt.message) {
        // The message might be a JSON string itself
        try {
          const inner = JSON.parse(evt.message);
          lastError = inner.error?.message || evt.message;
        } catch {
          lastError = evt.message;
        }
      }
      if (evt.type === "turn.failed" && evt.error?.message) {
        try {
          const inner = JSON.parse(evt.error.message);
          lastError = inner.error?.message || evt.error.message;
        } catch {
          lastError = evt.error.message;
        }
      }
    } catch {
      // not JSON, skip
    }
  }

  const summary = textParts.join("\n").trim() || (lastError ? `Error: ${lastError}` : proc.stdout.trim());

  const combined = proc.stdout + proc.stderr;
  const isTransient = TRANSIENT_RE.test(combined);
  let errorMessage: string | null = lastError;
  let errorFamily: string | null = null;

  if (proc.exitCode !== 0 && proc.exitCode !== null) {
    errorMessage = errorMessage || proc.stderr.trim() || `Process exited with code ${proc.exitCode}`;
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
    sessionId: threadId,
    model: null, // Codex doesn't report model in JSONL events
    costUsd: 0,  // Codex doesn't report cost in JSONL events
    inputTokens,
    outputTokens,
    errorMessage,
    errorFamily,
    retryNotBefore: null,
  };
}
