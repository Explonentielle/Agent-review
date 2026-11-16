/**
 * Butin de la forge : des objets de collection (tenues et armes), avec une rareté, qui tombent quand tu travailles pour de vrai : une pièce
 * forgée par l'agent dev, une review terminée, une pièce fusionnée. Tout est déduit de l'activité réelle et le hasard est **déterministe** :
 * le tirage d'un événement ne dépend que de son identifiant, donc recharger la page ne change rien et on ne peut pas « farmer » en
 * relançant. Aucune table, aucune donnée à migrer. Le navigateur retient ce qu'il a déjà ramassé (voir `public/forge/items.js`).
 */
import { gradeOfScore, itemScore, type ArmoryTask, type Grade } from "./armory.js";
import { REVIEW_DONE, TASK_FORGED } from "./hero.js";

export type ItemKind = "cosmetic" | "weapon";
export type CosmeticPart = "cape" | "hat" | "apron";

export interface LootItem {
  id: string;
  kind: ItemKind;
  rarity: Grade;
  name: string;
  /** Tenue : emplacement et valeur (couleur, ou nom du couvre-chef dessiné par le jeu). */
  part?: CosmeticPart;
  value?: string;
  /** Arme : type dessiné par le jeu (épée, hache...). */
  weapon?: string;
}

export const RARITIES: Grade[] = ["common", "rare", "epic", "legendary"];

const cosmetic = (id: string, rarity: Grade, name: string, part: CosmeticPart, value: string): LootItem => ({ id, kind: "cosmetic", rarity, name, part, value });

/** Tenues qui peuvent tomber. Les couleurs et les couvre-chefs sont dessinés par le jeu (`public/forge/sprites.js`). */
const COSMETICS: LootItem[] = [
  cosmetic("cape-grey", "common", "Cape grise", "cape", "#8a8794"),
  cosmetic("cape-brown", "common", "Cape brune", "cape", "#7a5a3a"),
  cosmetic("cape-green", "common", "Cape de lierre", "cape", "#3a7a4a"),
  cosmetic("cape-blue", "rare", "Cape bleue royale", "cape", "#2a4f9a"),
  cosmetic("cape-plum", "rare", "Cape prune", "cape", "#7a3a9a"),
  cosmetic("cape-shadow", "epic", "Cape d'ombre", "cape", "#2a1f3a"),
  cosmetic("cape-flame", "epic", "Cape de braise", "cape", "#d8541a"),
  cosmetic("cape-astral", "legendary", "Cape astrale", "cape", "#5a3ad8"),
  cosmetic("apron-leather", "common", "Tablier de cuir", "apron", "#6b4423"),
  cosmetic("apron-grey", "common", "Tablier de toile", "apron", "#8a8794"),
  cosmetic("apron-azure", "rare", "Tablier azur", "apron", "#3a7ab0"),
  cosmetic("apron-ember", "epic", "Tablier de braise", "apron", "#c9541a"),
  cosmetic("apron-gold", "legendary", "Tablier d'or pur", "apron", "#ffd24a"),
  cosmetic("hat-bandana", "common", "Bandana", "hat", "bandana"),
  cosmetic("hat-cap", "common", "Casquette d'apprenti", "hat", "cap"),
  cosmetic("hat-feather", "rare", "Toque à plume", "hat", "feather"),
  cosmetic("hat-viking", "rare", "Casque à cornes", "hat", "viking"),
  cosmetic("hat-knight", "epic", "Heaume de chevalier", "hat", "knight"),
  cosmetic("hat-wizard", "epic", "Chapeau de mage", "hat", "wizard"),
  cosmetic("hat-crown", "legendary", "Couronne de maître forgeron", "hat", "crown"),
];

/** Types d'armes dessinés par le jeu, avec leur nom (le féminin sert à accorder « rouillée »). */
const WEAPON_TYPES: Array<{ id: string; name: string; feminine: boolean }> = [
  { id: "sword", name: "Épée", feminine: true },
  { id: "axe", name: "Hache", feminine: true },
  { id: "hammer", name: "Marteau", feminine: false },
  { id: "dagger", name: "Dague", feminine: true },
  { id: "spear", name: "Lance", feminine: true },
  { id: "bow", name: "Arc", feminine: false },
  { id: "staff", name: "Bâton", feminine: false },
];
const WEAPON_ADJECTIVE: Record<Grade, (feminine: boolean) => string> = {
  common: (f) => (f ? "rouillée" : "rouillé"),
  rare: () => "d'acier",
  epic: () => "runique",
  legendary: () => "mythique",
};

const WEAPONS: LootItem[] = WEAPON_TYPES.flatMap((t) =>
  RARITIES.map((rarity): LootItem => ({ id: `weapon-${t.id}-${rarity}`, kind: "weapon", rarity, name: `${t.name} ${WEAPON_ADJECTIVE[rarity](t.feminine)}`, weapon: t.id })),
);

/** Tout ce qui peut tomber. */
export const LOOT_CATALOG: LootItem[] = [...COSMETICS, ...WEAPONS];

