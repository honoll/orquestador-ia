/**
 * Parses accumulated JSONL streaming output from different CLI adapters
 * and extracts human-readable text for live display.
 *
 * Real formats confirmed from testing:
 * - Claude: stream-json with content_block_delta, result events
 * - Codex: JSONL with item.completed { item: { text: "..." } }
 * - agy: stream-json with step_update { step_type: "agent_response", text_delta: "..." }
 */

export function parseStreamingText(raw: string, adapter: string): string {
  if (!raw.trim()) return "";

  const lines = raw.split("\n").filter((l) => l.trim());
  const textParts: string[] = [];

  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      const text = extractText(evt, adapter);
      if (text) textParts.push(text);
    } catch {
      // Not JSON — skip JSON-looking fragments, show plain text
      if (!line.trim().startsWith("{")) {
        textParts.push(line);
      }
    }
  }

  // Don't fallback to raw — it's usually JSONL that shouldn't be shown to the user
  return textParts.join("");
}

function extractText(evt: Record<string, any>, adapter: string): string | null {
  switch (adapter) {
    case "claude":
      return extractClaudeText(evt);
    case "codex":
      return extractCodexText(evt);
    case "agy":
      return extractAgyText(evt);
    default:
      return evt.text || evt.content || evt.result || null;
  }
}

function extractClaudeText(evt: Record<string, any>): string | null {
  // Claude stream-json events:
  // { type: "content_block_delta", delta: { text: "..." } }
  // { type: "assistant", message: { content: [{ type: "text", text: "..." }] } }
  // { type: "result", result: "..." }
  if (evt.type === "content_block_delta" && evt.delta?.text) {
    return evt.delta.text;
  }
  if (evt.type === "assistant" && evt.message?.content) {
    const content = evt.message.content;
    if (Array.isArray(content)) {
      return content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    }
    if (typeof content === "string") return content;
  }
  if (evt.type === "result" && typeof evt.result === "string") {
    return evt.result;
  }
  return null;
}

function extractCodexText(evt: Record<string, any>): string | null {
  // Real Codex JSONL format:
  // { type: "item.completed", item: { type: "agent_message", text: "..." } }
  if (evt.type === "item.completed" && evt.item?.text) {
    return evt.item.text;
  }
  return null;
}

function extractAgyText(evt: Record<string, any>): string | null {
  // agy stream-json: { event: "step_update", step_update: { step_type: "agent_response", text_delta: "..." } }
  if (evt.event === "step_update" && evt.step_update?.step_type === "agent_response" && evt.step_update.text_delta) {
    return evt.step_update.text_delta;
  }
  return null;
}
