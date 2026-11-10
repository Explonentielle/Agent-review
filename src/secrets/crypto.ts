import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Version du format de l'enveloppe : permet de changer d'algorithme plus tard sans perdre les secrets existants. */
const FORMAT = "v1";

/** Problème de chiffrement, de clé ou de secret illisible. Le message ne contient jamais de clé ni de valeur. */
export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/**
 * Identifiant public d'une clé (début de son empreinte SHA-256) : il sert à retrouver la bonne clé au
 * déchiffrement après une rotation, sans rien révéler de la clé.
 * @param key Clé de 32 octets.
 * @returns 8 caractères hexadécimaux.
 */
function keyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * Convertit une clé maître saisie en base64 en 32 octets.
 * @param text Clé en base64 (ou base64url), par exemple produite par `openssl rand -base64 32`.
 * @returns La clé en octets.
 * @throws SecretError Si le texte n'est pas une clé de 32 octets.
 */
export function parseKey(text: string): Buffer {
  const trimmed = text.trim();
  const bytes = /^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed) ? Buffer.from(trimmed, "base64") : Buffer.alloc(0);
  if (bytes.length !== KEY_BYTES) throw new SecretError("Clé maître invalide : elle doit faire 32 octets encodés en base64 (génère-la avec : openssl rand -base64 32)");
  return bytes;
}

/**
 * Jeu de clés maîtres : la première chiffre, toutes déchiffrent. Après une rotation, les anciennes clés
 * restent là le temps de rechiffrer les secrets existants avec la nouvelle.
 */
export class Keyring {
  private readonly byId = new Map<string, Buffer>();
  private readonly currentId: string;

  /**
   * @param keys Clés de 32 octets, la clé courante en premier.
   * @throws SecretError Si la liste est vide ou si une clé n'a pas la bonne taille.
   */
  constructor(keys: Buffer[]) {
    if (keys.length === 0) throw new SecretError("Aucune clé maître");
    for (const key of keys) {
      if (key.length !== KEY_BYTES) throw new SecretError("Clé maître invalide : 32 octets attendus");
      this.byId.set(keyId(key), key);
    }
    this.currentId = keyId(keys[0]!);
  }

  /** Identifiant de la clé qui chiffre les nouveaux secrets. */
  get currentKeyId(): string {
    return this.currentId;
  }

  /**
   * Clé correspondant à un identifiant.
   * @param id Identifiant lu dans l'enveloppe d'un secret.
   * @returns La clé, ou undefined si elle n'est pas dans le jeu.
   */
  find(id: string): Buffer | undefined {
    return this.byId.get(id);
  }
}

/**
 * Identifiant de la clé qui a chiffré une enveloppe.
 * @param envelope Enveloppe produite par `seal`.
 * @returns L'identifiant de clé, ou null si le format n'est pas reconnu.
 */
export function envelopeKeyId(envelope: string): string | null {
  const parts = envelope.split(":");
  return parts.length === 5 && parts[0] === FORMAT ? parts[1]! : null;
}

/**
 * Chiffre une valeur avec AES-256-GCM. Le contexte est authentifié mais pas stocké : recopier l'enveloppe dans
 * une autre ligne (autre espace, autre utilisateur, autre nom) la rend illisible.
 * @param keyring Jeu de clés (la clé courante chiffre).
 * @param plaintext Valeur à protéger.
 * @param context Contexte lié à l'enveloppe (par exemple l'espace, l'utilisateur et le nom du secret).
 * @returns Enveloppe texte « v1:clé:iv:tag:donnée », chaque partie en base64url.
 */
export function seal(keyring: Keyring, plaintext: string, context: string): string {
  const key = keyring.find(keyring.currentKeyId)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [FORMAT, keyring.currentKeyId, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(":");
}

/**
 * Déchiffre une enveloppe produite par `seal`.
 * @param keyring Jeu de clés (l'enveloppe indique laquelle utiliser).
 * @param envelope Enveloppe stockée.
 * @param context Contexte avec lequel la valeur a été chiffrée.
 * @returns La valeur en clair.
 * @throws SecretError Si le format est inconnu, la clé absente du jeu, ou si la donnée ou son contexte ont été modifiés.
 */
export function open(keyring: Keyring, envelope: string, context: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 5 || parts[0] !== FORMAT) throw new SecretError("Secret illisible : format inconnu");
  const key = keyring.find(parts[1]!);
  if (!key) throw new SecretError("Secret illisible : la clé maître qui l'a chiffré n'est pas disponible");
  try {
    const iv = Buffer.from(parts[2]!, "base64url");
    const tag = Buffer.from(parts[3]!, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("taille");
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[4]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("Secret illisible : donnée modifiée ou déplacée");
  }
}
