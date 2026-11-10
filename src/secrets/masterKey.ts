import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Keyring, SecretError, parseKey } from "./crypto.js";

/** Nom du fichier de la clé maître locale, dans le dossier de données (hors base, hors dépôt). */
export const KEY_FILE_NAME = "master.key";

export interface KeyringOptions {
  /** Clé maître du `.env` (SECRETS_MASTER_KEY), ou null. Elle a priorité sur le fichier. */
  masterKey: string | null;
  /** Anciennes clés (SECRETS_MASTER_KEY_PREVIOUS) : elles déchiffrent encore, elles ne chiffrent plus. */
  previousKeys: string[];
  /** Dossier des données locales, où vit le fichier de clé. */
  dataDir: string;
  /** Mode serveur (base PostgreSQL) : la clé doit venir du `.env`, jamais d'un fichier généré dans un conteneur jetable. */
  serverMode: boolean;
  /** Dit si la base contient déjà des secrets : si oui, on ne génère jamais une nouvelle clé qui les rendrait illisibles. */
  hasSecrets: () => Promise<boolean>;
}

/**
 * Constitue le jeu de clés maîtres. Ordre de recherche : la variable SECRETS_MASTER_KEY ; sinon, en local seulement,
 * le fichier `master.key` du dossier de données, créé au premier besoin (lisible par son propriétaire seul).
 * @param options Sources de la clé et contexte d'exécution.
 * @returns Le jeu de clés, la clé courante en premier.
 * @throws SecretError Si la clé est absente en mode serveur, invalide, ou si elle est perdue alors que des secrets existent.
 */
export async function resolveKeyring(options: KeyringOptions): Promise<Keyring> {
  const previous = options.previousKeys.map(parseKey);

  if (options.masterKey) return new Keyring([parseKey(options.masterKey), ...previous]);

  if (options.serverMode) {
    throw new SecretError("SECRETS_MASTER_KEY est obligatoire en mode serveur (DATABASE_URL) : génère-la avec « openssl rand -base64 32 » et garde-la hors de la base");
  }

  const file = path.join(options.dataDir, KEY_FILE_NAME);
  if (existsSync(file)) {
    try {
      return new Keyring([parseKey(readFileSync(file, "utf8")), ...previous]);
    } catch (err) {
      throw new SecretError(`Le fichier de clé maître ${file} est invalide : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (await options.hasSecrets()) {
    throw new SecretError(
      `Des secrets sont enregistrés mais la clé maître est introuvable (${file} ou SECRETS_MASTER_KEY) : sans elle ils sont illisibles. Remets la clé en place avant de redémarrer.`,
    );
  }
  const key = randomBytes(32);
  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(file, key.toString("base64") + "\n", { flag: "wx", mode: 0o600 }); // "wx" : n'écrase jamais une clé existante
  return new Keyring([key, ...previous]);
}
