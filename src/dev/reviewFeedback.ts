import type { ReviewResult } from "../review/schema.js";

/**
 * Relecture avant fusion, remise à l'agent dev quand la personne choisit « Corriger avec la relecture ».
 * Le texte de la relecture est de la SORTIE DE MODÈLE faite sur un code qui peut venir d'ailleurs : il est donc non fiable. Il est collé après un repère
 * dans les consignes de la reprise, et `buildFollowupPrompt` le range dans un bloc balisé comme contenu externe, jamais parmi les consignes de la personne.
 */

/** Sépare, dans les consignes d'une reprise, ce que la personne a écrit (avant) de la relecture de l'outil (après). */
export const REVIEW_MARKER = "\n\n<<<RELECTURE_DE_L_OUTIL>>>\n";

/** Taille maximale du texte de relecture remis à l'agent. */
const MAX_REVIEW_CHARS = 8000;

/** Consigne par défaut quand la personne n'a rien ajouté. */
export const DEFAULT_FIX_NOTE = "Corrige les points relevés par la relecture avant fusion.";

const SEVERITY_ORDER = { blocking: 0, important: 1, suggestion: 2 } as const;
const SEVERITY_LABEL = { blocking: "Bloquant", important: "Important", suggestion: "Suggestion" } as const;

/**
 * Met la relecture à plat pour l'agent : verdict, résumé, puis chaque point (le plus grave d'abord) avec son emplacement, son explication et sa suggestion.
 * @param result Résultat structuré de la relecture.
 * @returns Le texte, borné à `MAX_REVIEW_CHARS` caractères.
 */
export function reviewFeedback(result: ReviewResult): string {
  const lines: string[] = [`Verdict de la relecture : ${result.verdict}.`, `Résumé : ${result.summary.trim()}`];
  const findings = [...result.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  if (findings.length) {
    lines.push("", "Points relevés :");
    findings.forEach((f, i) => {
      lines.push(`${i + 1}. [${SEVERITY_LABEL[f.severity]}${f.confirmed ? "" : ", à vérifier"}] ${f.title} (${f.location})`, `   ${f.explanation.trim()}`);
      if (f.suggestion?.trim()) lines.push(`   Suggestion : ${f.suggestion.trim()}`);
    });
  }
  if (result.questions_for_author.length) lines.push("", "Questions posées à l'auteur :", ...result.questions_for_author.map((q) => `- ${q}`));
  const text = lines.join("\n");
  return text.length > MAX_REVIEW_CHARS ? `${text.slice(0, MAX_REVIEW_CHARS)}\n[... tronqué ...]` : text;
}

/**
 * Consignes d'une reprise « corriger avec la relecture » : la note de la personne (ou la consigne par défaut), puis la relecture après le repère.
 * @param note Ce que la personne a ajouté, peut être vide.
 * @param result Relecture du commit actuel de la MR.
 * @returns Les consignes à enregistrer dans la tâche de reprise.
 */
export function followupInstructions(note: string, result: ReviewResult): string {
  return `${note.trim() || DEFAULT_FIX_NOTE}${REVIEW_MARKER}${reviewFeedback(result)}`;
}

/**
 * @param instructions Consignes enregistrées dans une tâche de reprise.
 * @returns La note de la personne et, s'il y en a une, la relecture de l'outil.
 */
export function splitInstructions(instructions: string): { note: string; review: string } {
  const at = instructions.indexOf(REVIEW_MARKER);
  if (at < 0) return { note: instructions.trim(), review: "" };
  return { note: instructions.slice(0, at).trim(), review: instructions.slice(at + REVIEW_MARKER.length).trim() };
}
