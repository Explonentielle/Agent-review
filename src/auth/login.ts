import { AccountError, type AccountRepo } from "../db/accounts.js";
import type { InvitationRepo } from "../db/invitations.js";
import type { AuthProviderKind, OAuthProfile } from "./oauth.js";

/** Qui a le droit de se connecter. */
export interface SignInPolicy {
  /** Propriétaire de l'installation, `forge:identifiant` en minuscules : il reprend le compte local et ses données. */
  owner: string;
  /** Autres personnes autorisées, `forge:identifiant` en minuscules. */
  allowedUsers: string[];
  /**
   * Faux tant que chaque personne n'a pas ses propres connexions aux forges : seul le compte local peut alors se connecter, sans quoi
   * un invité utiliserait les jetons du propriétaire.
   */
  multiUser: boolean;
}

/** Connexion refusée. Le message est destiné à l'utilisateur. */
export class LoginRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRefusedError";
  }
}

/** Utilisateur et espace actif d'une connexion réussie. */
export interface SignedIn {
  userId: number;
  workspaceId: number;
}

/**
 * Espace actif d'un utilisateur : son espace personnel, à défaut le plus ancien de ses espaces.
 * @param accounts Dépôt des comptes.
 * @param userId Identifiant de l'utilisateur.
 * @returns L'identifiant de l'espace.
 * @throws AccountError Si l'utilisateur n'appartient à aucun espace.
 */
async function activeWorkspace(accounts: AccountRepo, userId: number): Promise<number> {
  const workspaces = await accounts.listWorkspacesOf(userId);
  const chosen = workspaces.find((w) => w.kind === "personal") ?? workspaces[0];
  if (!chosen) throw new AccountError("Cet utilisateur n'appartient à aucun espace");
  return chosen.id;
}

/**
 * Transforme l'identité renvoyée par une forge en utilisateur de l'outil. Un compte de forge déjà lié se reconnaît à son identifiant
 * numérique. Sinon la personne doit être autorisée : le propriétaire reprend le compte local (et ses données) la première fois,
 * les autres reçoivent un nouvel utilisateur et un espace personnel. Les comptes ne sont jamais rapprochés par adresse email
 * (une adresse non vérifiée permettrait de prendre le compte de quelqu'un d'autre).
 * @param accounts Dépôt des comptes.
 * @param policy Qui a le droit de se connecter.
 * @param provider Forge qui a authentifié la personne.
 * @param profile Identité renvoyée par la forge.
 * @param invite Invitation présentée avec la connexion (jeton lu dans le lien), ou absente.
 * @returns L'utilisateur et son espace actif.
 * @throws LoginRefusedError Si la personne n'est pas autorisée, ou si l'invitation n'est pas valable.
 */
export async function signIn(accounts: AccountRepo, policy: SignInPolicy, provider: AuthProviderKind, received: OAuthProfile, invite?: { repo: InvitationRepo; token: string }): Promise<SignedIn> {
  const profile = { ...received, name: received.name.slice(0, 100) }; // un nom trop long chez la forge ne doit pas bloquer la connexion
  if (invite) return signInWithInvitation(accounts, provider, profile, invite);
  const key = `${provider}:${profile.login.toLowerCase()}`;
  const local = await accounts.localContext();
  const existing = await accounts.findUserByIdentity(provider, profile.id);

  if (existing) {
    if (!policy.multiUser && existing.id !== local.userId) throw new LoginRefusedError("L'accès à plusieurs personnes n'est pas encore activé sur cette installation");
    await accounts.updateIdentityLogin(provider, profile.id, profile.login);
    return { userId: existing.id, workspaceId: await activeWorkspace(accounts, existing.id) };
  }

  const isOwner = key === policy.owner;
  if (!isOwner && !(policy.multiUser && policy.allowedUsers.includes(key))) {
    throw new LoginRefusedError(policy.multiUser ? "Ce compte n'est pas autorisé sur cette installation" : "L'accès à plusieurs personnes n'est pas encore activé sur cette installation");
  }

  // Le propriétaire reprend le compte local (réglages, reviews, tâches) tant que celui-ci n'a pas de compte de forge
  if (isOwner && !(await accounts.userHasIdentity(local.userId))) {
    await accounts.linkIdentity(local.userId, provider, profile.id, profile.login);
    await accounts.renameUser(local.userId, profile.name);
    return { userId: local.userId, workspaceId: local.workspaceId };
  }

  const userId = await createUserFor(accounts, profile);
  await accounts.linkIdentity(userId, provider, profile.id, profile.login);
  const workspaceId = await accounts.createWorkspace({ name: `Espace de ${profile.name}`.slice(0, 100), kind: "personal", adminUserId: userId });
  return { userId, workspaceId };
}

