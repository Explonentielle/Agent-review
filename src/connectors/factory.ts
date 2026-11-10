import path from "node:path";
import type { Config } from "../config.js";
import { errorMessage } from "../logger.js";
import { RepoWorkspace } from "../review/workspace.js";
import { GithubConnector } from "./github.js";
import { GitlabConnector } from "./gitlab.js";
import { ForgeRegistry, type Forge } from "./registry.js";
import type { ForgeConnector } from "./types.js";

/** Copies locales des dépôts d'une forge : chaque forge a son propre dossier, deux forges pouvant donner le même numéro de projet. */
function workspaceFor(connector: ForgeConnector, reposDir: string): RepoWorkspace {
  const git = connector.gitCredentials();
  return new RepoWorkspace(reposDir, git.token, git.username);
}

/**
 * Construit les forges déclarées dans le .env. GitLab garde le dossier `repos` d'origine (les copies et
 * les dossiers de travail existants restent valides) ; GitHub a `repos/github`.
 * Le compte GitHub est lu auprès de l'API : un jeton invalide arrête le démarrage avec un message clair.
 * @param config Configuration (jetons et dossier de données).
 * @param options `allowEmpty` : accepte de ne construire aucune forge (personne sans jeton enregistré).
 * @returns Le registre des forges.
 * @throws Error Si aucune forge n'est configurée sans `allowEmpty`, ou si le jeton GitHub est refusé.
 */
export async function createForges(config: Config, options: { allowEmpty?: boolean } = {}): Promise<ForgeRegistry> {
  const reposDir = path.join(config.dataDir, "repos");
  const forges: Forge[] = [];

  if (config.gitlab) {
    const connector = GitlabConnector.fromConfig(config.gitlab);
    forges.push({ connector, workspace: workspaceFor(connector, reposDir), username: config.gitlab.username });
  }

  if (config.github) {
    const connector = GithubConnector.fromConfig(config.github);
    let username: string;
    try {
      username = (await connector.getCurrentUser()).username;
    } catch (err) {
      throw new Error(`Connexion à GitHub impossible (GITHUB_TOKEN) : ${errorMessage(err)}`);
    }
    forges.push({ connector, workspace: workspaceFor(connector, path.join(reposDir, "github")), username });
  }

  return new ForgeRegistry(forges, options);
}
