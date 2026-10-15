// Tipos para importar worker.mjs desde los tests en TS.
import type { Server } from "node:http";
export declare const WORKER_VERSION: string;
export declare const WORKERS_DIR: string;
export declare function createWorker(opts: {
  account: string;
  key: string;
  root?: string;
  agyPath?: string;
  agyPrefixArgs?: string[];
}): Server;