/**
 * Connexion d'une personne qui arrive avec un lien d'invitation. L'invitation décide de tout : elle doit être valable (jamais utilisée, ni révoquée, ni expirée),
 * et si elle est réservée à un compte de forge, c'est ce compte qui doit se connecter. La personne entre dans l'espace invité avec le rôle prévu, et c'est cet
 * espace qui devient son espace actif. Un compte de forge déjà connu garde son utilisateur ; un compte inconnu reçoit un nouvel utilisateur, sans espace
 * personnel. Une invitation n'est consommée que si la personne n'est pas déjà membre : se reconnecter avec son lien ne coûte rien.
 * @param accounts Dépôt des comptes.
 * @param provider Forge qui a authentifié la personne.
 * @param profile Identité renvoyée par la forge.
 * @param invite Invitation et son jeton.
 * @returns L'utilisateur et l'espace invité.
 * @throws LoginRefusedError Si l'invitation n'est plus valable, est réservée à un autre compte, ou vient d'être prise par quelqu'un d'autre.
 */
async function signInWithInvitation(accounts: AccountRepo, provider: AuthProviderKind, profile: OAuthProfile, invite: { repo: InvitationRepo; token: string }): Promise<SignedIn> {
  const found = await invite.repo.lookup(invite.token);
  if (!found) throw new LoginRefusedError("Cette invitation n'est plus valable (utilisée, révoquée ou expirée)");
  const key = `${provider}:${profile.login.toLowerCase()}`;
  if (found.forgeLogin !== null && found.forgeLogin !== key) throw new LoginRefusedError(`Cette invitation est réservée au compte ${found.forgeLogin}`);

  const existing = await accounts.findUserByIdentity(provider, profile.id);
  let userId: number;
  if (existing) {
    userId = existing.id;
    await accounts.updateIdentityLogin(provider, profile.id, profile.login);
  } else {
    userId = await createUserFor(accounts, profile);
    await accounts.linkIdentity(userId, provider, profile.id, profile.login);
  }

  if ((await accounts.membershipRole(found.workspaceId, userId)) === null) {
    // Prise en une seule instruction : de deux personnes qui arrivent en même temps avec le même lien, une seule entre
    if (!(await invite.repo.consume(found.id, userId))) throw new LoginRefusedError("Cette invitation vient d'être utilisée par quelqu'un d'autre");
    await accounts.addMember(found.workspaceId, userId, found.role);
  }
  return { userId, workspaceId: found.workspaceId };
}

/**
 * Crée l'utilisateur d'une première connexion. Son adresse email n'est gardée que si personne ne l'utilise déjà.
 * @param accounts Dépôt des comptes.
 * @param profile Identité renvoyée par la forge.
 * @returns L'identifiant du nouvel utilisateur.
 */
async function createUserFor(accounts: AccountRepo, profile: OAuthProfile): Promise<number> {
  try {
    return await accounts.createUser({ name: profile.name, email: profile.email });
  } catch (err) {
    if (err instanceof AccountError) return accounts.createUser({ name: profile.name }); // adresse déjà prise ou invalide : sans adresse
    throw err;
  }
}
