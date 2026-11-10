import type { Config } from "../config.js";
import { GithubConnector } from "../connectors/github.js";
import { errorMessage, log, registerSecret } from "../logger.js";
import { SecretError } from "./crypto.js";
import type { SecretScope, SecretStore } from "./store.js";

/** Secrets que le dashboard peut enregistrer, et si un changement s'applique tout de suite ou au redémarrage. */
export const MANAGED_SECRETS = [
  { name: "github.token", label: "Jeton GitHub", live: false },
  { name: "anthropic.api_key", label: "Clé API Anthropic", live: true },
] as const;
export type ManagedSecretName = (typeof MANAGED_SECRETS)[number]["name"];

/** Le secret est déjà fourni par le `.env`, qui reste prioritaire : il ne se gère pas depuis le dashboard. */
export class SecretConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretConflictError";
  }
}

/** Coffre de l'utilisateur local, avec ce que le `.env` fournit déjà. */
export interface Vault {
  store: SecretStore;
  /** Propriétaire des secrets saisis dans le dashboard. */
  scope: SecretScope;
  /** Secrets déjà fournis par le `.env` au démarrage : prioritaires. */
  fromEnv: Record<ManagedSecretName, boolean>;
  /** Contrôle qu'un jeton GitHub est accepté par l'API (erreur sinon). Remplaçable dans les tests. */
  verifyGithubToken: (apiUrl: string, token: string) => Promise<void>;
}

export interface SecretStatus {
  name: ManagedSecretName;
  label: string;
  /** D'où vient la valeur utilisée : le `.env`, le coffre, ou nulle part. */
  source: "env" | "vault" | null;
  updatedAt: string | null;
  /** Vrai si un changement s'applique sans redémarrage. */
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
 * Prépare le coffre de l'utilisateur local. À appeler avant `applyVaultSecrets`, tant que la configuration ne
 * contient que ce que fournit le `.env`.
 * @param config Configuration lue dans le `.env`.
 * @param store Coffre à secrets.
 * @param scope Propriétaire des secrets saisis dans le dashboard.
 * @param verifyGithubToken Contrôle d'un jeton GitHub (l'API réelle par défaut).
 * @returns Le coffre prêt à l'emploi.
 */
export function createVault(config: Config, store: SecretStore, scope: SecretScope, verifyGithubToken = verifyWithGithub): Vault {
  return {
    store,
    scope,
    fromEnv: { "github.token": config.github !== null, "anthropic.api_key": config.anthropicApiKey !== null },
    verifyGithubToken,
  };
}

/**
 * Complète la configuration avec les secrets du coffre que le `.env` ne fournit pas. Un secret illisible ou un
 * jeton GitHub refusé est signalé au journal et ignoré : l'outil démarre quand même, et on peut le corriger dans le dashboard.
 * @param config Configuration modifiée en place (`github`, `anthropicApiKey`).
 * @param vault Coffre de l'utilisateur local.
 * @returns Rien.
 */
export async function applyVaultSecrets(config: Config, vault: Vault): Promise<void> {
  if (!vault.fromEnv["anthropic.api_key"]) {
    const key = await readQuietly(vault, "anthropic.api_key");
    if (key) config.anthropicApiKey = key;
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
}

/**
 * Lit un secret du coffre sans faire échouer le démarrage.
 * @param vault Coffre de l'utilisateur local.
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
 * État des secrets gérables depuis le dashboard : jamais leur valeur.
 * @param vault Coffre de l'utilisateur local.
 * @returns Pour chaque secret, d'où vient la valeur utilisée et la date de saisie.
 */
export async function describeSecrets(vault: Vault): Promise<SecretStatus[]> {
  const stored = new Map((await vault.store.list(vault.scope)).map((s) => [s.name, s.updated_at]));
  return MANAGED_SECRETS.map((m) => ({
    name: m.name,
    label: m.label,
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
 * Enregistre un secret saisi dans le dashboard. Un jeton GitHub est d'abord contrôlé auprès de GitHub (un jeton
 * refusé enregistré empêcherait la forge de démarrer). La clé API est appliquée tout de suite ; le jeton GitHub au redémarrage.
 * @param config Configuration modifiée en place pour la clé API.
 * @param vault Coffre de l'utilisateur local.
 * @param name Secret à enregistrer.
 * @param value Valeur saisie.
 * @returns Si un redémarrage est nécessaire pour la prendre en compte.
 * @throws SecretConflictError Si le `.env` fournit déjà ce secret.
 * @throws SecretError Si la valeur est invalide.
 * @throws Error Si GitHub refuse le jeton.
 */
export async function saveManagedSecret(config: Config, vault: Vault, name: ManagedSecretName, value: string): Promise<{ restartRequired: boolean }> {
  if (vault.fromEnv[name]) throw new SecretConflictError("Ce secret est défini dans le .env, qui est prioritaire : retire-le du .env pour le gérer ici");
  const clean = value.trim();
  if (clean === "") throw new SecretError("Valeur vide");
  registerSecret(clean); // masqué dès maintenant, y compris dans l'erreur d'un contrôle qui échoue
  if (name === "github.token") await vault.verifyGithubToken(config.githubApiUrl, clean);
  await vault.store.put(vault.scope, name, clean);
  if (name === "anthropic.api_key") config.anthropicApiKey = clean;
  return { restartRequired: name === "github.token" };
}

/**
 * Supprime un secret saisi dans le dashboard. La clé API cesse d'être utilisée tout de suite ; le jeton GitHub
 * reste utilisé par la forge déjà démarrée jusqu'au redémarrage.
 * @param config Configuration modifiée en place pour la clé API.
 * @param vault Coffre de l'utilisateur local.
 * @param name Secret à supprimer.
 * @returns Si le secret existait, et si un redémarrage est nécessaire pour l'oublier.
 * @throws SecretConflictError Si le `.env` fournit ce secret.
 */
export async function deleteManagedSecret(config: Config, vault: Vault, name: ManagedSecretName): Promise<{ deleted: boolean; restartRequired: boolean }> {
  if (vault.fromEnv[name]) throw new SecretConflictError("Ce secret est défini dans le .env, qui est prioritaire : retire-le du .env pour le gérer ici");
  const deleted = await vault.store.delete(vault.scope, name);
  if (name === "anthropic.api_key") config.anthropicApiKey = null;
  return { deleted, restartRequired: name === "github.token" && deleted };
}
