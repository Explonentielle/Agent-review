import type { Diff } from "../connectors/types.js";

/** Plafonds de ce que le tableau de bord reçoit : un très gros diff ne doit pas figer le navigateur (la forge reste la référence pour le lire en entier). */
export const CODE_LIMITS = {
  /** Fichiers dont le contenu est renvoyé ; les suivants sont seulement comptés. */
  files: 80,
  /** Caractères de diff par fichier. */
  charsPerFile: 60_000,
  /** Caractères de diff pour toute la MR. */
  charsTotal: 400_000,
} as const;

export type CodeLimits = { [K in keyof typeof CODE_LIMITS]: number };

export type FileChange = "added" | "deleted" | "renamed" | "modified";

/** Un fichier de la MR, prêt à être affiché. */
export interface CodeFile {
  /** Chemin actuel (celui d'avant pour un fichier supprimé). */
  path: string;
  /** Ancien chemin d'un fichier renommé, sinon null. */
  oldPath: string | null;
  change: FileChange;
  added: number;
  removed: number;
  /** Diff unifié du fichier (blocs « @@ ... @@ »), vide pour un fichier binaire ou trop gros pour la forge. */
  diff: string;
  /** Vrai si le diff a été coupé par un plafond ou omis. */
  truncated: boolean;
}

export interface CodeView {
  files: CodeFile[];
  /** Nombre de fichiers de la MR, y compris ceux dont le contenu n'est pas renvoyé. */
  totalFiles: number;
  /** Fichiers au-delà du plafond : comptés, sans contenu. */
  omittedFiles: number;
  totalAdded: number;
  totalRemoved: number;
}

/**
 * Compte les lignes ajoutées et supprimées d'un diff unifié sans en-tête de fichier (blocs « @@ »), tel que le renvoient les forges.
 * @param diff Diff d'un fichier.
 * @returns Le nombre de lignes ajoutées et supprimées.
 */
export function countChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/**
 * Coupe un texte à une limite, sur une fin de ligne.
 * @param text Texte à couper.
 * @param max Nombre maximum de caractères.
 * @returns Le texte gardé et vrai s'il a été coupé.
 */
function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, max);
  const lastBreak = head.lastIndexOf("\n");
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, truncated: true };
}

/**
 * Prépare les diffs d'une MR pour l'affichage : type de changement, lignes ajoutées et supprimées, et contenu borné par fichier, par MR et en nombre de
 * fichiers. Les compteurs portent toujours sur le diff entier, même quand son contenu est coupé.
 * @param diffs Diffs lus chez la forge, dans son ordre.
 * @param limits Plafonds (ceux de `CODE_LIMITS` par défaut).
 * @returns Les fichiers affichables et les totaux de la MR.
 */
export function summarizeDiffs(diffs: Diff[], limits: CodeLimits = CODE_LIMITS): CodeView {
  const files: CodeFile[] = [];
  let used = 0;
  let totalAdded = 0;
  let totalRemoved = 0;
  for (const d of diffs) {
    const { added, removed } = countChanges(d.diff);
    totalAdded += added;
    totalRemoved += removed;
    if (files.length >= limits.files) continue;
    const kept = cut(d.diff, Math.min(limits.charsPerFile, limits.charsTotal - used));
    used += kept.text.length;
    const change: FileChange = d.isNew ? "added" : d.isDeleted ? "deleted" : d.isRenamed ? "renamed" : "modified";
    files.push({
      path: d.isDeleted ? d.oldPath : d.newPath,
      oldPath: d.isRenamed ? d.oldPath : null,
      change,
      added,
      removed,
      diff: kept.text,
      truncated: kept.truncated,
    });
  }
  return { files, totalFiles: diffs.length, omittedFiles: Math.max(0, diffs.length - files.length), totalAdded, totalRemoved };
}
