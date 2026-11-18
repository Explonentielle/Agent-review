import { z } from "zod";
import type { SettingsStore } from "../settings/store.js";
import { WEAPON_TYPE_IDS, type WeaponTypeId } from "./armory.js";

/**
 * Réglages propres au jeu (la forge), rangés par le magasin de réglages sous leur propre section : le noyau de l'outil n'en connaît ni le
 * contenu ni le schéma. Un drapeau pour allumer ou éteindre le jeu, et le type d'arme de chaque projet une fois choisi.
 */

/** Nom de la section du jeu dans le magasin de réglages. */
const SECTION = "game";

export const GamePrefsSchema = z.object({
  /** Le jeu est-il allumé ? Éteint : aucune route du jeu ne répond et la page n'en charge rien. */
  enabled: z.boolean().default(true),
  /** Type d'arme choisi par projet (clé `source:projectId`) : une fois choisi, il ne change plus. */
  weaponTypes: z.record(z.string(), z.enum(WEAPON_TYPE_IDS)).default({}),
});

export type GamePrefs = z.infer<typeof GamePrefsSchema>;

/** Le type d'arme d'un projet est déjà choisi : il ne peut plus changer. */
export class WeaponLockedError extends Error {}

/**
 * @param source Forge du projet.
 * @param projectId Identifiant du projet chez la forge.
 * @returns La clé d'un projet dans les réglages du jeu.
 */
export const weaponKey = (source: string, projectId: number): string => `${source}:${projectId}`;

/**
 * Lit les réglages du jeu de l'espace (valeurs par défaut si rien n'est enregistré ou si la section est illisible).
 * @param store Magasin de réglages de l'espace.
 * @returns Les réglages du jeu.
 */
export async function readGamePrefs(store: Pick<SettingsStore, "getSection">): Promise<GamePrefs> {
  const parsed = GamePrefsSchema.safeParse((await store.getSection(SECTION)) ?? {});
  return parsed.success ? parsed.data : GamePrefsSchema.parse({});
}

/**
 * Allume ou éteint le jeu pour l'espace.
 * @param store Magasin de réglages de l'espace.
 * @param enabled Vrai pour allumer le jeu.
 * @returns Les réglages du jeu à jour.
 */
export async function setGameEnabled(store: Pick<SettingsStore, "getSection" | "saveSection">, enabled: boolean): Promise<GamePrefs> {
  const next = { ...(await readGamePrefs(store)), enabled };
  await store.saveSection(SECTION, next);
  return next;
}

/**
 * Fixe le type d'arme d'un projet. Choisir deux fois le même type est sans effet ; en choisir un autre est refusé.
 * @param store Magasin de réglages de l'espace.
 * @param source Forge du projet.
 * @param projectId Identifiant du projet chez la forge.
 * @param type Type d'arme choisi.
 * @returns Les réglages du jeu à jour.
 * @throws WeaponLockedError Si le projet a déjà un autre type d'arme.
 */
export async function chooseWeaponType(store: Pick<SettingsStore, "getSection" | "saveSection">, source: string, projectId: number, type: WeaponTypeId): Promise<GamePrefs> {
  const prefs = await readGamePrefs(store);
  const key = weaponKey(source, projectId);
  const kept = prefs.weaponTypes[key];
  if (kept && kept !== type) throw new WeaponLockedError("Le type d'arme d'un projet ne peut pas être modifié une fois choisi");
  const next = { ...prefs, weaponTypes: { ...prefs.weaponTypes, [key]: type } };
  await store.saveSection(SECTION, next);
  return next;
}

/**
 * Ajoute à chaque projet son type d'arme choisi (les autres gardent le type par défaut tiré de leur clé, au calcul de l'armurerie).
 * @param projects Projets configurés.
 * @param prefs Réglages du jeu.
 * @returns Les mêmes projets, avec `weaponType` quand il a été choisi.
 */
export function withWeaponTypes<T extends { source: string; projectId: number }>(projects: T[], prefs: GamePrefs): Array<T & { weaponType?: WeaponTypeId }> {
  return projects.map((p) => {
    const weaponType = prefs.weaponTypes[weaponKey(p.source, p.projectId)];
    return weaponType ? { ...p, weaponType } : p;
  });
}
