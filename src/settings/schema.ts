import { z } from "zod";
import { DEFAULT_FORGE, FORGE_KINDS } from "../connectors/forges.js";

/**
 * Modèles autorisés. Plafond volontaire : Sonnet 5.5 au maximum, pour ne pas épuiser le quota
 * de l'abonnement partagé avec l'usage interactif de Claude Code. IDs complets uniquement :
 * un alias comme "sonnet" suivrait automatiquement les futurs modèles.
 */
export const ALLOWED_MODELS = ["claude-sonnet-5-5", "claude-haiku-4-5"] as const;
/** Effort plafonné à high (pas de xhigh/max). */
export const ALLOWED_EFFORTS = ["low", "medium", "high"] as const;

const labelList = z.array(z.string().trim().min(1));

export const AgentSettingsSchema = z.object({
  model: z.enum(ALLOWED_MODELS),
  effort: z.enum(ALLOWED_EFFORTS),
  maxTurns: z.number().int().min(5).max(300),
  timeoutMin: z.number().int().min(1).max(240),
});

/**
 * Réglages modifiables depuis le dashboard (page Paramètres), stockés en base.
 * Le .env ne contient que les secrets et ce qui dépend de la machine.
 */
export const SettingsSchema = z.object({
  actionMode: z.enum(["shadow", "comment", "auto"]),
  /** Connexion à Claude : abonnement de l'utilisateur, ou clé API (ANTHROPIC_API_KEY du .env, facturée à l'usage). */
  agentAuth: z.enum(["subscription", "api"]),
  /** Budget du mois en dollars, appliqué seulement en mode clé API (0 = aucune limite). */
  budget: z.object({ monthlyUsd: z.number().min(0).max(100_000) }),
  review: AgentSettingsSchema,
  dev: AgentSettingsSchema,
  rules: z.object({
    maxChangedLinesAuto: z.number().int().min(1),
    /** Regex de chemins qui forcent une revue humaine. */
    sensitivePaths: z.array(z.string().min(1)),
  }),
  workflow: z.object({
    todoLabels: labelList,
    inProgressLabels: labelList,
    techValidationLabels: labelList,
    /** Label posé sur le ticket quand l'agent démarre (vide = ne rien changer). */
    labelOnStart: z.string().trim(),
  }),
  /**
   * Consignes perso ajoutées à la fin des prompts système (prompts/*-system.md, génériques) :
   * stack, points d'attention, ce qu'il ne faut pas remonter. Propres à chaque utilisateur.
   */
  instructions: z.object({
    review: z.string(),
    dev: z.string(),
  }),
  /**
   * Prompt de base personnalisé, qui remplace prompts/*-system.md. Vide = fichier par défaut.
   * Les garde-fous (prompts/*-guardrails.md) restent toujours ajoutés, quoi qu'il contienne.
   */
  systemPrompts: z.object({
    review: z.string(),
    dev: z.string(),
  }),
  /** Variables : {iid} {slug} {title} {summary} */
  templates: z.object({
    branch: z.string().trim().min(1),
    commit: z.string().trim().min(1),
    mrTitle: z.string().trim().min(1),
    mrDescription: z.string(),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  actionMode: "shadow",
  agentAuth: "subscription",
  budget: { monthlyUsd: 0 },
  review: { model: "claude-sonnet-5-5", effort: "high", maxTurns: 40, timeoutMin: 20 },
  dev: { model: "claude-sonnet-5-5", effort: "high", maxTurns: 120, timeoutMin: 45 },
  rules: {
    maxChangedLinesAuto: 800,
    sensitivePaths: ["migrations?/", "(^|/)auth", "payment", "paiement", "security", "\\.env"],
  },
  workflow: {
    todoLabels: [],
    inProgressLabels: [],
    techValidationLabels: [],
    labelOnStart: "",
  },
  instructions: {
    review: [
      "## Stack et conventions",
      "",
      "- Identifie la stack et sa version (fichiers de dépendances, structure du dépôt) avant de juger. Respecte les conventions déjà en place dans le dépôt plutôt que des « bonnes pratiques » génériques.",
      "",
      "## Points d'attention systématiques",
      "",
      "- **Performance** : requêtes BDD dans des boucles (N+1), index manquants sur une colonne filtrée, gros volumes chargés en mémoire.",
      "- **Migrations** : réversibilité, impact sur les tables volumineuses, valeur par défaut des colonnes NOT NULL ajoutées.",
      "- **Sécurité** : secrets en dur, SQL construit par concaténation, validation des entrées, contrôle d'accès sur les nouvelles routes.",
      "",
      "## Ce que je ne veux PAS voir remonter",
      "",
      "- Remarques de formatage déjà couvertes par le linter de la CI.",
      "- Demandes de documentation sur du code auto-explicatif.",
      "- Refactoring ou modernisation hors du périmètre du ticket.",
    ].join("\n"),
    dev: [
      "- Identifie la stack et sa version avant de coder, et n'utilise que ce que cette version supporte.",
      "- Imite le style du code voisin (nommage, structure, façon d'écrire les requêtes) et respecte la config du linter du dépôt.",
      "- Pas de refactoring ni de modernisation hors du ticket.",
      "- Requêtes BDD : pas de requête dans une boucle, paramètres liés plutôt que concaténation.",
      "- Migrations : réversibles quand le projet en a.",
    ].join("\n"),
  },
  systemPrompts: { review: "", dev: "" },
  templates: {
    branch: "feature/{iid}-{slug}",
    commit: "#{iid} - {summary}",
    mrTitle: "Draft: #{iid} - {title}",
    mrDescription: "Related to #{iid}\n\n{summary}",
  },
};

/** Configuration d'un projet (GitLab ou GitHub) pour l'agent dev. */
export const ProjectSettingsSchema = z.object({
  /** Forge du projet : les réglages enregistrés avant la prise en charge de GitHub sont des projets GitLab. */
  source: z.enum(FORGE_KINDS).default(DEFAULT_FORGE),
  projectId: z.number().int().positive(),
  path: z.string().min(1),
  devEnabled: z.boolean(),
  /** Branche de départ de la branche du ticket. */
  baseBranch: z.string().trim(),
  /** Branche cible de la MR (global, intermédiaire, master... selon le projet). */
  targetBranch: z.string().trim(),
  /** Commandes que l'agent a le droit de lancer (tests, lint). Une par entrée. */
  allowedCommands: z.array(z.string().trim().min(1)),
  /** Consignes propres au projet (stack, conventions, pièges), ajoutées aux prompts de dev et de review. */
  instructions: z.string(),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
