import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { AgentRunConfig } from "../claude/process.js";

/** Rapport final de l'agent dev (sortie structurée). */
export const DevResultSchema = z.object({
  /** done = implémenté ; blocked = ticket trop ambigu ou demande hors périmètre, rien ne sera poussé. */
  status: z.enum(["done", "blocked"]),
  /** Ce qui a été fait (repris dans la MR). Format imposé : voir la description, envoyée au modèle dans le schéma JSON. */
  summary: z
    .string()
    .describe("Markdown : une phrase d'introduction, une ligne vide, puis une puce par changement (- **Titre** : détail). Vrais retours à la ligne, jamais d'énumération (1) (2) dans un paragraphe."),
  /** Message de commit court, sans le numéro de ticket (ajouté par le template). */
  commit_message: z.string().describe("Une ligne courte, sans numéro de ticket."),
  /** Tests lancés et résultat, ou pourquoi ils ne l'ont pas été. */
  tests: z
    .string()
    .describe("Markdown : résultat des tests, ou une phrase expliquant pourquoi aucun n'a été lancé, une ligne vide, puis les étapes de recette manuelle en liste numérotée (1. ), une par ligne."),
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
  runner: AgentRunner;
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
export const FORBIDDEN_RULES = [
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
 * Lance l'agent dev, en streaming pour suivre sa progression. L'isolation vis-à-vis du dépôt
 * (hooks et MCP coupés, aucune invite de permission) est portée par l'exécuteur. La session est
 * conservée pour permettre `claude --resume <session>` depuis le worktree.
 */
export async function runDevAgent(input: DevEngineInput): Promise<DevEngineOutput> {
  const out = await input.runner.run({
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    outputSchema: devResultJsonSchema,
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    allowedTools: buildAllowedTools(input.allowedCommands),
    disallowedTools: FORBIDDEN_RULES,
    ...input.engine,
    persistSession: true,
    stream: true,
    signal: input.signal,
    onEvent: input.onEvent,
    onSession: input.onSession,
  });

  const parsed = DevResultSchema.safeParse(out.structured);
  if (!parsed.success) throw new Error(`Rapport de l'agent invalide : ${parsed.error.message}`);

  return { result: parsed.data, sessionId: out.sessionId, costUsd: out.costUsd, numTurns: out.numTurns };
}

export { describeMessage } from "../agent/events.js";
