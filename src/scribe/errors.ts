import { GithubError } from "../github/client.js";
import { GitlabError } from "../gitlab/client.js";
import type { ForgeKind } from "../connectors/types.js";

export type ScribeAction = "ticket" | "project" | "list";

/** Erreur de la forge traduite pour la personne : ce qui s'est passé, et le droit à vérifier sur le jeton. */
export class ScribeForgeError extends Error {
  constructor(
    message: string,
    /** Code HTTP à renvoyer au navigateur. */
    readonly status: number,
  ) {
    super(message);
    this.name = "ScribeForgeError";
  }
}

const FORGE_NAME: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab" };

/** Droits que le jeton doit avoir pour chaque action d'écriture, par forge (vérifiés dans la documentation des API, novembre 2026). */
export const REQUIRED_RIGHTS: Record<ForgeKind, Record<Exclude<ScribeAction, "list">, string>> = {
  gitlab: {
    ticket: "le scope « api » sur le jeton et le rôle Reporter (ou plus) dans le projet",
    project: "le scope « api » sur le jeton et, dans le groupe choisi, un rôle qui autorise la création de projets (Developer, Maintainer ou Owner selon les réglages du groupe)",
  },
  github: {
    ticket: "la permission « Issues : Read and write » sur ce dépôt (jeton à portée fine) ou le scope « repo » (jeton classique)",
    project: "la permission « Administration : Read and write » ou « Repository creation : Read and write » (jeton à portée fine, dont le propriétaire doit être ton compte ou l'organisation visée) ou le scope « repo » (jeton classique)",
  },
};

/**
 * Traduit un refus de la forge en message utile : quel droit ajouter au jeton, plutôt qu'un code HTTP brut.
 * @param kind Forge concernée.
 * @param action Ce qu'on tentait de faire.
 * @param err Erreur reçue.
 * @returns Une erreur lisible avec son code HTTP ; les erreurs inconnues sont relayées telles quelles.
 */
export function explainForgeError(kind: ForgeKind, action: ScribeAction, err: unknown): unknown {
  const status = err instanceof GitlabError || err instanceof GithubError ? err.status : null;
  if (status === null) return err;
  const forge = FORGE_NAME[kind];
  if (status === 401) return new ScribeForgeError(`${forge} refuse le jeton (expiré, révoqué ou invalide). Enregistre-en un nouveau dans le fourneau ${forge}.`, 401);
  if (status === 403 || (status === 404 && action !== "list")) {
    if (action === "list") return new ScribeForgeError(`${forge} ne te laisse pas lire ce projet : vérifie le jeton.`, 403);
    const what = action === "ticket" ? "créer un ticket ici" : "créer ce projet";
    return new ScribeForgeError(
      `${forge} refuse de ${what}. Il faut ${REQUIRED_RIGHTS[kind][action]}. ${status === 404 ? "(La forge répond « introuvable » quand le droit manque : le projet ou le groupe est peut-être aussi invisible pour ce jeton.) " : ""}Ajuste le jeton dans le fourneau ${forge}, puis réessaie.`,
      403,
    );
  }
  if (status === 422 || status === 400) {
    const detail = err instanceof Error ? err.message.replace(/^.*?→ \d+ : /, "").slice(0, 300) : "";
    return new ScribeForgeError(`${forge} refuse ces valeurs (nom déjà pris ou invalide, par exemple) : ${detail}`, 422);
  }
  if (status === 429) return new ScribeForgeError(`${forge} demande de patienter (trop de requêtes). Réessaie dans une minute.`, 429);
  return err;
}
