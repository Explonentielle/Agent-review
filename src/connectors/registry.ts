import type { RepoWorkspace } from "../review/workspace.js";
import type { ForgeConnector, ForgeKind } from "./types.js";

/** Une forge configurée : son connecteur, ses copies locales de dépôts et l'identité de l'utilisateur chez elle. */
export interface Forge {
  connector: ForgeConnector;
  workspace: RepoWorkspace;
  /** Identifiant de l'utilisateur de l'outil chez cette forge : relecteur des demandes à reviewer. */
  username: string;
}

function missingForgeMessage(kind: string): string {
  const where = "à enregistrer dans Paramètres > Connexion";
  if (kind === "gitlab") return `Aucun jeton GitLab enregistré (${where}). Utilise le jeton d'un compte qui a accès aux dépôts concernés, avec les scopes api, read_repository et write_repository.`;
  if (kind === "github") return `Aucun jeton GitHub enregistré (${where}). Utilise un jeton à portée fine créé pour l'organisation ou le compte qui possède les dépôts concernés.`;
  return `La forge « ${kind} » n'est pas configurée (${where}).`;
}

/**
 * Les forges configurées sur cette machine, retrouvées par leur genre (colonne « source » des reviews,
 * des tâches et des projets). Une review ou une tâche est toujours traitée par la forge qui l'a créée.
 */
export class ForgeRegistry {
  private readonly byKind = new Map<ForgeKind, Forge>();

  /**
   * @param forges Forges configurées, au plus une par genre.
   * @param options `allowEmpty` : accepte un registre vide (une personne qui n'a pas encore enregistré de jeton).
   * @throws Error Si une forge est déclarée deux fois, ou si le registre est vide sans `allowEmpty`.
   */
  constructor(forges: Forge[], options: { allowEmpty?: boolean } = {}) {
    for (const forge of forges) {
      const kind = forge.connector.kind;
      if (this.byKind.has(kind)) throw new Error(`La forge « ${kind} » est déclarée deux fois`);
      this.byKind.set(kind, forge);
    }
    if (this.byKind.size === 0 && !options.allowEmpty) throw new Error("Aucune forge configurée");
  }

  /** Lève une erreur lisible, qui dit quel jeton enregistrer et où, si la forge n'est pas configurée. */
  get(kind: string): Forge {
    const forge = this.byKind.get(kind as ForgeKind);
    if (!forge) throw new Error(missingForgeMessage(kind));
    return forge;
  }

  has(kind: string): boolean {
    return this.byKind.has(kind as ForgeKind);
  }

  all(): Forge[] {
    return [...this.byKind.values()];
  }
}
