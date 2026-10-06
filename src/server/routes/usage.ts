import { Hono } from "hono";
import { db } from "../../db/index.js";
import { sql } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const app = new Hono();

interface ClaudeJsonlLine {
  type?: string;
  timestamp?: string;
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

/**
 * Parse real token usage from ~/.claude/projects/**\/*.jsonl files.
 * Sums all assistant messages within the rolling window.
 */
function readClaudeLocalUsage(windowHours: number): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  windowStart: string;
  oldestMsgAt: string | null;
} {
  const windowMs = windowHours * 60 * 60 * 1000;
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  const claudeDir = path.join(os.homedir(), ".claude", "projects");

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let oldestMsgAt: string | null = null;

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(claudeDir);
  } catch {
    return { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, totalTokens: 0, windowStart, oldestMsgAt };
  }

  for (const dir of projectDirs) {
    const dirPath = path.join(claudeDir, dir);
    let files: string[];
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue;
      files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      // Skip files not modified recently (fast pre-filter)
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < Date.now() - windowMs - 60_000) continue;
      } catch {
        continue;
      }

      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg: ClaudeJsonlLine = JSON.parse(trimmed);

          // Only count assistant messages with usage data
          if (msg.type !== "assistant") continue;
          if (!msg.timestamp || !msg.message?.usage) continue;
          if (msg.timestamp < windowStart) continue;

          const u = msg.message.usage;
          inputTokens += u.input_tokens ?? 0;
          outputTokens += u.output_tokens ?? 0;
          cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
          cacheReadTokens += u.cache_read_input_tokens ?? 0;

          if (!oldestMsgAt || msg.timestamp < oldestMsgAt) {
            oldestMsgAt = msg.timestamp;
          }
        } catch {
          // non-JSON line
        }
      }
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens,
    windowStart,
    oldestMsgAt,
  };
}

/**
 * GET /api/usage/summary?adapter=claude&windowHours=5
 *
 * For claude: reads real usage from ~/.claude/projects JSONL files.
 * For codex/agy: falls back to orchestrator runs table.
 * Also returns rateLimitResetsAt from orchestrator runs table.
 */
app.get("/summary", async (c) => {
  const adapter = c.req.query("adapter") || "claude";
  const windowHours = parseInt(c.req.query("windowHours") || "5", 10);

  // Rate-limit reset time from orchestrator runs (applies to all adapters)
  const limitRows = await db.all<{ retryNotBefore: string }>(sql`
    SELECT retry_not_before AS retryNotBefore
    FROM runs
    WHERE adapter = ${adapter}
      AND retry_not_before IS NOT NULL
      AND retry_not_before > datetime('now')
    ORDER BY retry_not_before DESC
    LIMIT 1
  `);
  const rateLimitResetsAt = limitRows[0]?.retryNotBefore ?? null;

  if (adapter === "claude") {
    // Real usage from local JSONL
    const local = readClaudeLocalUsage(windowHours);

    // Reset time estimate: oldest message in window + windowHours
    // (when the earliest token in this window was consumed, that's when it "expires")
    let windowResetsAt: string | null = null;
    if (local.oldestMsgAt) {
      windowResetsAt = new Date(
        new Date(local.oldestMsgAt).getTime() + windowHours * 60 * 60 * 1000
      ).toISOString();
    }

    return c.json({
      adapter,
      windowHours,
      windowStart: local.windowStart,
      inputTokens: local.inputTokens,
      outputTokens: local.outputTokens,
      cacheCreationTokens: local.cacheCreationTokens,
      cacheReadTokens: local.cacheReadTokens,
      totalTokens: local.totalTokens,
      costUsd: 0,
      runCount: null,
      // Separate: actual hard rate-limit (retry_not_before from failed run)
      rateLimitResetsAt,
      // Window reset: oldest message + 5h (when first token of window expires)
      windowResetsAt,
      source: "local_jsonl",
    });
  }

  // Codex / agy — orchestrator runs table
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  const agg = await db.all<{
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    runCount: number;
  }>(sql`
    SELECT
      COALESCE(SUM(input_tokens), 0)  AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(cost_usd), 0)      AS costUsd,
      COUNT(*)                        AS runCount
    FROM runs
    WHERE adapter = ${adapter}
      AND started_at >= ${windowStart}
  `);

  const { inputTokens = 0, outputTokens = 0, costUsd = 0, runCount = 0 } = agg[0] ?? {};

  return c.json({
    adapter,
    windowHours,
    windowStart,
    inputTokens,
    outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    runCount,
    rateLimitResetsAt,
    source: "orchestrator_db",
  });
});

const SERVER_STARTED_AT = new Date().toISOString();

/** GET /api/usage/session — tokens de todos los adapters desde que arrancó el servidor. */
app.get("/session", async (c) => {
  const runsRows = await db.all<{ tokens: number }>(sql`
    SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens
    FROM runs WHERE datetime(started_at) >= datetime(${SERVER_STARTED_AT})
  `);
  const analysisRows = await db.all<{ tokens: number }>(sql`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
    FROM agy_usage WHERE source = 'analysis' AND at >= ${SERVER_STARTED_AT}
  `);
  return c.json({ since: SERVER_STARTED_AT, tokens: Number(runsRows[0]?.tokens ?? 0) + Number(analysisRows[0]?.tokens ?? 0) });
});

export default app;
