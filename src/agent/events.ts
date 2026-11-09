import path from "node:path";
import type { AgentEventKind } from "./runner.js";

/** Transforme un message du flux stream-json en lignes lisibles pour le journal du dashboard. */
export function describeMessage(msg: Record<string, unknown>, cwd: string): Array<{ kind: AgentEventKind; text: string }> {
  if (msg.type !== "assistant") return [];
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];

  const out: Array<{ kind: AgentEventKind; text: string }> = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.push({ kind: "text", text: block.text.trim() });
    } else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
      out.push({ kind: "tool", text: toolLabel(String(block.name), (block.input ?? {}) as Record<string, unknown>, cwd) });
    }
  }
  return out;
}

function toolLabel(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => (typeof p === "string" ? path.relative(cwd, p) || p : "");
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return `${name} ${rel(input.file_path)}`;
    case "Grep":
      return `Grep "${String(input.pattern ?? "")}"${input.path ? ` dans ${rel(input.path)}` : ""}`;
    case "Glob":
      return `Glob ${String(input.pattern ?? "")}`;
    case "Bash":
      return `$ ${String(input.command ?? "")}`;
    default:
      return name;
  }
}
