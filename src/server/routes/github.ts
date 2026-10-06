import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { runProcess } from "../../lib/process-runner.js";
import { broadcast } from "../ws.js";
import { db, schema } from "../../db/index.js";
import fs from "node:fs";
import path from "node:path";

const app = new Hono();
const activeClones = new Map<string, () => void>();

function parseRepoName(url: string): string {
  // handles: owner/repo, https://github.com/owner/repo, git@github.com:owner/repo.git
  const clean = url.replace(/\.git$/, "");
  const parts = clean.replace("git@github.com:", "").replace(/https?:\/\/github\.com\//, "").split("/");
  return parts[parts.length - 1] || "repo";
}

// Clone a GitHub repo
app.post("/clone", async (c) => {
  const body = await c.req.json<{
    url: string;
    destination: string;
    createProject?: boolean;
    projectName?: string;
  }>();

  if (!body.url?.trim()) return c.json({ error: "url required" }, 400);
  if (!body.destination?.trim()) return c.json({ error: "destination required" }, 400);

  const jobId = randomUUID();
  const repoName = parseRepoName(body.url);
  const destPath = path.join(body.destination, repoName);

  broadcast({ type: "github:start", jobId, url: body.url, destination: destPath, timestamp: new Date().toISOString() } as any);

  (async () => {
    // Ensure destination parent exists
    try { fs.mkdirSync(body.destination, { recursive: true }); } catch { /* ignore */ }

    // Try gh first (handles private repos with stored auth), fall back to git clone
    const useGh = await isCommandAvailable("gh");
    let command: string;
    let args: string[];

    if (useGh) {
      command = "gh";
      args = ["repo", "clone", body.url, destPath];
    } else {
      command = "git";
      args = ["clone", body.url, destPath];
    }

    const { promise, kill } = runProcess({
      command,
      args,
      cwd: body.destination,
      timeoutSec: 300,
      onStdout: (chunk) => broadcast({ type: "github:log", jobId, stream: "stdout", data: chunk, timestamp: new Date().toISOString() } as any),
      onStderr: (chunk) => broadcast({ type: "github:log", jobId, stream: "stderr", data: chunk, timestamp: new Date().toISOString() } as any),
    });

    activeClones.set(jobId, kill);
    const result = await promise;
    activeClones.delete(jobId);

    const succeeded = result.exitCode === 0;

    let projectId: string | null = null;
    if (succeeded && body.createProject) {
      const name = body.projectName || repoName;
      projectId = randomUUID();
      await db.insert(schema.projects).values({
        id: projectId,
        name,
        path: destPath,
        description: `Clonado desde ${body.url}`,
      });
    }

    broadcast({
      type: "github:done",
      jobId,
      succeeded,
      destination: destPath,
      projectId,
      error: succeeded ? null : (result.stderr.slice(-500) || `Exit ${result.exitCode}`),
      timestamp: new Date().toISOString(),
    } as any);
  })();

  return c.json({ jobId, destination: destPath }, 202);
});

app.post("/:jobId/cancel", (c) => {
  const jobId = c.req.param("jobId");
  const kill = activeClones.get(jobId);
  if (kill) { kill(); activeClones.delete(jobId); return c.json({ ok: true }); }
  return c.json({ error: "job not found" }, 404);
});

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    const check = runProcess({
      command: process.platform === "win32" ? "where" : "which",
      args: [cmd],
      cwd: process.cwd(),
      timeoutSec: 5,
    });
    const result = await check.promise;
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export default app;
