import { AccountError, cleanEmail, type AccountRepo } from "../db/accounts.js";
import type { CredentialRepo } from "../db/credentials.js";
import { LoginRefusedError, activeWorkspace, createPersonalWorkspace, type SignInPolicy, type SignedIn } from "./login.js";
import { MAX_PASSWORD_LENGTH, checkPassword, hashPassword, spendVerificationTime, verifyPassword } from "./password.js";

/** Même message pour une adresse inconnue, un compte sans mot de passe et un mauvais mot de passe : rien ne dit quels comptes existent. */
const BAD_CREDENTIALS = "Adresse email ou mot de passe incorrect";

/**
 * Normalise une adresse saisie dans un formulaire.
 * @param email Adresse saisie (de n'importe quel type : le corps d'une requête n'est pas fiable).
 * @returns L'adresse en minuscules sans espaces autour, ou null si elle n'a pas un format valide.
 */
export function readEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  try {
    return cleanEmail(email);
  } catch {
    return null;
  }
}

/**
 * Connexion par adresse email et mot de passe. Le temps de réponse est le même quand l'adresse est inconnue.
 * @param accounts Dépôt des comptes.
 * @param credentials Dépôt des mots de passe.
 * @param email Adresse saisie.
 * @param password Mot de passe saisi.
 * @returns L'utilisateur et son espace actif.
 * @throws LoginRefusedError Si l'adresse est inconnue, le compte n'a pas de mot de passe (créé par une forge) ou le mot de passe est faux.
 */
export async function signInWithPassword(accounts: AccountRepo, credentials: CredentialRepo, email: unknown, password: unknown): Promise<SignedIn> {
  const typed = typeof password === "string" && password.length <= MAX_PASSWORD_LENGTH ? password : "";
  const clean = readEmail(email);
  const user = clean ? await accounts.getUserByEmail(clean) : undefined;
  const hash = user ? await credentials.get(user.id) : null;
  if (!user || !hash) {
    await spendVerificationTime(typed);
    throw new LoginRefusedError(BAD_CREDENTIALS);
  }
  if (typed === "" || !(await verifyPassword(typed, hash))) throw new LoginRefusedError(BAD_CREDENTIALS);
  return { userId: user.id, workspaceId: await activeWorkspace(accounts, user.id) };
}

/**
 * Compte de l'utilisateur qui possède l'adresse, une fois celle-ci confirmée par un lien reçu par email. Le propriétaire de l'installation (AUTH_OWNER) reprend le
 * compte local et ses données tant que ce compte est libre ; chacun des autres reçoit un nouvel utilisateur et son espace personnel.
 * @param accounts Dépôt des comptes.
 * @param credentials Dépôt des mots de passe.
 * @param policy Règles de connexion (le propriétaire).
 * @param input Adresse confirmée, nom affiché et mot de passe choisi.
 * @param claimLocal Vrai pour permettre au propriétaire de reprendre le compte local (inscription), faux pour une invitation.
 * @returns L'utilisateur et son espace personnel (ou le premier espace du compte local repris).
 * @throws PasswordError Si le mot de passe ne convient pas.
 * @throws LoginRefusedError Si un compte existe déjà avec cette adresse.
 * @throws AccountError Si le nom est invalide.
 */
export async function createPasswordAccount(accounts: AccountRepo, credentials: CredentialRepo, policy: SignInPolicy, input: { email: string; name: string; password: string }, claimLocal: boolean): Promise<SignedIn> {
  checkPassword(input.password, input.email);
  const hash = await hashPassword(input.password);
  if (await accounts.getUserByEmail(input.email)) throw new LoginRefusedError("Un compte existe déjà avec cette adresse");

  if (claimLocal && input.email === policy.owner) {
    const local = await accounts.localContext();
    if (!(await accounts.userHasIdentity(local.userId)) && (await credentials.get(local.userId)) === null && (await accounts.claimLocalUser(local.userId, input))) {
      await credentials.set(local.userId, hash);
      return { userId: local.userId, workspaceId: local.workspaceId };
    }
  }

  let userId: number;
  try {
    userId = await accounts.createUser({ name: input.name, email: input.email });
  } catch (err) {
    if (err instanceof AccountError && /déjà utilisée/.test(err.message)) throw new LoginRefusedError("Un compte existe déjà avec cette adresse"); // deux demandes en même temps
    throw err;
  }
  await credentials.set(userId, hash);
  return { userId, workspaceId: await createPersonalWorkspace(accounts, userId, input.name.trim()) };
}
