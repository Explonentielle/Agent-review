import { z } from "zod";

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
  review: { model: "claude-sonnet-5-5", effort: "high", maxTurns: 40, timeoutMin: 20 },
  dev: { model: "claude-sonnet-5-5", effort: "high", maxTurns: 120, timeoutMin: 45 },
  rules: {
    maxChangedLinesAuto: 800,
    sensitivePaths: ["migrations?/", "(^|/)auth", "payment", "paiement", "security", "\\.env"],
  },
  workflow: {
    todoLabels: [],
    inProgressLabels: [],
    techValidationLabels: ["Statut::Validation technique"],
    labelOnStart: "",
  },
  templates: {
    branch: "feature/{iid}-{slug}",
    commit: "#{iid} - {summary}",
    mrTitle: "Draft: #{iid} - {title}",
    mrDescription: "Related to #{iid}\n\n{summary}",
  },
};

/** Configuration d'un projet GitLab pour l'agent dev. */
export const ProjectSettingsSchema = z.object({
  projectId: z.number().int().positive(),
  path: z.string().min(1),
  devEnabled: z.boolean(),
  /** Branche de départ de la branche du ticket. */
  baseBranch: z.string().trim(),
  /** Branche cible de la MR (global, intermédiaire, master... selon le projet). */
  targetBranch: z.string().trim(),
  /** Commandes que l'agent a le droit de lancer (tests, lint). Une par entrée. */
  allowedCommands: z.array(z.string().trim().min(1)),
  /** Consignes de dev propres au projet. */
  instructions: z.string(),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
