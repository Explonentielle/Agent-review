import type { Config } from "../config.js";
import { GithubConnector } from "../connectors/github.js";
import { GitlabConnector } from "../connectors/gitlab.js";
import { errorMessage, log, registerSecret } from "../logger.js";
import { SecretError } from "./crypto.js";
import type { SecretScope, SecretStore } from "./store.js";

/**
 * Réglages de connexion que le dashboard peut enregistrer, et si un changement s'applique sans reconstruire les connexions aux forges.
 * `secret: false` : une adresse, qui peut être réaffichée (stockée chiffrée comme le reste, par simplicité).
 */
export const MANAGED_SECRETS = [
  { name: "gitlab.url", label: "Adresse de GitLab", live: false, secret: false },
  { name: "gitlab.token", label: "Jeton GitLab", live: false, secret: true },
  { name: "github.token", label: "Jeton GitHub", live: false, secret: true },
  { name: "anthropic.api_key", label: "Clé API Anthropic", live: true, secret: true },
  { name: "anthropic.oauth_token", label: "Jeton d'abonnement Claude", live: true, secret: true },
] as const;
export type ManagedSecretName = (typeof MANAGED_SECRETS)[number]["name"];

/** Le secret est déjà fourni par le `.env`, qui reste prioritaire : il ne se gère pas depuis le dashboard. */
export class SecretConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConflictError";
  }
}

/** Coffre d'une personne dans un espace, avec ce que le `.env` fournit déjà. */
export interface Vault {
  store: SecretStore;
  /** Propriétaire des secrets saisis dans le dashboard. */
  scope: SecretScope;
  /** Secrets déjà fournis par le `.env` : prioritaires. */
  fromEnv: Record<ManagedSecretName, boolean>;
  /** Adresse de l'instance GitLab (GITLAB_URL du `.env`, ou saisie dans le dashboard), ou null : sans elle, le jeton GitLab ne se gère pas ici. */
  gitlabUrl: string | null;
  /** Contrôle qu'un jeton GitHub est accepté par l'API (erreur sinon). Remplaçable dans les tests. */
  verifyGithubToken: (apiUrl: string, token: string) => Promise<void>;
  /** Contrôle qu'un jeton GitLab est accepté par l'instance et renvoie l'identifiant du compte (erreur sinon). Remplaçable dans les tests. */
  verifyGitlabToken: (url: string, token: string) => Promise<string>;
}

export interface SecretStatus {
  name: ManagedSecretName;
  label: string;
  /** Vrai pour un jeton ou une clé (jamais renvoyé), faux pour une adresse (renvoyée dans `value`). */
  secret: boolean;
  /** Valeur d'un réglage qui n'est pas un secret (l'adresse de GitLab), sinon null. */
  value: string | null;
  /** D'où vient la valeur utilisée : le `.env`, le coffre, ou nulle part. */
  source: "env" | "vault" | null;
  updatedAt: string | null;
  /** Vrai si un changement s'applique sans reconstruire les connexions aux forges. */
  live: boolean;
}

/**
 * Contrôle auprès de GitHub qu'un jeton est valide.
 * @param apiUrl Adresse de l'API GitHub.
 * @param token Jeton à contrôler.
 * @returns Rien.
 * @throws Error Si GitHub refuse le jeton ou n'est pas joignable.
 */
async function verifyWithGithub(apiUrl: string, token: string): Promise<void> {
  await GithubConnector.fromConfig({ apiUrl, token }).getCurrentUser();
}

/**
 * Contrôle auprès de GitLab qu'un jeton est valide.
 * @param url Adresse de l'instance GitLab.
 * @param token Jeton à contrôler.
 * @returns L'identifiant du compte (nom d'utilisateur) auquel appartient le jeton.
 * @throws Error Si GitLab refuse le jeton ou n'est pas joignable.
 */
async function verifyWithGitlab(url: string, token: string): Promise<string> {
  return (await GitlabConnector.fromConfig({ url, token }).getCurrentUser()).username;
}

/**
 * Prépare le coffre d'une personne. À appeler avant `applyVaultSecrets`, tant que la configuration ne
 * contient que ce que fournit le `.env`.
 * @param config Configuration de cette personne (le `.env` pour le propriétaire, vide de jetons pour les autres).
 * @param store Coffre à secrets.
 * @param scope Propriétaire des secrets saisis dans le dashboard.
 * @param verifyGithubToken Contrôle d'un jeton GitHub (l'API réelle par défaut).
 * @param verifyGitlabToken Contrôle d'un jeton GitLab (l'API réelle par défaut).
 * @returns Le coffre prêt à l'emploi.
 */
