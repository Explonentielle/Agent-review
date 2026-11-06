import type { GitlabCommit, GitlabCommitStatus, GitlabDiff, GitlabIssue, GitlabMergeRequest, GitlabProject } from "../gitlab/types.js";

/** Fichiers jamais envoyés en review (repris de timelog ReviewService::IGNORED_PATTERNS). */
export const IGNORED_PATTERNS: RegExp[] = [
  /composer\.lock$/,
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /mix-manifest\.json$/,
  /\.min\.(js|css)$/,
  /public\/(css|js)\/app\.(js|css)$/,
  /public\/hot$/,
  /\.map$/,
  /\.(png|jpe?g|gif|svg|ico|woff2?|ttf|eot)$/,
  /(^|\/)\.env(\.|$)/,
];

/**
 * Au-delà, le diff d'un fichier est coupé dans le prompt : sans perte réelle :
 * l'agent a le dépôt complet et peut lire le fichier avec l'outil Read.
 */
const MAX_DIFF_CHARS_PER_FILE = 40_000;

export function filterDiffs(diffs: GitlabDiff[]): GitlabDiff[] {
  return diffs.filter((d) => !IGNORED_PATTERNS.some((p) => p.test(d.new_path)));
}

/** Lignes ajoutées + supprimées (hors en-têtes de hunk). */
export function countChangedLines(diffs: GitlabDiff[]): number {
  let count = 0;
  for (const d of diffs) {
    for (const line of d.diff.split("\n")) {
      if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Tickets liés à une MR : `#123` dans le titre, ou dans la description
 * (conventions de timelog : titre "#163 - ...", description "Related to #123" / " #123").
 */
export function findLinkedIssueIids(mr: Pick<GitlabMergeRequest, "title" | "description">): number[] {
  const ids = new Set<number>();
  for (const text of [mr.title, mr.description ?? ""]) {
    for (const m of text.matchAll(/(?:^|[\s(])#(\d+)\b/g)) {
      ids.add(Number(m[1]));
    }
  }
  return [...ids];
}

export interface ReviewContextInput {
  project: GitlabProject;
  mr: GitlabMergeRequest;
  issues: GitlabIssue[];
  diffs: GitlabDiff[];
  commits: GitlabCommit[];
  statuses: GitlabCommitStatus[];
}

/** Message utilisateur envoyé à l'agent : métadonnées de la MR + diff. */
export function buildReviewPrompt({ project, mr, issues, diffs, commits, statuses }: ReviewContextInput): string {
  const parts: string[] = [];

  parts.push(`# Merge Request !${mr.iid} : ${mr.title}`);
  parts.push(
    [
      `**Projet :** ${project.path_with_namespace}`,
      `**Auteur :** ${mr.author.name}`,
      `**Source :** \`${mr.source_branch}\` → **Target :** \`${mr.target_branch}\``,
      `**Commit reviewé :** \`${mr.sha}\``,
    ].join("\n"),
  );
  parts.push(
    "Le dépôt est extrait dans ton répertoire de travail, au commit reviewé. " +
      "Utilise Read / Grep / Glob pour vérifier le contexte avant de conclure.",
  );

  if (project.description) {
    parts.push(`## Description du projet\n${untrusted(project.description)}`);
  }

  const issuesWithText = issues.filter((i) => i.description);
  if (issuesWithText.length > 0) {
    parts.push("## Tickets liés (intention attendue du changement)");
    for (const issue of issuesWithText) {
      parts.push(`### #${issue.iid} : ${issue.title}\n${untrusted(issue.description ?? "")}`);
    }
  }
  if (mr.description) {
    parts.push(`## Description de la MR\n${untrusted(mr.description)}`);
  }

  parts.push(`## Commits (${commits.length})\n` + commits.map((c) => `- \`${c.short_id}\` ${c.title} (${c.author_name})`).join("\n"));

  if (statuses.length > 0) {
    parts.push(`## Statuts CI (commit \`${mr.sha.slice(0, 8)}\`)\n` + statuses.map((s) => `- **${s.name}** : ${s.status}`).join("\n"));
  }

  parts.push(`## Changements (${diffs.length} fichiers, ${countChangedLines(diffs)} lignes modifiées)`);
  for (const d of diffs) {
    const tag = d.new_file ? "[NOUVEAU]" : d.deleted_file ? "[SUPPRIMÉ]" : d.renamed_file ? `[RENOMMÉ depuis ${d.old_path}]` : "[MODIFIÉ]";
    let diff = d.diff;
    if (diff.length > MAX_DIFF_CHARS_PER_FILE) {
      diff = diff.slice(0, MAX_DIFF_CHARS_PER_FILE) + `\n[... diff tronqué : lis ${d.new_path} en entier avec l'outil Read ...]`;
    }
    parts.push(`### ${tag} ${d.new_path}\n\`\`\`diff\n${diff}\n\`\`\``);
  }

  return parts.join("\n\n");
}

/**
 * Balise les textes rédigés par des humains (descriptions, tickets) : ce sont des données
 * qui informent la review, jamais des instructions à suivre (cf. prompts/review-system.md).
 */
function untrusted(text: string): string {
  const safe = text.replaceAll("</contenu_externe>", "</contenu_externe_>");
  return `<contenu_externe>\n${safe}\n</contenu_externe>`;
}
