import type { AgentRunner } from "../agent/runner.js";
import type { AgentRunConfig } from "../claude/process.js";
import { ReviewResultSchema, reviewResultJsonSchema, type ReviewResult } from "./schema.js";

export interface EngineInput {
  /** Worktree du dépôt au commit reviewé. */
  cwd: string;
  /** Règles de review, ajoutées au prompt système par défaut de Claude Code. */
  systemPrompt: string;
  /** Contexte de la MR (envoyé par stdin : pas de limite de taille d'argument). */
  prompt: string;
  engine: AgentRunConfig;
  runner: AgentRunner;
}

export interface EngineOutput {
  result: ReviewResult;
  /** Estimation côté client (équivalent API) : sur l'abonnement, c'est un indicateur de consommation, pas une facture. */
  costUsd: number | null;
  numTurns: number | null;
}

/** L'agent ne fait que lire : aucune écriture, aucune commande, aucun accès réseau. */
const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Lance l'agent de review, en lecture seule. L'exécuteur (`input.runner`) porte l'isolation vis-à-vis
 * du dépôt reviewé (hooks et MCP du dépôt coupés, aucune invite de permission) : voir `src/agent/cliRunner.ts`.
 * Usage perso : la CLI sur l'abonnement de l'utilisateur. Pour un déploiement à l'équipe : clé API
 * (roadmap-plateforme, A3).
 */
export async function runReviewAgent(input: EngineInput): Promise<EngineOutput> {
  const out = await input.runner.run({
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    prompt: input.prompt,
    outputSchema: reviewResultJsonSchema,
    tools: READ_ONLY_TOOLS,
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: [],
    ...input.engine,
    persistSession: false,
    stream: false,
  });

  const parsed = ReviewResultSchema.safeParse(out.structured);
  if (!parsed.success) throw new Error(`Sortie structurée invalide : ${parsed.error.message}`);

  return { result: parsed.data, costUsd: out.costUsd, numTurns: out.numTurns };
}
