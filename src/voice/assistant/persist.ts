import { randomUUID } from "node:crypto";
import { db, schema } from "../../db/index.js";
import { broadcast } from "../../server/ws.js";
import { AGY_VOICE_MODEL } from "../../config/models.js";

export type SavedTurn = {
  conversationId: string;
  projectId: string | null;
  prompt: string;
  speech: string;
  ok: boolean;
  error?: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  now: number;
};

/**
 * Guarda el turno como una conversación más del chat (task + run), para que la UI lo muestre.
 * Nunca lanza: la persistencia no debe tumbar la plática.
 */
export async function saveTurn(t: SavedTurn): Promise<void> {
  try {
    const taskId = randomUUID();
    const runId = randomUUID();
    const status = t.ok ? "succeeded" : "failed";
    await db.insert(schema.tasks).values({
      id: taskId,
      projectId: t.projectId,
      conversationId: t.conversationId,
      title: t.prompt.slice(0, 80),
      prompt: t.prompt,
      status,
      adapter: "agy",
      model: AGY_VOICE_MODEL,
    });
    await db.insert(schema.runs).values({
      id: runId,
      taskId,
      adapter: "agy",
      model: AGY_VOICE_MODEL,
      status,
      prompt: t.prompt,
      result: t.speech,
      summary: t.speech,
      exitCode: t.ok ? 0 : 1,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      errorMessage: t.ok ? null : (t.error ?? "error").slice(0, 2000),
      startedAt: new Date(t.startedAt).toISOString(),
      finishedAt: new Date(t.now).toISOString(),
    });
    broadcast({ type: "run:status", runId, status, timestamp: new Date(t.now).toISOString() });
  } catch (err) {
    console.error("[voz] no se pudo guardar el turno:", (err as Error)?.message);
  }
}
