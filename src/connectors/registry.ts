import type { RepoWorkspace } from "../review/workspace.js";
import type { ForgeConnector, ForgeKind } from "./types.js";

/** Une forge configurée : son connecteur, ses copies locales de dépôts et l'identité de l'utilisateur chez elle. */
export interface Forge {
  connector: ForgeConnector;
  workspace: RepoWorkspace;
  /** Identifiant de l'utilisateur de l'outil chez cette forge : relecteur des demandes à reviewer. */
  username: string;
}

/**
 * Les forges configurées sur cette machine, retrouvées par leur genre (colonne « source » des reviews,
 * des tâches et des projets). Une review ou une tâche est toujours traitée par la forge qui l'a créée.
 */
export class ForgeRegistry {
  private readonly byKind = new Map<ForgeKind, Forge>();

  constructor(forges: Forge[]) {
    for (const forge of forges) {
      const kind = forge.connector.kind;
      if (this.byKind.has(kind)) throw new Error(`La forge « ${kind} » est déclarée deux fois`);
      this.byKind.set(kind, forge);
    }
    if (this.byKind.size === 0) throw new Error("Aucune forge configurée");
  }

  /** Lève une erreur lisible si la forge n'est pas configurée (jeton absent du .env). */
  get(kind: string): Forge {
    const forge = this.byKind.get(kind as ForgeKind);
    if (!forge) throw new Error(`La forge « ${kind} » n'est pas configurée (jeton absent du .env)`);
    return forge;
  }

  has(kind: string): boolean {
    return this.byKind.has(kind as ForgeKind);
  }

  all(): Forge[] {
    return [...this.byKind.values()];
  }
}
