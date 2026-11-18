import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Longueur minimale et maximale d'un mot de passe (le maximum borne le coût du calcul, pas la liberté de choix). */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/** Paramètres de scrypt : 32 Mo de mémoire par calcul, de l'ordre de 100 ms. Ils sont écrits dans l'empreinte, donc modifiables plus tard sans casser les anciennes. */
const COST = 2 ** 15;
const BLOCK = 8;
const PARALLEL = 1;
const KEY_LENGTH = 32;
const MAX_MEMORY = 64 * 1024 * 1024;

/** Mot de passe refusé. Le message est destiné à l'utilisateur. */
export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

/**
 * Calcule la clé dérivée d'un mot de passe.
 * @param password Mot de passe en clair.
 * @param salt Sel.
 * @param cost Coût mémoire et processeur de scrypt (puissance de 2).
 * @param block Taille de bloc de scrypt.
 * @param parallel Parallélisation de scrypt.
 * @returns La clé dérivée.
 */
function derive(password: string, salt: Buffer, cost: number, block: number, parallel: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: cost, r: block, p: parallel, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/**
 * Vérifie qu'un mot de passe est acceptable pour un nouveau compte : de 10 à 200 caractères, et différent de l'adresse email. Aucune règle de composition
 * (majuscules, chiffres...) : elles poussent à des mots de passe plus faibles qu'une phrase longue.
 * @param password Mot de passe choisi.
 * @param email Adresse du compte, pour refuser un mot de passe qui lui est identique.
 * @returns Rien.
 * @throws PasswordError Si le mot de passe est trop court, trop long ou identique à l'adresse.
 */
export function checkPassword(password: string, email: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw new PasswordError(`Le mot de passe fait au moins ${MIN_PASSWORD_LENGTH} caractères`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new PasswordError(`Le mot de passe fait ${MAX_PASSWORD_LENGTH} caractères au plus`);
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) throw new PasswordError("Le mot de passe ne peut pas être ton adresse email");
}

/**
 * Calcule l'empreinte lente d'un mot de passe (scrypt, sel aléatoire propre à chaque mot de passe).
 * @param password Mot de passe en clair.
 * @returns L'empreinte, au format `scrypt$N$r$p$sel$clé` (sel et clé en base64url).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, COST, BLOCK, PARALLEL);
  return `scrypt$${COST}$${BLOCK}$${PARALLEL}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/**
 * Compare un mot de passe à une empreinte, en temps constant.
 * @param password Mot de passe présenté.
 * @param stored Empreinte enregistrée.
 * @returns Vrai si le mot de passe correspond ; faux aussi si l'empreinte est illisible.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, cost, block, parallel, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !cost || !block || !parallel || !salt || !key) return false;
  const n = Number(cost);
  const r = Number(block);
  const p = Number(parallel);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || n > 2 ** 17 || r < 1 || r > 32 || p < 1 || p > 8) return false; // jamais de coût lu dans la base sans borne
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), n, r, p);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Empreinte jamais associée à un compte, calculée une fois : sert à dépenser le même temps quand l'adresse est inconnue (sans cela, la durée de la réponse trahirait les comptes qui existent). */
let decoy: Promise<string> | null = null;

/**
 * Dépense le temps d'une vérification de mot de passe sans rien vérifier (adresse inconnue ou compte sans mot de passe).
 * @param password Mot de passe présenté.
 * @returns Rien.
 */
export async function spendVerificationTime(password: string): Promise<void> {
  decoy ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await decoy);
}
