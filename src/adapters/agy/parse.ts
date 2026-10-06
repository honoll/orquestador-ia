import type { AdapterExecutionResult } from "../../lib/types.js";
import type { RunProcessResult } from "../../lib/process-runner.js";

const QUOTA_RE = /quota|resource[_ ]?exhausted|rate.?limit|\b429\b|too many requests|usage limit/i;
const TRANSIENT_RE = /\b503\b|\b529\b|overloaded|unavailable|capacity/i;

interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Formatos reales (agy 1.3.0, ver docs/superpowers/specs/2026-10-06-spike-agy.md):
 * - print json: una línea con AgyResult.
 * - stream-json: {"event":"init","conversation_id","init":{"model"}} ·
 *   {"event":"step_update","step_update":{"step_type":"agent_response","text_delta"}} ·
 *   {"event":"result","result":AgyResult}
 */
interface AgyEvent {
  event?: string;
  conversation_id?: string;
  init?: { model?: string };
  step_update?: { step_type?: string; text_delta?: string };
  result?: AgyResult;
  status?: string;
}

/** Hora de reinicio de cuota si el texto la trae (ISO o "in N hours/minutes"). */
export function extractResetAt(text: string, now: number): string | null {
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const rel = text.match(/\b(?:in|after|en)\s+(\d+)\s*(hours?|horas?|h|minutes?|minutos?|mins?|m)\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3_600_000 : n * 60_000;
    return new Date(now + ms).toISOString();
  }
  return null;
}

export function parse(proc: RunProcessResult, now: number = Date.now()): AdapterExecutionResult {
  let sessionId: string | null = null;
  let model: string | null = null;
  const deltas: string[] = [];
  let final: AgyResult | undefined;

  for (const line of proc.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: AgyEvent;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (evt.event === "init") {
      sessionId = evt.conversation_id ?? sessionId;
      model = evt.init?.model ?? model;
    } else if (evt.event === "step_update" && evt.step_update?.step_type === "agent_response" && evt.step_update.text_delta) {
      deltas.push(evt.step_update.text_delta);
    } else if (evt.event === "result" && evt.result) {
      final = evt.result;
    } else if (!evt.event && typeof evt.status === "string") {
      final = evt as AgyResult;
    }
  }
  if (final?.conversation_id) sessionId = final.conversation_id;

  const stderrText = proc.stderr.trim();
  const failed = final?.status === "ERROR" || !final || (proc.exitCode !== 0 && proc.exitCode !== null);

  let errorMessage: string | null = null;
  let errorFamily: string | null = null;
  let retryNotBefore: string | null = null;

  if (proc.timedOut) {
    errorMessage = "Process timed out";
    errorFamily = "timeout";
  } else if (failed) {
    errorMessage = final?.error || stderrText.replace(/^error:\s*/i, "") || `Process exited with code ${proc.exitCode}`;
    const text = `${errorMessage}\n${stderrText}`;
    if (QUOTA_RE.test(text)) {
      errorFamily = "quota_exhausted";
      retryNotBefore = extractResetAt(text, now);
    } else if (TRANSIENT_RE.test(text)) {
      errorFamily = "transient_upstream";
    } else {
      errorFamily = "unknown";
    }
  }

  return {
    exitCode: failed && proc.exitCode === 0 ? 1 : proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    stdout: proc.stdout,
    stderr: proc.stderr,
    summary: (final?.response ?? deltas.join("")).trim(),
    sessionId,
    model,
    costUsd: 0, // agy no reporta costo
    inputTokens: final?.usage?.input_tokens ?? 0,
    outputTokens: final?.usage?.output_tokens ?? 0,
    errorMessage,
    errorFamily,
    retryNotBefore,
  };
}
