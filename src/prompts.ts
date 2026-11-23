import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "./paths.js";
import type { ProjectSettings } from "./settings/schema.js";

export type AgentKind = "review" | "dev" | "scribe" | "planner";

/** Prompt de base livré avec l'outil : valeur par défaut, remplaçable dans le dashboard. */
const BASE_FILE: Record<AgentKind, string> = { review: "review-system.md", dev: "dev-system.md", scribe: "scribe-system.md", planner: "planner-system.md" };
/** Garde-fous toujours ajoutés en dernier, jamais remplaçables depuis le dashboard. */
const GUARDRAILS_FILE: Record<AgentKind, string> = { review: "review-guardrails.md", dev: "dev-guardrails.md", scribe: "scribe-guardrails.md", planner: "planner-guardrails.md" };
const INSTRUCTIONS_TITLE: Record<AgentKind, string> = {
  review: "Instructions spécifiques du reviewer",
  dev: "Consignes générales du développeur",
  scribe: "Consignes du scribe",
  planner: "Consignes de l'orchestrateur",
};

const readPrompt = (file: string) => readFile(path.join(PROJECT_ROOT, "prompts", file), "utf8");

export function readDefaultSystemPrompt(kind: AgentKind): Promise<string> {
  return readPrompt(BASE_FILE[kind]);
}

export interface SystemPromptParts {
  kind: AgentKind;
  /** Prompt de base : celui du dashboard s'il est renseigné, sinon le fichier par défaut. */
  base: string;
  guardrails: string;
  /** Consignes perso (Paramètres > Consignes des agents). */
  instructions: string;
  project: ProjectSettings | null;
  /** Blocs ajoutés avant les garde-fous (ex. commandes autorisées du projet). */
  extra?: string[];
}

/**
 * Ordre de priorité croissant : prompt de base < consignes perso < consignes du projet < garde-fous.
 * Les consignes l'emportent sur le prompt de base (PHPDoc exigée, style...), mais jamais sur les garde-fous.
 */
export function assembleSystemPrompt({ kind, base, guardrails, instructions, project, extra = [] }: SystemPromptParts): string {
  const parts = [base.trim()];
  if (instructions.trim()) {
    parts.push(`# ${INSTRUCTIONS_TITLE[kind]} (prioritaires sur les règles générales ci-dessus)\n\n${instructions.trim()}`);
  }
  if (project?.instructions.trim()) {
    parts.push(`# Consignes propres au projet ${project.path} (prioritaires sur les règles générales ci-dessus)\n\n${project.instructions.trim()}`);
  }
  parts.push(...extra, guardrails.trim());
  return parts.join("\n\n");
}

/** Relu à chaque exécution : une modification dans le dashboard ou dans prompts/ s'applique sans redémarrer. */
export async function loadSystemPrompt(
  kind: AgentKind,
  opts: { override: string; instructions: string; project: ProjectSettings | null; extra?: string[] },
): Promise<string> {
  const [base, guardrails] = await Promise.all([
    opts.override.trim() ? Promise.resolve(opts.override) : readDefaultSystemPrompt(kind),
    readPrompt(GUARDRAILS_FILE[kind]),
  ]);
  return assembleSystemPrompt({ kind, base, guardrails, instructions: opts.instructions, project: opts.project, extra: opts.extra });
}
