import { untrusted } from "../scribe/prompt.js";
import type { PlanKind } from "../db/plans.js";

const MAX_TITLES = 15;
/** Les derniers messages suffisent : un échange plus long est coupé par le début. */
const MAX_MESSAGES = 40;

export interface PlanPromptInput {
  kind: PlanKind;
  project: { path: string; description: string | null };
  /** Titres de tickets ouverts du projet : pour éviter un doublon et imiter le style de l'équipe. */
  recentTitles: string[];
  /** Étiquettes que le plan a le droit de proposer. */
  allowedLabels: string[];
  /** Échange de cadrage, du plus ancien au plus récent. */
  messages: Array<{ role: "user" | "assistant"; text: string }>;
  /** Tickets du plan actuel (proposés, éventuellement corrigés par la personne) : le tour les reprend au lieu de repartir de zéro. */
  currentTickets: Array<{ title: string; description: string; labels: string[] }>;
}

/** Texte de la conversation, balisé : la fermeture de la balise ne peut pas être écrite dans un message. */
function conversation(messages: PlanPromptInput["messages"]): string {
  const lines = messages.slice(-MAX_MESSAGES).map((m) => `[${m.role === "user" ? "Personne" : "Orchestrateur"}]\n${m.text.replaceAll("</echange>", "</echange_>")}`);
  return `<echange>\n${lines.join("\n\n")}\n</echange>`;
}

/**
 * Prompt d'un tour du chat de cadrage.
 * @param input Projet, échange, étiquettes autorisées et plan actuel.
 * @returns Le texte envoyé à l'agent.
 */
export function buildPlanPrompt(input: PlanPromptInput): string {
  const titles = input.recentTitles.slice(0, MAX_TITLES);
  const current = input.currentTickets.length
    ? `Plan actuel (dans l'ordre ; la personne a pu le corriger à la main, reprends-le tel quel sauf si elle demande un changement) :\n${untrusted(
        input.currentTickets.map((t, i) => `${i + 1}. ${t.title}\n${t.description}`).join("\n\n"),
      )}`
    : "";
  return [
    input.kind === "project"
      ? "La personne veut faire développer un projet complet en une seule passe : le plan couvre tout le projet, du squelette aux fonctionnalités."
      : "La personne veut faire développer une fonctionnalité : le plan couvre cette fonctionnalité seulement.",
    `Projet cible : ${input.project.path}`,
    input.project.description ? `Description du projet :\n${untrusted(input.project.description)}` : "",
    titles.length ? `Tickets ouverts du projet (pour éviter les doublons et reprendre le style) :\n${untrusted(titles.map((t) => `- ${t}`).join("\n"))}` : "Aucun ticket ouvert dans ce projet.",
    input.allowedLabels.length ? `Étiquettes que tu peux proposer (aucune autre) : ${input.allowedLabels.join(" ; ")}` : "Aucune étiquette n'est proposée : laisse les listes vides.",
    conversation(input.messages),
    current,
    "Réponds à la dernière intervention de la personne.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