export function createVault(
  config: Config,
  store: SecretStore,
  scope: SecretScope,
  verifyGithubToken = verifyWithGithub,
  verifyGitlabToken = verifyWithGitlab,
): Vault {
  return {
    store,
    scope,
    fromEnv: { "gitlab.url": config.gitlabUrl !== null, "gitlab.token": config.gitlab !== null, "github.token": config.github !== null, "anthropic.api_key": config.anthropicApiKey !== null, "anthropic.oauth_token": config.claudeOauthToken !== null },
    gitlabUrl: config.gitlabUrl,
    verifyGithubToken,
    verifyGitlabToken,
  };
}

/**
 * Complète la configuration avec les secrets du coffre que le `.env` ne fournit pas. Un secret illisible ou un
 * jeton de forge refusé est signalé au journal et ignoré : l'outil démarre quand même, et on peut le corriger dans le dashboard.
 * @param config Configuration modifiée en place (`gitlabUrl`, `gitlab`, `github`, `anthropicApiKey`, `claudeOauthToken`).
 * @param vault Coffre de la personne.
 * @returns Rien.
 */
export async function applyVaultSecrets(config: Config, vault: Vault): Promise<void> {
  if (!vault.fromEnv["gitlab.url"]) {
    const url = await readQuietly(vault, "gitlab.url");
    if (url) {
      config.gitlabUrl = url;
      vault.gitlabUrl = url;
    }
  }
  if (!vault.fromEnv["anthropic.api_key"]) {
    const key = await readQuietly(vault, "anthropic.api_key");
    if (key) config.anthropicApiKey = key;
  }
  if (!vault.fromEnv["anthropic.oauth_token"]) {
    const token = await readQuietly(vault, "anthropic.oauth_token");
    if (token) config.claudeOauthToken = token;
  }
  if (!vault.fromEnv["github.token"]) {
    const token = await readQuietly(vault, "github.token");
    if (token) {
      try {
        await vault.verifyGithubToken(config.githubApiUrl, token);
        config.github = { apiUrl: config.githubApiUrl, token };
      } catch (err) {
        log.warn("vault.github_token_refused", { error: errorMessage(err) });
      }
    }
  }
  if (!vault.fromEnv["gitlab.token"] && vault.gitlabUrl) {
    const token = await readQuietly(vault, "gitlab.token");
    if (token) {
      try {
        config.gitlab = { url: vault.gitlabUrl, token, username: await vault.verifyGitlabToken(vault.gitlabUrl, token) };
      } catch (err) {
        log.warn("vault.gitlab_token_refused", { error: errorMessage(err) });
      }
    }
  }
}

/**
 * Lit un secret du coffre sans faire échouer le démarrage.
 * @param vault Coffre de la personne.
 * @param name Nom du secret.
 * @returns La valeur, ou null si le secret est absent ou illisible (signalé au journal).
 */
async function readQuietly(vault: Vault, name: ManagedSecretName): Promise<string | null> {
  try {
    return await vault.store.get(vault.scope, name);
  } catch (err) {
    log.warn("vault.secret_unreadable", { name, error: errorMessage(err) });
    return null;
  }
}

/**
 * État des secrets gérables depuis le dashboard : jamais leur valeur. Le jeton GitLab n'apparaît que si l'adresse de GitLab est connue.
 * @param vault Coffre de la personne.
 * @returns Pour chaque secret, d'où vient la valeur utilisée et la date de saisie.
 */
export async function describeSecrets(vault: Vault): Promise<SecretStatus[]> {
  const stored = new Map((await vault.store.list(vault.scope)).map((s) => [s.name, s.updated_at]));
  return MANAGED_SECRETS.filter((m) => m.name !== "gitlab.token" || vault.gitlabUrl !== null).map((m) => ({
    name: m.name,
    label: m.label,
    secret: m.secret,
    value: m.name === "gitlab.url" ? vault.gitlabUrl : null,
    source: vault.fromEnv[m.name] ? "env" : stored.has(m.name) ? "vault" : null,
    updatedAt: vault.fromEnv[m.name] ? null : (stored.get(m.name) ?? null),
    live: m.live,
  }));
}

/**
 * Contrôle qu'un nom désigne un secret gérable depuis le dashboard.
 * @param name Nom reçu.
 * @returns Le nom, typé.
 * @throws SecretError Si le secret n'est pas gérable ici.
 */
export function managedName(name: string): ManagedSecretName {
  const found = MANAGED_SECRETS.find((m) => m.name === name);
  if (!found) throw new SecretError(`Secret inconnu : ${MANAGED_SECRETS.map((m) => m.name).join(", ")}`);
  return found.name;
}

