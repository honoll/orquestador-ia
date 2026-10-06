import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { execute } from "../../adapters/gemini/execute.js";
import { broadcast } from "../ws.js";

const app = new Hono();

/**
 * POST /api/gemini/analyze
 * Runs Gemini synchronously to analyze attached files in the context of the user prompt.
 * Used as a pre-processing step before sending to any adapter.
 */
app.post("/analyze", async (c) => {
  const body = await c.req.json<{
    files: { path: string; content: string; truncated?: boolean }[];
    prompt: string;
    cwd?: string;
  }>();

  if (!body.files || body.files.length === 0) {
    return c.json({ error: "No files provided" }, 400);
  }

  const fileSection = body.files
    .map((f) => `--- File: ${f.path} ---\n${f.content}${f.truncated ? "\n[...truncated]" : ""}`)
    .join("\n\n");

  const analysisPrompt =
    `You are a file analysis assistant. The user has attached files and wants help with the following task:\n\n` +
    `User task: "${body.prompt}"\n\n` +
    `Analyze the files below and provide a concise structured context that will help another AI assistant answer the user's task. Include:\n` +
    `- Purpose and role of each file\n` +
    `- Key functions, classes, variables, or data structures relevant to the task\n` +
    `- Relationships between files\n` +
    `- Any important patterns, issues, or notes the assistant should know\n\n` +
    `Files:\n${fileSection}\n\n` +
    `Be concise. This summary will be prepended as context for the answering assistant.`;

  const jobId = randomUUID();

  try {
    const result = await execute({
      runId: jobId,
      prompt: analysisPrompt,
      cwd: body.cwd || process.cwd(),
      timeoutSec: 120,
      onLog: (stream, chunk) => {
        broadcast({
          type: "gemini:analyze:log",
          jobId,
          stream,
          data: chunk,
          timestamp: new Date().toISOString(),
        } as any);
      },
    });

    const analysis = result.summary || result.stdout;
    if (!analysis?.trim()) {
      return c.json({ error: "Gemini returned empty analysis", fallback: true }, 200);
    }

    return c.json({ analysis: analysis.trim(), jobId });
  } catch (err: any) {
    return c.json({ error: err.message, fallback: true }, 200);
  }
});

export default app;