export type LootEventKind = "forge" | "review" | "merge";

export interface LootEvent {
  /** Identifiant stable : il sert de graine au tirage et à savoir si le butin a déjà été ramassé. */
  id: string;
  kind: LootEventKind;
  at: string;
  /** Qualité de la pièce (forge et fusion) : une meilleure pièce donne de meilleures chances. */
  quality: Grade;
}

export interface Drop {
  eventId: string;
  event: LootEventKind;
  at: string;
  itemId: string;
  rarity: Grade;
}

/** Poids des raretés (commun, rare, épique, légendaire), sur 100. */
const WEIGHTS: Record<LootEventKind, [number, number, number, number]> = {
  forge: [55, 30, 11, 4],
  review: [55, 30, 11, 4],
  // Une fusion est un aboutissement : de meilleures chances
  merge: [35, 35, 20, 10],
};
/** Une pièce de meilleure qualité déplace des chances du commun vers les raretés supérieures (de 0 à 3 crans). */
const QUALITY_SHIFT: Record<Grade, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
/** Chance qu'une review rapporte quelque chose (forge et fusion rapportent toujours). */
const REVIEW_CHANCE = 0.5;
/** Part des armes parmi les objets qui tombent. */
const WEAPON_SHARE = 0.35;

/**
 * Générateur pseudo-aléatoire déterministe : la même graine donne toujours la même suite de nombres entre 0 et 1.
 * @param seed Texte qui sert de graine (l'identifiant de l'événement).
 * @returns Une fonction qui renvoie le nombre suivant.
 */
export function seededRandom(seed: string): () => number {
  // FNV-1a pour mélanger le texte en un entier, puis mulberry32
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Poids de chaque rareté pour un événement.
 * @param kind Genre d'événement.
 * @param quality Qualité de la pièce.
 * @returns Quatre poids (commun, rare, épique, légendaire) qui totalisent 100.
 */
export function rarityWeights(kind: LootEventKind, quality: Grade): [number, number, number, number] {
  const [c, r, e, l] = WEIGHTS[kind];
  const q = QUALITY_SHIFT[quality];
  // On retire 10 points au commun par cran, répartis : 4 au rare, 4 à l'épique, 2 au légendaire
  return [c - 10 * q, r + 4 * q, e + 4 * q, l + 2 * q];
}

/**
 * Tirage du butin d'un événement.
 * @param event Événement réel (pièce forgée, review terminée, pièce fusionnée).
 * @returns L'objet qui tombe, ou null si l'événement ne rapporte rien (une review sur deux).
 */
export function rollDrop(event: LootEvent): Drop | null {
  const rand = seededRandom(event.id);
  if (event.kind === "review" && rand() >= REVIEW_CHANCE) return null;

  const weights = rarityWeights(event.kind, event.quality);
  let pick = rand() * 100;
  let rarity: Grade = "common";
  for (let i = 0; i < RARITIES.length; i++) {
    if (pick < weights[i]!) { rarity = RARITIES[i]!; break; }
    pick -= weights[i]!;
    rarity = RARITIES[i]!;
  }

  const wantWeapon = rand() < WEAPON_SHARE;
  const pool = LOOT_CATALOG.filter((item) => item.rarity === rarity && (item.kind === "weapon") === wantWeapon);
  const item = pool[Math.floor(rand() * pool.length)]!;
  return { eventId: event.id, event: event.kind, at: event.at, itemId: item.id, rarity };
}

/** Ce que le calcul lit de l'outil. */
export interface LootInput {
  tasks: Array<Pick<ArmoryTask, "id" | "status" | "files_changed" | "num_turns" | "mode" | "updated_at">>;
  reviews: Array<{ id: number; status: string; updated_at: string }>;
  /** Tâches dont la MR a été fusionnée depuis l'outil. */
  mergedTaskIds: number[];
}

/**
 * Événements qui rapportent du butin, d'après l'activité réelle.
 * @param input Tâches de l'agent dev, reviews terminées et fusions.
 * @returns Les événements, les plus récents d'abord.
 */
export function lootEvents(input: LootInput): LootEvent[] {
  const events: LootEvent[] = [];
  const merged = new Set(input.mergedTaskIds);
  for (const task of input.tasks) {
    if (!TASK_FORGED.includes(task.status)) continue;
    const quality = gradeOfScore(itemScore(task));
    events.push({ id: `forge-${task.id}`, kind: "forge", at: task.updated_at, quality });
    if (merged.has(task.id)) events.push({ id: `merge-${task.id}`, kind: "merge", at: task.updated_at, quality });
  }
  for (const review of input.reviews) {
    if (REVIEW_DONE.includes(review.status)) events.push({ id: `review-${review.id}`, kind: "review", at: review.updated_at, quality: "common" });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Tout le butin que l'activité réelle a rapporté.
 * @param input Tâches, reviews et fusions.
 * @returns Les objets tombés, les plus récents d'abord.
 */
export function computeDrops(input: LootInput): Drop[] {
  return lootEvents(input).flatMap((event) => rollDrop(event) ?? []);
}
