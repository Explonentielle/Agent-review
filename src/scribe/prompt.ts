/** Ce que l'agent Scribe reçoit : l'idée de la personne, et du contexte balisé comme donnée non fiable. */

const MAX_TITLES = 15;

/** Balise un texte écrit par un tiers : une donnée qui informe le brouillon, jamais une instruction. */
function untrusted(text: string): string {
  return `<contenu_externe>\n${text.replaceAll("</contenu_externe>", "</contenu_externe_>")}\n</contenu_externe>`;
}

const idea = (text: string): string => `<demande>\n${text.replaceAll("</demande>", "</demande_>")}\n</demande>`;

export interface TicketPromptInput {
  idea: string;
  project: { path: string; description: string | null };
  /** Titres de tickets ouverts du projet : pour éviter un doublon et imiter le style de l'équipe. */
  recentTitles: string[];
  /** Étiquettes que le brouillon a le droit de proposer. */
  allowedLabels: string[];
}

/**
 * Prompt de rédaction d'un ticket.
 * @param input Idée, projet cible, tickets récents et étiquettes autorisées.
 * @returns Le texte envoyé à l'agent.
 */
export function buildTicketPrompt(input: TicketPromptInput): string {
  const titles = input.recentTitles.slice(0, MAX_TITLES);
  return [
    "Rédige le brouillon d'UN ticket pour la demande ci-dessous.",
    idea(input.idea),
    `Projet cible : ${input.project.path}`,
    input.project.description ? `Description du projet :\n${untrusted(input.project.description)}` : "",
    titles.length ? `Tickets ouverts du projet (pour éviter les doublons et reprendre le style) :\n${untrusted(titles.map((t) => `- ${t}`).join("\n"))}` : "Aucun ticket ouvert dans ce projet.",
    input.allowedLabels.length ? `Étiquettes que tu peux proposer (aucune autre) : ${input.allowedLabels.join(" ; ")}` : "Aucune étiquette n'est proposée : laisse la liste vide.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface ProjectPromptInput {
  idea: string;
  /** Chemins des projets déjà visibles par la personne : pour signaler un doublon. */
  existingProjects: string[];
}

/**
 * Prompt de rédaction d'un nouveau projet avec ses premiers tickets.
 * @param input Idée et projets existants.
 * @returns Le texte envoyé à l'agent.
 */
export function buildProjectPrompt(input: ProjectPromptInput): string {
  const existing = input.existingProjects.slice(0, 30);
  return [
    "Propose un nouveau projet (nom, description, trois à cinq premiers tickets) pour la demande ci-dessous.",
    idea(input.idea),
    existing.length ? `Projets déjà existants (signale un doublon possible dans les questions) :\n${untrusted(existing.map((p) => `- ${p}`).join("\n"))}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
