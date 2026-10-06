import type { AdapterExecutionResult } from "../../lib/types.js";
import type { RunProcessResult } from "../../lib/process-runner.js";

const TRANSIENT_RE = /429|503|529|overloaded|rate.limit|capacity|too many requests/i;

interface ClaudeStreamMessage {
  type?: string;
  session_id?: string;
  model?: string;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  content?: string;
  message?: string;
  retry_not_before?: string;
}

export function parse(proc: RunProcessResult): AdapterExecutionResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let summary = "";
  let retryNotBefore: string | null = null;

  const lines = proc.stdout.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    try {
      const msg: ClaudeStreamMessage = JSON.parse(line);

      if (msg.session_id) sessionId = msg.session_id;
      if (msg.model) model = msg.model;
      if (msg.total_cost_usd != null) costUsd = msg.total_cost_usd;
      if (msg.usage) {
        if (msg.usage.input_tokens) inputTokens = msg.usage.input_tokens;
        if (msg.usage.output_tokens) outputTokens = msg.usage.output_tokens;
      }
      if (msg.result) summary = msg.result;
      if (msg.retry_not_before) retryNotBefore = msg.retry_not_before;
    } catch {
      // not JSON, skip
    }
  }

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
    costUsd,
    inputTokens,
    outputTokens,
    errorMessage,
    errorFamily,
    retryNotBefore,
  };
}
