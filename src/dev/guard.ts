/**
 * Garde-fous du push de l'agent dev. Règle : l'outil ne pousse QUE sur la branche qu'il vient
 * de créer pour le ticket. Jamais sur une branche de base, cible, protégée ou partagée.
 * Ces vérifications sont faites dans le code avant tout push, indépendamment du modèle.
 */
import { ATTACHMENTS_DIRNAME } from "../attachments/rules.js";

/** Noms de branches partagées refusés quoi qu'il arrive (en plus des réglages et des protections GitLab). */
const ALWAYS_FORBIDDEN = ["master", "main", "develop", "development", "global", "intermediaire", "intermédiaire", "staging", "preprod", "production", "prod"];

export class BranchGuardError extends Error {
  constructor(message: string) {
    super(`Push refusé : ${message}`);
    this.name = "BranchGuardError";
  }
}

/** Correspondance des motifs de branches protégées GitLab (`*` = joker). */
export function matchesBranchPattern(pattern: string, branch: string): boolean {
  const regex = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return regex.test(branch);
}

export function assertBranchAllowed(branch: string, ctx: { issueIid: number; forbidden: string[] }): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..") || branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new BranchGuardError(`nom de branche invalide « ${branch} »`);
  }
  if (!new RegExp(`(^|[^0-9])${ctx.issueIid}([^0-9]|$)`).test(branch)) {
    throw new BranchGuardError(`la branche « ${branch} » ne contient pas le numéro du ticket #${ctx.issueIid}`);
  }

  const lower = branch.toLowerCase();
  if (ALWAYS_FORBIDDEN.includes(lower) || /^(release|hotfix)([/-]|$)/.test(lower)) {
    throw new BranchGuardError(`« ${branch} » est une branche partagée`);
  }
  for (const pattern of ctx.forbidden) {
    if (pattern && matchesBranchPattern(pattern, branch)) {
      throw new BranchGuardError(`« ${branch} » correspond à une branche protégée ou de base/cible (« ${pattern} »)`);
    }
  }
}

/** Fichiers que l'agent ne doit jamais committer (secrets). `.env.example` & co restent autorisés. */
export function isSecretFile(filePath: string): boolean {
  const name = filePath.split("/").pop() ?? filePath;
  if (/^\.env(\..+)?$/.test(name) && !/^\.env\.(example|sample|dist|template)$/.test(name)) return true;
  return /\.(pem|key|p12|pfx|keystore)$/i.test(name) || /^id_(rsa|ed25519|ecdsa)(\.pub)?$/.test(name) || name === "auth.json";
}

/**
 * Fichier du dossier des pièces jointes (captures, maquettes, données de l'utilisateur) : il ne doit jamais être committé.
 * @param filePath Chemin relatif au dépôt, tel que `git status` le donne.
 * @returns Vrai si le chemin est dans le dossier des pièces jointes.
 */
export function isAttachmentFile(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ATTACHMENTS_DIRNAME || normalized.startsWith(`${ATTACHMENTS_DIRNAME}/`);
}

/** Fichiers sensibles : autorisés, mais signalés en tête de MR pour une relecture attentive. */
export function isSensitiveFile(filePath: string): boolean {
  return /(^|\/)(\.gitlab-ci\.yml|Dockerfile|docker-compose[^/]*\.ya?ml|deploy\.php|composer\.json|package\.json)$/.test(filePath) || /(^|\/)\.gitlab\//.test(filePath);
}
