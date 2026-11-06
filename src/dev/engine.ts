import path from "node:path";
import { z } from "zod";
import { claudeEnv, runProcess, type AgentRunConfig } from "../claude/process.js";

/** Rapport final de l'agent dev (sortie structurée). */
export const DevResultSchema = z.object({
  /** done = implémenté ; blocked = ticket trop ambigu ou demande hors périmètre, rien ne sera poussé. */
  status: z.enum(["done", "blocked"]),
  /** Ce qui a été fait, en quelques phrases (repris dans la MR). */
  summary: z.string(),
  /** Message de commit court, sans le numéro de ticket (ajouté par le template). */
  commit_message: z.string(),
  /** Tests lancés et résultat, ou pourquoi ils ne l'ont pas été. */
  tests: z.string(),
  /** Points à vérifier en priorité par le relecteur. */
  notes_for_reviewer: z.array(z.string()),
  /** Questions ouvertes (obligatoires si status = blocked). */
  questions: z.array(z.string()),
});

export type DevResult = z.infer<typeof DevResultSchema>;

const devResultJsonSchema = z.toJSONSchema(DevResultSchema, { target: "draft-7" }) as Record<string, unknown>;

export interface DevEngineInput {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  engine: AgentRunConfig;
  /** Commandes autorisées pour ce projet (tests, lint), configurées dans le dashboard. */
  allowedCommands: string[];
  signal: AbortSignal;
  onEvent: (kind: "text" | "tool", text: string) => void;
  onSession: (sessionId: string) => void;
}

export interface DevEngineOutput {
  result: DevResult;
  sessionId: string | null;
  costUsd: number | null;
  numTurns: number | null;
}

/**
 * Interdictions explicites, en plus du refus par défaut de `dontAsk` : défense en profondeur
 * sur ce qui compte le plus (historique git, push, réseau).
 */
const FORBIDDEN_RULES = [
  "mcp__*",
  "WebFetch",
  "WebSearch",
  "Bash(git commit *)",
  "Bash(git push *)",
  "Bash(git reset *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git branch *)",
  "Bash(git remote *)",
  "Bash(git config *)",
  "Bash(curl *)",
  "Bash(wget *)",
  "Bash(ssh *)",
  "Bash(scp *)",
];

/**
 * Règles de permission : lecture/écriture de fichiers dans le worktree, consultation git en
 * lecture, et uniquement les commandes configurées pour le projet. Tout le reste est refusé
 * (`dontAsk`) : pas de commit/push (fait par l'outil après contrôle), pas de réseau.
 */
export function buildAllowedTools(allowedCommands: string[]): string[] {
  const rules = ["Read", "Grep", "Glob", "Edit", "Write", "Bash(git status *)", "Bash(git status)", "Bash(git diff *)", "Bash(git diff)", "Bash(git log *)"];
  for (const cmd of allowedCommands) {
    const clean = cmd.replace(/[()]/g, "").trim();
    if (!clean) continue;
    rules.push(`Bash(${clean})`, `Bash(${clean} *)`);
  }
  return rules;
}

/**
 * Lance l'agent dev via `claude -p` (abonnement), en streaming pour suivre sa progression.
 * Même isolation que la review (`--safe-mode`, aucun MCP). La session est conservée pour
 * permettre `claude --resume <session>` depuis le worktree.
 */
export async function runDevAgent(input: DevEngineInput): Promise<DevEngineOutput> {
  const { engine } = input;
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--json-schema", JSON.stringify(devResultJsonSchema),
    "--model", engine.model,
    "--effort", engine.effort,
    "--max-turns", String(engine.maxTurns),
    "--append-system-prompt", input.systemPrompt,
    "--tools", "Read,Grep,Glob,Edit,Write,Bash",
    "--allowedTools", ...buildAllowedTools(input.allowedCommands),
    "--disallowedTools", ...FORBIDDEN_RULES,
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--safe-mode",
    "--strict-mcp-config",
  ];

  let final: Record<string, unknown> | null = null;
  let sessionId: string | null = null;

  await runProcess(engine.claudeBin, args, input.prompt, {
    cwd: input.cwd,
    env: claudeEnv(),
    timeoutMs: engine.timeoutMs,
    signal: input.signal,
    onStdoutLine: (line) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof msg.session_id === "string" && msg.session_id !== sessionId) {
        sessionId = msg.session_id;
        input.onSession(sessionId);
      }
      if (msg.type === "result") final = msg;
      for (const ev of describeMessage(msg, input.cwd)) input.onEvent(ev.kind, ev.text);
    },
  });

  const result = final as Record<string, unknown> | null;
  if (!result) throw new Error("Claude Code s'est arrêté sans résultat final");
  if (result.is_error || result.subtype !== "success" || result.structured_output == null) {
    throw new Error(`Claude Code a échoué (${String(result.subtype ?? "inconnu")}) : ${String(result.result ?? "").slice(0, 800)}`);
  }
  const parsed = DevResultSchema.safeParse(result.structured_output);
  if (!parsed.success) throw new Error(`Rapport de l'agent invalide : ${parsed.error.message}`);

  return {
    result: parsed.data,
    sessionId,
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    numTurns: typeof result.num_turns === "number" ? result.num_turns : null,
  };
}

/** Transforme un message du flux stream-json en lignes lisibles pour le journal du dashboard. */
export function describeMessage(msg: Record<string, unknown>, cwd: string): Array<{ kind: "text" | "tool"; text: string }> {
  if (msg.type !== "assistant") return [];
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];

  const out: Array<{ kind: "text" | "tool"; text: string }> = [];
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
