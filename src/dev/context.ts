import type { ChangeRequest, Comment, Project, Ticket } from "../connectors/types.js";
import type { DevResult } from "./engine.js";

const MAX_CLAUDE_MD_CHARS = 30_000;

export interface DevContextInput {
  project: Project;
  issue: Ticket;
  notes: Comment[];
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
      `**Projet :** ${project.path}`,
      `**Branche de travail :** \`${input.branch}\` (créée depuis \`${input.baseBranch}\`, déjà extraite dans ton répertoire de travail)`,
      issue.labels.length ? `**Labels :** ${issue.labels.join(", ")}` : "",
      issue.milestone ? `**Milestone :** ${issue.milestone}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  parts.push(`## Description du ticket\n${external(issue.description || "(pas de description)")}`);

  const discussion = notes.filter((n) => !n.system && n.body.trim());
  if (discussion.length > 0) {
    parts.push(
      "## Discussion du ticket (ordre chronologique)\n" +
        discussion.map((n) => `### ${n.author.name} (${n.createdAt.slice(0, 10)})\n${external(n.body)}`).join("\n\n"),
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

export interface FollowupContextInput {
  project: Project;
  issue: Ticket;
  mr: ChangeRequest;
  /** Commentaires de la MR (relecteurs, review IA) ; les messages système sont exclus ici. */
  mrNotes: Comment[];
  /** Rapport de la tâche reprise, s'il existe. */
  previousReport: DevResult | null;
  branch: string;
  targetBranch: string;
  claudeMd: string;
  /** Consignes du développeur pour cette reprise (obligatoires). */
  instructions: string;
}

/** Message utilisateur d'une reprise : appliquer des consignes au travail déjà poussé sur la branche de la MR. */
export function buildFollowupPrompt(input: FollowupContextInput): string {
  const { project, issue, mr } = input;
  const parts: string[] = [];

  parts.push(`# Reprise de la MR !${mr.iid} (ticket #${issue.iid} : ${issue.title})`);
  parts.push(
    [
      `**Projet :** ${project.path}`,
      `**Branche de travail :** \`${input.branch}\` (déjà extraite dans ton répertoire de travail, à jour avec le dépôt distant)`,
      `**MR :** !${mr.iid} vers \`${input.targetBranch}\``,
    ].join("\n"),
  );

  parts.push(
    "## Ce qu'on attend de toi\n" +
      "Le travail de la MR est déjà committé sur cette branche. Applique les consignes ci-dessous en modifiant ce travail existant : " +
      "ne repars pas de zéro et ne touche pas à ce que les consignes ne concernent pas.\n" +
      `Pour voir tous les changements de la MR : \`git diff origin/${input.targetBranch}...HEAD\` (ajoute \`--stat\` pour la liste des fichiers).`,
  );

  parts.push(`## Consignes du développeur pour cette reprise\n${input.instructions.trim()}`);

  parts.push(`## Description du ticket\n${external(issue.description || "(pas de description)")}`);

  if (input.previousReport) {
    const r = input.previousReport;
    const notes = r.notes_for_reviewer.length ? `\n\nPoints signalés au relecteur :\n${r.notes_for_reviewer.map((n) => `- ${n}`).join("\n")}` : "";
    parts.push(`## Rapport de l'agent qui a créé la MR\n${external(`${r.summary}${notes}`)}`);
  }

  const comments = input.mrNotes.filter((n) => !n.system && n.body.trim());
  if (comments.length > 0) {
    parts.push(
      "## Commentaires de la MR (ordre chronologique)\n" +
        comments
          .map((n) => {
            const where = n.position?.path ? ` sur \`${n.position.path}${n.position.line ? `:${n.position.line}` : ""}\`` : "";
            const state = n.resolvable ? (n.resolved ? " (résolu)" : " (non résolu)") : "";
            return `### ${n.author.name} (${n.createdAt.slice(0, 10)})${where}${state}\n${external(n.body)}`;
          })
          .join("\n\n"),
    );
  }

  if (input.claudeMd.trim()) {
    const md = input.claudeMd.length > MAX_CLAUDE_MD_CHARS ? input.claudeMd.slice(0, MAX_CLAUDE_MD_CHARS) + "\n[... tronqué ...]" : input.claudeMd;
    parts.push(`## Conventions du dépôt (CLAUDE.md)\n${external(md)}`);
  }

  parts.push("Applique les consignes, puis termine par ton rapport structuré. Dans `summary` et `commit_message`, décris uniquement ce que cette reprise a changé.");
  return parts.join("\n\n");
}

/** Balise un texte écrit par des tiers : il décrit le besoin, il ne donne pas d'ordres à l'outil. */
function external(text: string): string {
  return `<contenu_externe>\n${text.replaceAll("</contenu_externe>", "</contenu_externe_>")}\n</contenu_externe>`;
}
