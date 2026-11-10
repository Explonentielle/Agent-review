import type { AuthConfig } from "../config.js";
import type { AccountRepo } from "../db/accounts.js";
import type { Db } from "../db/db.js";
import { createGithubProvider, createGitlabProvider, type AuthProviderKind, type OAuthProvider } from "./oauth.js";
import type { AuthRuntime } from "./routes.js";
import { createSessionStore } from "./sessions.js";

/**
 * Accès de plusieurs personnes. Faux tant que chaque personne n'a pas ses propres connexions aux forges, ses files et ses pollers :
 * ce serveur utilise les jetons de l'utilisateur local, les ouvrir à d'autres reviendrait à leur prêter ton identité sur les forges.
 * À passer à vrai avec l'exécution par espace (roadmap-plateforme, C8).
 */
export const MULTI_USER_ENABLED = false;

/**
 * Assemble la connexion à partir de la configuration.
 * @param config Connexion configurée dans le `.env`.
 * @param db Base de données (sessions).
 * @param accounts Dépôt des comptes.
 * @param fetchImpl Appels réseau vers les forges (remplaçable dans les tests).
 * @returns Les fournisseurs, les sessions et les règles d'accès, prêts pour le serveur.
 */
export function createAuthRuntime(config: AuthConfig, db: Db, accounts: AccountRepo, fetchImpl?: typeof fetch): AuthRuntime {
  const providers = new Map<AuthProviderKind, OAuthProvider>();
  if (config.gitlab) providers.set("gitlab", createGitlabProvider(config.gitlab.baseUrl, { clientId: config.gitlab.clientId, clientSecret: config.gitlab.clientSecret, fetchImpl }));
  if (config.github) providers.set("github", createGithubProvider({ clientId: config.github.clientId, clientSecret: config.github.clientSecret, fetchImpl }));
  return {
    providers,
    sessions: createSessionStore(db, config.sessionDays),
    accounts,
    policy: { owner: config.owner, allowedUsers: config.allowedUsers, multiUser: MULTI_USER_ENABLED },
    publicUrl: config.publicUrl,
    sessionDays: config.sessionDays,
  };
}
