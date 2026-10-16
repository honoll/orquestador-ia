import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { TOKEN_TTL_MS } from "./constants.js";

export interface TokenScope { planId: string; stepId: string }

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

/** Token de un turno: 32 bytes aleatorios en hex; en la base solo queda su sha256. */
export async function issueRunToken(scope: TokenScope, now: number = Date.now()): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await db.insert(schema.teamRunTokens).values({
    tokenHash: hash(token), planId: scope.planId, stepId: scope.stepId, expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
  });
  return token;
}

export async function verifyRunToken(token: string | undefined, now: number = Date.now()): Promise<TokenScope | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const [row] = await db.select().from(schema.teamRunTokens).where(eq(schema.teamRunTokens.tokenHash, hash(token)));
  if (!row || Date.parse(row.expiresAt) <= now) return null;
  return { planId: row.planId, stepId: row.stepId };
}

export async function revokeRunToken(token: string): Promise<void> {
  await db.delete(schema.teamRunTokens).where(eq(schema.teamRunTokens.tokenHash, hash(token)));
}

export async function revokePlanTokens(planId: string): Promise<void> {
  await db.delete(schema.teamRunTokens).where(eq(schema.teamRunTokens.planId, planId));
}
