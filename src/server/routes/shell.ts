import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { runProcess } from "../../lib/process-runner.js";
import { broadcast } from "../ws.js";

const app = new Hono();

// Active shell job kills
const activeJobs = new Map<string, () => void>();

// Run a shell command and stream output via WS
app.post("/run", async (c) => {
  const body = await c.req.json<{ command: string; cwd?: string }>();
  if (!body.command?.trim()) return c.json({ error: "command required" }, 400);

  const jobId = randomUUID();
  const cwd = body.cwd || process.cwd();

  broadcast({ type: "shell:start", jobId, command: body.command, timestamp: new Date().toISOString() } as any);

  (async () => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", body.command] : ["-c", body.command];

    const { promise, kill } = runProcess({
      command: shell,
      args: shellArgs,
      cwd,
      timeoutSec: 120,
      onStdout: (chunk) => {
        broadcast({ type: "shell:log", jobId, stream: "stdout", data: chunk, timestamp: new Date().toISOString() } as any);
      },
      onStderr: (chunk) => {
        broadcast({ type: "shell:log", jobId, stream: "stderr", data: chunk, timestamp: new Date().toISOString() } as any);
      },
    });

    activeJobs.set(jobId, kill);
    const result = await promise;
    activeJobs.delete(jobId);

    broadcast({
      type: "shell:done",
      jobId,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      timestamp: new Date().toISOString(),
    } as any);
  })();

  return c.json({ jobId }, 202);
});

// Kill a running shell job
app.post("/:jobId/kill", (c) => {
  const jobId = c.req.param("jobId");
  const kill = activeJobs.get(jobId);
  if (kill) { kill(); activeJobs.delete(jobId); return c.json({ ok: true }); }
  return c.json({ error: "job not found" }, 404);
});

export default app;
