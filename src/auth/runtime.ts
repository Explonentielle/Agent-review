import type { AuthConfig } from "../config.js";
import type { AccountRepo } from "../db/accounts.js";
import type { Db } from "../db/db.js";
import { createCredentialRepo } from "../db/credentials.js";
import { createEmailTokenRepo } from "../db/emailTokens.js";
import { createInvitationRepo } from "../db/invitations.js";
import { createResendMailer, type Mailer } from "../mail/mailer.js";
import { createGithubProvider, createGitlabProvider, type AuthProviderKind, type OAuthProvider } from "./oauth.js";
import type { AuthRuntime } from "./routes.js";
import { createSessionStore } from "./sessions.js";

/**
 * Assemble la connexion à partir de la configuration.
 * @param config Connexion configurée dans le `.env`.
 * @param db Base de données (sessions).
 * @param accounts Dépôt des comptes.
 * @param fetchImpl Appels réseau vers les forges et vers Resend (remplaçable dans les tests).
 * @param mailer Envoi d'emails à utiliser à la place de Resend (tests) ; absent, Resend si `config.mail` est renseigné.
 * @returns Les fournisseurs, les sessions et les règles d'accès, prêts pour le serveur.
 */
export function createAuthRuntime(config: AuthConfig, db: Db, accounts: AccountRepo, fetchImpl?: typeof fetch, mailer?: Mailer): AuthRuntime {
  const sender = mailer ?? (config.mail ? createResendMailer({ apiKey: config.mail.apiKey, from: config.mail.from, fetchImpl }) : null);
  const providers = new Map<AuthProviderKind, OAuthProvider>();
  if (config.gitlab) providers.set("gitlab", createGitlabProvider(config.gitlab.baseUrl, { clientId: config.gitlab.clientId, clientSecret: config.gitlab.clientSecret, fetchImpl }));
  if (config.github) providers.set("github", createGithubProvider({ clientId: config.github.clientId, clientSecret: config.github.clientSecret, fetchImpl }));
  return {
    providers,
    sessions: createSessionStore(db, config.sessionDays),
    accounts,
    invitations: createInvitationRepo(db),
    // Chaque personne a ses propres connexions aux forges (tenants/manager.ts) : l'accès à d'autres personnes est ouvert, mais seulement sur invitation
    // d'un administrateur, ou pour les comptes listés dans AUTH_ALLOWED_USERS (ancien mode, gardé pour la compatibilité)
    policy: { owner: config.owner, allowedUsers: config.allowedUsers, multiUser: true, signup: config.signup ?? "invite" },
    // Connexion par email et mot de passe : seulement si on sait envoyer des emails (ils confirment les adresses)
    ...(sender ? { password: { mailer: sender, credentials: createCredentialRepo(db), tokens: createEmailTokenRepo(db) } } : {}),
    publicUrl: config.publicUrl,
    sessionDays: config.sessionDays,
  };
}
