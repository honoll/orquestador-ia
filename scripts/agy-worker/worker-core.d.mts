// Tipos para importar worker-core.mjs desde los tests en TS.
export declare const MAX_TIMEOUT_SEC: number;
export declare function buildAgyArgs(model?: string, conversationId?: string, opts?: { readOnly?: boolean }): string[];
export declare function buildAgyStdin(prompt: string): string;
export declare function withoutSecrets(env: Record<string, string | undefined>): Record<string, string | undefined>;
export declare function checkKey(header: string | undefined, key: string): boolean;
export declare function resolveCwd(cwd: unknown, root: string): string | null;
export interface RunBody { prompt: string; cwd: string; model?: string; readOnly: boolean; timeoutSec: number; env?: Record<string, string>; sessionId?: string }
export declare function parseRunBody(body: unknown): RunBody | null;
export declare function createBusy(): { tryAcquire(): boolean; release(): void; readonly busy: boolean };
