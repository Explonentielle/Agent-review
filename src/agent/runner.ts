/**
 * Interface d'exécution d'un agent : les pipelines (review, dev) décrivent une tâche, un exécuteur
 * la fait tourner. Aujourd'hui : la CLI Claude Code sur l'abonnement de l'utilisateur (CliRunner).
 * Demain : l'API Claude avec une clé (roadmap-plateforme, A3), ou un démon dans un conteneur (D6).
 */

export type AgentEventKind = "text" | "tool";

export interface AgentRequest {
  /** Dossier de travail de l'agent (worktree du dépôt). */
  cwd: string;
  systemPrompt: string;
  /** Contexte de la tâche, envoyé sans limite de taille d'argument. */
  prompt: string;
  /** JSON Schema de la sortie structurée. */
  outputSchema: Record<string, unknown>;
  /** Outils mis à disposition de l'agent. */
  tools: string[];
  /** Règles d'autorisation (syntaxe Claude Code), ex. `Bash(git status *)`. */
  allowedTools: string[];
  /** Règles d'interdiction explicites, en plus du refus par défaut. */
  disallowedTools: string[];
  model: string;
  effort: string;
  maxTurns: number;
  timeoutMs: number;
  /** Conserver la session pour pouvoir la reprendre (dev), ou non (review). */
  persistSession: boolean;
  /** Suivre la progression en direct (événements) plutôt qu'un résultat unique. */
  stream: boolean;
  signal?: AbortSignal;
  onEvent?: (kind: AgentEventKind, text: string) => void;
  onSession?: (sessionId: string) => void;
}

export interface AgentResult {
  /** Sortie structurée brute : à valider par l'appelant avec son schéma. */
  structured: unknown;
  sessionId: string | null;
  /** Estimation équivalent API : sur l'abonnement, un indicateur de consommation, pas une facture. */
  costUsd: number | null;
  numTurns: number | null;
}

export interface AgentRunner {
  run(request: AgentRequest): Promise<AgentResult>;
}

/**
 * Règles de sécurité communes à tous les exécuteurs. Elles ne sont pas des paramètres de la
 * requête : un appelant ne peut pas les affaiblir.
 */
export const ALWAYS_DENIED_TOOLS = ["mcp__*"];
