export interface AdapterMeta {
  type: string;
  label: string;
  command: string;
  models: readonly { id: string; label: string }[];
  defaultModel: string;
}

export interface AdapterDetectResult {
  available: boolean;
  resolvedPath: string | null;
  version?: string;
}

export interface AdapterExecutionContext {
  runId: string;
  prompt: string;
  model?: string;
  cwd: string;
  sessionId?: string;
  timeoutSec?: number;
  graceSec?: number;
  env?: Record<string, string>;
  claudeProfileEnv?: Record<string, string>; // env overrides for multi-account (e.g. ANTHROPIC_API_KEY)
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  onKill?: (kill: () => void) => void;
}

export interface AdapterExecutionResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  summary: string;
  sessionId: string | null;
  model: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  errorMessage: string | null;
  errorFamily: string | null;
  retryNotBefore: string | null;
}

export interface Adapter {
  meta: AdapterMeta;
  detect: () => Promise<AdapterDetectResult>;
  execute: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
}

export interface RunLogEvent {
  type: "log";
  runId: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
}

export interface RunStatusEvent {
  type: "run:status";
  runId: string;
  status: string;
  result?: AdapterExecutionResult;
  timestamp: string;
}

export interface AdapterStatusEvent {
  type: "adapters:status";
  adapters: Record<string, { available: boolean; resolvedPath: string | null }>;
  timestamp: string;
}

export type WsEvent = RunLogEvent | RunStatusEvent | AdapterStatusEvent;
