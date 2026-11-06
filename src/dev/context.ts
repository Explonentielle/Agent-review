import type { GitlabIssue, GitlabNote, GitlabProject } from "../gitlab/types.js";

const MAX_CLAUDE_MD_CHARS = 30_000;

export interface DevContextInput {
  project: GitlabProject;
  issue: GitlabIssue;
  notes: GitlabNote[];
  baseBranch: string;
  branch: string;
  /** CLAUDE.md du dépôt (non chargé automatiquement à cause de --safe-mode, transmis ici comme contexte). */
  claudeMd: string;
  extraInstructions: string | null;
}

/** Message utilisateur de l'agent dev : le ticket, sa discussion et le contexte du dépôt. */
export function buildDevPrompt(input: DevContextInput): string {
  const { project, issue, notes } = input;
  const parts: string[] = [];

  parts.push(`# Ticket #${issue.iid} : ${issue.title}`);
  parts.push(
    [
      `**Projet :** ${project.path_with_namespace}`,
      `**Branche de travail :** \`${input.branch}\` (créée depuis \`${input.baseBranch}\`, déjà extraite dans ton répertoire de travail)`,
      issue.labels.length ? `**Labels :** ${issue.labels.join(", ")}` : "",
      issue.milestone?.title ? `**Milestone :** ${issue.milestone.title}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  parts.push(`## Description du ticket\n${external(issue.description || "(pas de description)")}`);

  const discussion = notes.filter((n) => !n.system && n.body.trim());
  if (discussion.length > 0) {
    parts.push(
      "## Discussion du ticket (ordre chronologique)\n" +
        discussion.map((n) => `### ${n.author.name} (${n.created_at.slice(0, 10)})\n${external(n.body)}`).join("\n\n"),
    );
  }

  if (input.extraInstructions?.trim()) {
    parts.push(`## Consignes du développeur pour cette tâche\n${input.extraInstructions.trim()}`);
  }

  if (input.claudeMd.trim()) {
    const md = input.claudeMd.length > MAX_CLAUDE_MD_CHARS ? input.claudeMd.slice(0, MAX_CLAUDE_MD_CHARS) + "\n[... tronqué ...]" : input.claudeMd;
    parts.push(`## Conventions du dépôt (CLAUDE.md)\n${external(md)}`);
  }

  parts.push("Implémente ce ticket dans le dépôt, puis termine par ton rapport structuré.");
  return parts.join("\n\n");
}

/** Balise un texte écrit par des tiers : il décrit le besoin, il ne donne pas d'ordres à l'outil. */
function external(text: string): string {
  return `<contenu_externe>\n${text.replaceAll("</contenu_externe>", "</contenu_externe_>")}\n</contenu_externe>`;
}
