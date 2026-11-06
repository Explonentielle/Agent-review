import { claudeEnv, runProcess, type AgentRunConfig } from "../claude/process.js";
import { ReviewResultSchema, reviewResultJsonSchema, type ReviewResult } from "./schema.js";

export interface EngineInput {
  /** Worktree du dépôt au commit reviewé. */
  cwd: string;
  /** Règles de review, ajoutées au prompt système par défaut de Claude Code. */
  systemPrompt: string;
  /** Contexte de la MR (envoyé par stdin : pas de limite de taille d'argument). */
  prompt: string;
  engine: AgentRunConfig;
}

export interface EngineOutput {
  result: ReviewResult;
  /** Estimation côté client (équivalent API) : sur l'abonnement, c'est un indicateur de consommation, pas une facture. */
  costUsd: number | null;
  numTurns: number | null;
}

/** Résultat de `claude -p --output-format json`. */
interface CliResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
}

/** L'agent ne fait que lire : aucune écriture, aucune commande, aucun accès réseau. */
const READ_ONLY_TOOLS = "Read,Grep,Glob";

/**
 * Lance l'agent de review via la CLI Claude Code en mode headless (`claude -p`), authentifiée
 * avec l'abonnement de l'utilisateur. Usage perso uniquement : pour un déploiement à l'équipe,
 * basculer sur le Claude Agent SDK avec une clé API (cf. roadmap).
 *
 * Isolation vis-à-vis du dépôt reviewé : sans précaution, `claude -p` exécute les hooks de
 * `.claude/settings.json` et connecte les serveurs de `.mcp.json` présents dans le dépôt, et une
 * MR pourrait donc lancer des commandes sur ta machine. `--safe-mode` coupe CLAUDE.md, hooks,
 * plugins, skills et MCP (l'auth reste normale) ; `--strict-mcp-config` sans `--mcp-config` = aucun MCP.
 */
export async function runReviewAgent(input: EngineInput): Promise<EngineOutput> {
  const { engine } = input;
  const args = [
    "-p",
    "--output-format", "json",
    "--json-schema", JSON.stringify(reviewResultJsonSchema),
    "--model", engine.model,
    "--effort", engine.effort,
    "--max-turns", String(engine.maxTurns),
    "--append-system-prompt", input.systemPrompt,
    "--tools", READ_ONLY_TOOLS,
    "--allowedTools", READ_ONLY_TOOLS,
    "--disallowedTools", "mcp__*",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];

  const { stdout, stderr, exitCode } = await runProcess(engine.claudeBin, args, input.prompt, {
    cwd: input.cwd,
    env: claudeEnv(),
    timeoutMs: engine.timeoutMs,
  });

  const payload = parseCliOutput(stdout);
  if (!payload) {
    throw new Error(`Sortie de Claude Code illisible (code ${exitCode}) : ${(stderr || stdout).slice(0, 800)}`);
  }
  if (payload.is_error || payload.subtype !== "success" || payload.structured_output == null) {
    throw new Error(`Claude Code a échoué (${payload.subtype ?? "inconnu"}) : ${String(payload.result ?? stderr).slice(0, 800)}`);
  }

  const parsed = ReviewResultSchema.safeParse(payload.structured_output);
  if (!parsed.success) throw new Error(`Sortie structurée invalide : ${parsed.error.message}`);

  return { result: parsed.data, costUsd: payload.total_cost_usd ?? null, numTurns: payload.num_turns ?? null };
}

/** Objet résultat unique ; tolère aussi un tableau d'événements (mode verbose). */
function parseCliOutput(stdout: string): CliResult | null {
  try {
    const data = JSON.parse(stdout) as CliResult | CliResult[];
    if (Array.isArray(data)) return data.findLast((m) => m.type === "result") ?? null;
    return data;
  } catch {
    return null;
  }
}
