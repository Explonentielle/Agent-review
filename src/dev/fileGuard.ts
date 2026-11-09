import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Contrôles déterministes des fichiers modifiés par l'agent, avant le commit et le push. Ils ne
 * dépendent pas du modèle et sont la base du contrôle d'un patch venant d'un conteneur
 * (roadmap-plateforme, D5).
 */

export interface FileLimits {
  /** Taille maximale d'un fichier modifié. */
  maxFileBytes: number;
  /** Taille cumulée maximale des fichiers modifiés. */
  maxTotalBytes: number;
}

export const DEFAULT_FILE_LIMITS: FileLimits = { maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 25 * 1024 * 1024 };

export type FileRule = "path" | "symlink" | "size" | "encoding";

export interface FileIssue {
  file: string;
  rule: FileRule;
  message: string;
}

export class FileGuardError extends Error {
  constructor(public readonly issues: FileIssue[]) {
    const shown = issues.slice(0, 5).map((i) => `${i.file} : ${i.message}`);
    const more = issues.length > shown.length ? ` (+${issues.length - shown.length} autre(s))` : "";
    super(`Push refusé : ${issues.length} fichier(s) contrôlé(s) en défaut. ${shown.join(" ; ")}${more}. Le travail reste dans le dossier local.`);
    this.name = "FileGuardError";
  }
}

/** Chemin sûr : relatif au dépôt, sans remontée, hors du dossier `.git`. */
export function checkPath(file: string): string | null {
  if (file.includes("\0")) return "chemin invalide";
  if (path.isAbsolute(file) || /^[A-Za-z]:[\\/]/.test(file)) return "chemin absolu";
  const segments = file.split(/[\\/]/);
  if (segments.includes("..")) return "chemin sortant du dépôt (..)";
  if (segments.some((s) => s.toLowerCase() === ".git")) return "chemin dans un dossier .git";
  return null;
}

const REPLACEMENT_CHAR = Buffer.from("�", "utf8");

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encodage préservé ? Les outils d'édition de l'agent lisent et écrivent en UTF-8. Sur un fichier
 * ISO-8859-1, chaque octet accentué devient le caractère de remplacement (U+FFFD) dans tout le
 * fichier, et l'accent d'origine est perdu définitivement.
 * @param base contenu au commit de base, ou null pour un fichier nouveau
 */
export function checkEncoding(base: Buffer | null, next: Buffer): string | null {
  if (isBinary(next) || (base && isBinary(base))) return null;

  const hadReplacement = base ? base.includes(REPLACEMENT_CHAR) : false;
  if (next.includes(REPLACEMENT_CHAR) && !hadReplacement) {
    return "contient le caractère de remplacement (U+FFFD) : accents corrompus ou fichier mal lu";
  }
  if (base && !isValidUtf8(base) && isValidUtf8(next) && next.some((b) => b >= 0x80)) {
    return "le fichier n'était pas en UTF-8 (ex. ISO-8859-1) et a été réécrit en UTF-8 : encodage modifié";
  }
  return null;
}

/**
 * Lien symbolique qui reste dans le dépôt ? Un lien absolu ou qui sort du dépôt pourrait faire
 * lire ou écrire ailleurs lors d'une application ultérieure du patch.
 */
async function checkSymlink(root: string, file: string): Promise<string | null> {
  const abs = path.join(root, file);
  let info;
  try {
    info = await lstat(abs);
  } catch {
    return null; // supprimé
  }
  if (!info.isSymbolicLink()) return null;

  const target = await readlink(abs);
  if (path.isAbsolute(target)) return `lien symbolique absolu (${target})`;
  const resolved = path.resolve(path.dirname(abs), target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return `lien symbolique sortant du dépôt (${target})`;
  return null;
}

export interface CheckFilesInput {
  /** Racine du dépôt de travail. */
  worktree: string;
  /** Fichiers ajoutés, modifiés ou supprimés (chemins relatifs). */
  changed: string[];
  /** Contenu brut d'un fichier au commit de base, ou null s'il n'existait pas. */
  readBase: (file: string) => Promise<Buffer | null>;
  limits?: FileLimits;
}

/** Retourne la liste des fichiers en défaut (vide si tout est conforme). */
export async function checkChangedFiles(input: CheckFilesInput): Promise<FileIssue[]> {
  const limits = input.limits ?? DEFAULT_FILE_LIMITS;
  const root = await realpath(input.worktree);
  const issues: FileIssue[] = [];
  let total = 0;

  for (const file of input.changed) {
    const badPath = checkPath(file);
    if (badPath) {
      issues.push({ file, rule: "path", message: badPath });
      continue; // inutile (et risqué) d'ouvrir un chemin douteux
    }

    const badLink = await checkSymlink(root, file);
    if (badLink) {
      issues.push({ file, rule: "symlink", message: badLink });
      continue;
    }

    let info;
    try {
      info = await lstat(path.join(root, file));
    } catch {
      continue; // fichier supprimé : rien à lire
    }
    if (!info.isFile()) continue;

    total += info.size;
    if (info.size > limits.maxFileBytes) {
      issues.push({ file, rule: "size", message: `${Math.round(info.size / 1024)} Ko, au-delà de la limite de ${Math.round(limits.maxFileBytes / 1024)} Ko` });
      continue;
    }

    const message = checkEncoding(await input.readBase(file), await readFile(path.join(root, file)));
    if (message) issues.push({ file, rule: "encoding", message });
  }

  if (total > limits.maxTotalBytes) {
    issues.push({ file: "(ensemble)", rule: "size", message: `${Math.round(total / 1024)} Ko au total, au-delà de la limite de ${Math.round(limits.maxTotalBytes / 1024)} Ko` });
  }
  return issues;
}
