import { runProcess } from "../lib/process-runner.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MODEL_CATALOG, PLANNER_MODEL } from "../config/models.js";

export interface PlanStep {
  stepIndex: number;
  description: string;
  adapter: "claude" | "codex" | "gemini";
  model: string;
  reason: string;
  prompt: string;
}

interface ClaudeStreamMessage {
  type?: string;
  result?: string;
  content?: string;
  delta?: { text?: string };
}

const ADAPTER_DEFAULTS: Record<string, string> = Object.fromEntries(
  Object.entries(MODEL_CATALOG).map(([type, cat]) => [type, cat.defaultModel]),
);

const ROUTING_SYSTEM = `You are a planning agent for a local AI orchestrator that routes tasks to the best CLI tool.

Available adapters and their strengths:
- claude: architecture decisions, code review, complex reasoning, validation, writing, explanations
- codex: code generation, debugging, refactoring, direct implementation, file editing
- gemini: large codebase analysis, reading many files at once (huge context window), summarizing big codebases

Rules:
- Break the feature into 2-8 concrete subtasks
- Each subtask must have a self-contained prompt that the assigned CLI can execute headlessly (no user interaction)
- The prompt must include ALL context needed — assume the CLI has no prior knowledge
- Be specific: reference actual files, functions, patterns from the project if provided
- Sequence steps logically (analysis → design → implement → review)

Respond ONLY with valid JSON, no markdown fences:
{
  "steps": [
    {
      "description": "Short label (< 60 chars)",
      "adapter": "claude|codex|gemini",
      "model": "model-id or empty string for default",
      "reason": "One sentence explaining why this adapter",
      "prompt": "Full prompt for the CLI to execute"
    }
  ]
}`;

function buildPlanningPrompt(description: string, projectInfo?: { name: string; path: string; projectDescription?: string | null }): string {
  let prompt = `Feature to implement: ${description}\n\n`;

  if (projectInfo) {
    prompt += `Project context:\n- Name: ${projectInfo.name}\n- Path: ${projectInfo.path}\n`;
    if (projectInfo.projectDescription) {
      prompt += `- Description: ${projectInfo.projectDescription}\n`;
    }

    const skillPaths = [
      path.join(projectInfo.path, "SKILL.md"),
      path.join(projectInfo.path, ".claude", "SKILL.md"),
      path.join(projectInfo.path, "CONTEXT.md"),
      path.join(projectInfo.path, "README.md"),
    ];

    for (const sp of skillPaths) {
      try {
        const content = fs.readFileSync(sp, "utf8").slice(0, 4000);
        prompt += `\nProject skill/context file (${path.basename(sp)}):\n${content}\n`;
        break;
      } catch {
        // not found, try next
      }
    }
  }

  prompt += `\nDecompose this into concrete subtasks with the best adapter for each one.`;
  return prompt;
}

export function extractJsonFromOutput(stdout: string): any {
  const lines = stdout.split("\n").filter((l) => l.trim());
  let resultText = "";

  for (const line of lines) {
    try {
      const msg: ClaudeStreamMessage = JSON.parse(line);
      if (msg.result) resultText = msg.result;
      if (msg.type === "content_block_delta" && msg.delta?.text) {
        resultText += msg.delta.text;
      }
    } catch {
      // not JSON line
    }
  }

  if (!resultText) resultText = stdout;

  const match = resultText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in planner output");
  return JSON.parse(match[0]);
}

export interface GeneratePlanOptions {
  onStream?: (text: string) => void;
  onKillRegistered?: (kill: () => void) => void;
}

export async function generatePlan(
  description: string,
  cwd: string,
  projectInfo?: { name: string; path: string; projectDescription?: string | null },
  options?: GeneratePlanOptions,
): Promise<PlanStep[]> {
  const userPrompt = buildPlanningPrompt(description, projectInfo);

  // Write system prompt to a temp file to avoid Windows cmd.exe quoting issues with multi-line/JSON strings.
  // Using --system-prompt-file is safer than --system-prompt for complex prompts.
  const tmpSystemFile = path.join(os.tmpdir(), `orquestador-plan-sys-${Date.now()}.txt`);
  fs.writeFileSync(tmpSystemFile, ROUTING_SYSTEM, "utf8");

  const args = [
    "--print", "-",
    "--output-format", "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--model", PLANNER_MODEL,
    "--system-prompt-file", tmpSystemFile,
  ];

  // Run planner in a neutral temp dir so Claude doesn't auto-load any CLAUDE.md
  // from the project directory (which would interfere with our system prompt).
  // All project context is already embedded in the user prompt as text.
  const plannerCwd = os.tmpdir();

  // Stream stdout chunks, extracting text deltas for the UI
  const { promise, kill } = runProcess({
    command: "claude",
    args,
    cwd: plannerCwd,
    stdin: userPrompt,
    timeoutSec: 1800,
    onStdout: (chunk) => {
      if (!options?.onStream) return;
      // Extract readable text from stream-json chunks
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg: ClaudeStreamMessage = JSON.parse(trimmed);
          if (msg.type === "content_block_delta" && msg.delta?.text) {
            options.onStream(msg.delta.text);
          }
        } catch {
          // non-JSON stdout line, ignore
        }
      }
    },
  });

  options?.onKillRegistered?.(kill);

  const proc = await promise;

  // Clean up temp file
  try { fs.unlinkSync(tmpSystemFile); } catch { /* ignore */ }

  if (proc.exitCode !== 0 && !proc.timedOut) {
    const isRateLimit = !proc.stderr.trim() || /rate/i.test(proc.stderr);
    if (isRateLimit) {
      throw new Error("Rate limit de Claude alcanzado. Intenta en unos minutos.");
    }
    throw new Error(`Planner failed (exit ${proc.exitCode}): ${proc.stderr.slice(0, 500)}`);
  }

  if (proc.signal === "SIGTERM" || proc.signal === "SIGKILL") {
    throw new Error("cancelled");
  }

  const parsed = extractJsonFromOutput(proc.stdout);

  if (!Array.isArray(parsed.steps)) {
    throw new Error("Planner response missing 'steps' array");
  }

  return parsed.steps.map((s: any, i: number) => ({
    stepIndex: i,
    description: String(s.description ?? `Paso ${i + 1}`),
    adapter: (["claude", "codex", "gemini"].includes(s.adapter) ? s.adapter : "claude") as PlanStep["adapter"],
    model: String(s.model || ADAPTER_DEFAULTS[s.adapter] || ""),
    reason: String(s.reason ?? ""),
    prompt: String(s.prompt ?? s.description ?? ""),
  }));
}
