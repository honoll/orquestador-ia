import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema.js";

const DB_DIR = path.join(
  process.env.ORQUESTADOR_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".orquestador-ia"),
  "data",
);

fs.mkdirSync(DB_DIR, { recursive: true });

const DB_PATH = path.join(DB_DIR, "orquestador.db");

const client = createClient({ url: `file:${DB_PATH}` });

export const db = drizzle(client, { schema });
export { schema };
export { DB_PATH, DB_DIR };