/**
 * Normalise l'adresse d'une instance GitLab saisie dans le dashboard.
 * @param value Adresse saisie.
 * @returns L'adresse sans barre finale, ni paramètres (un chemin est gardé : GitLab peut vivre sous /gitlab).
 * @throws SecretError Si ce n'est pas une adresse http(s), ou si elle contient des identifiants.
 */
function cleanGitlabUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SecretError("Adresse invalide (exemple : https://gitlab.exemple.com)");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SecretError("L'adresse doit commencer par https:// (ou http://)");
  if (url.username || url.password) throw new SecretError("Pas d'identifiants dans l'adresse : le jeton se saisit à part");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * Enregistre un réglage de connexion saisi dans le dashboard. Un jeton de forge est d'abord contrôlé auprès de la forge (un jeton
 * refusé enregistré empêcherait la forge de démarrer). La clé API et le jeton d'abonnement sont appliqués tout de suite ; une adresse ou un jeton
 * de forge demande de reconstruire les connexions aux forges (`restartRequired` dit si cela passe par un redémarrage).
 * @param config Configuration modifiée en place pour la clé API et le jeton d'abonnement.
 * @param vault Coffre de la personne.
 * @param name Secret à enregistrer.
 * @param value Valeur saisie.
 * @returns Si un jeton de forge a changé (les connexions doivent être reconstruites).
 * @throws SecretConflictError Si le `.env` fournit déjà ce secret.
 * @throws SecretError Si la valeur est invalide.
 * @throws Error Si la forge refuse le jeton.
 */
export async function saveManagedSecret(config: Config, vault: Vault, name: ManagedSecretName, value: string): Promise<{ restartRequired: boolean }> {
  if (vault.fromEnv[name]) throw new SecretConflictError("Ce secret est défini dans le .env, qui est prioritaire : retire-le du .env pour le gérer ici");
  const clean = value.trim();
  if (clean === "") throw new SecretError("Valeur vide");
  if (name === "gitlab.url") {
    const url = cleanGitlabUrl(clean);
    await vault.store.put(vault.scope, name, url);
    config.gitlabUrl = url;
    vault.gitlabUrl = url;
    return { restartRequired: true };
  }
  if (name === "anthropic.oauth_token" && !/^\S{20,}$/.test(clean)) throw new SecretError("Jeton invalide : colle le jeton affiché par « claude setup-token », sans espace ni retour à la ligne");
  registerSecret(clean); // masqué dès maintenant, y compris dans l'erreur d'un contrôle qui échoue
  if (name === "github.token") await vault.verifyGithubToken(config.githubApiUrl, clean);
  if (name === "gitlab.token") {
    if (!vault.gitlabUrl) throw new SecretError("L'adresse de GitLab n'est pas configurée : enregistre-la d'abord");
    await vault.verifyGitlabToken(vault.gitlabUrl, clean);
  }
  await vault.store.put(vault.scope, name, clean);
  if (name === "anthropic.api_key") config.anthropicApiKey = clean;
  if (name === "anthropic.oauth_token") config.claudeOauthToken = clean;
  return { restartRequired: name !== "anthropic.api_key" && name !== "anthropic.oauth_token" };
}

/**
 * Supprime un secret saisi dans le dashboard. La clé API et le jeton d'abonnement cessent d'être utilisés tout de suite ; un jeton de forge
 * reste utilisé par les connexions déjà construites jusqu'à leur reconstruction.
 * @param config Configuration modifiée en place pour la clé API et le jeton d'abonnement.
 * @param vault Coffre de la personne.
 * @param name Secret à supprimer.
 * @returns Si le secret existait, et si les connexions aux forges doivent être reconstruites pour l'oublier.
 * @throws SecretConflictError Si le `.env` fournit ce secret.
 */
export async function deleteManagedSecret(config: Config, vault: Vault, name: ManagedSecretName): Promise<{ deleted: boolean; restartRequired: boolean }> {
  if (vault.fromEnv[name]) throw new SecretConflictError("Ce secret est défini dans le .env, qui est prioritaire : retire-le du .env pour le gérer ici");
  const deleted = await vault.store.delete(vault.scope, name);
  if (name === "anthropic.api_key") config.anthropicApiKey = null;
  if (name === "anthropic.oauth_token") config.claudeOauthToken = null;
  if (name === "gitlab.url") {
    config.gitlabUrl = null;
    vault.gitlabUrl = null;
  }
  return { deleted, restartRequired: name !== "anthropic.api_key" && name !== "anthropic.oauth_token" && deleted };
}
