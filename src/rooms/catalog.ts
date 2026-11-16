/**
 * Catalogue des salles du monde de la forge. Une salle est un fichier de DONNÉES (`public/rooms/<id>.json`) : elle ne peut contenir que ce
 * que ce catalogue permet. Le dessin de chaque objet est fait par le code du navigateur (`public/forge/sprites.js`) : une salle ne porte
 * ni code, ni image, ni HTML.
 */

/** Grille commune à toutes les salles (la forge a la même). Les trois rangées du haut sont le mur du fond, la dernière rangée est le mur de la porte. */
export const GRID = { width: 24, height: 15, floorTop: 3, floorBottom: 13, doorRow: 14 } as const;

export const THEMES = ["forge", "castle", "tavern"] as const;
export type Theme = (typeof THEMES)[number];

/** Apparences de personnages disponibles (voir `LOOKS` dans `sprites.js`). */
export const NPC_LOOKS = ["brann", "apprenti", "apprenti2", "apprenti3", "gardien", "scribe", "marchand", "king", "queen", "noble"] as const;
export type NpcLook = (typeof NPC_LOOKS)[number];

export const COLORS = ["red", "blue", "green", "purple", "gold"] as const;
export type Color = (typeof COLORS)[number];

export const DIRECTIONS = ["up", "down", "left", "right"] as const;

export interface ObjectSpec {
  /** Taille en tuiles (la taille d'un tapis se règle dans la salle). */
  w: number;
  h: number;
  /** Bloque le passage. */
  solid: boolean;
  /** `floor` : posé au sol (rangées 3 à 13). `wall` : accroché au mur du fond (rangées 0 à 2). */
  where: "floor" | "wall";
  /** La largeur et la hauteur se choisissent dans la salle. */
  resizable?: boolean;
  /** Accepte une couleur. */
  color?: boolean;
  /** Peut porter un texte que l'on lit en s'en approchant. */
  text?: boolean;
}

export const OBJECTS = {
  carpet: { w: 1, h: 1, solid: false, where: "floor", resizable: true, color: true },
  pillar: { w: 1, h: 2, solid: true, where: "floor" },
  statue: { w: 1, h: 2, solid: true, where: "floor", text: true },
  throne: { w: 2, h: 2, solid: true, where: "floor", text: true },
  table: { w: 3, h: 2, solid: true, where: "floor", text: true },
  chair: { w: 1, h: 1, solid: true, where: "floor" },
  chest: { w: 1, h: 1, solid: true, where: "floor", text: true },
  barrel: { w: 1, h: 1, solid: true, where: "floor" },
  crate: { w: 1, h: 1, solid: true, where: "floor" },
  torch: { w: 1, h: 1, solid: false, where: "wall" },
  banner: { w: 1, h: 2, solid: false, where: "wall", color: true },
  window: { w: 2, h: 2, solid: false, where: "wall", text: true },
  bookshelf: { w: 2, h: 2, solid: false, where: "wall", text: true },
} as const satisfies Record<string, ObjectSpec>;

export type ObjectType = keyof typeof OBJECTS;
export const OBJECT_TYPES = Object.keys(OBJECTS) as [ObjectType, ...ObjectType[]];

/** Limites : une salle reste petite, lisible, et ne peut pas servir à saturer le navigateur. */
export const LIMITS = {
  objects: 80,
  npcs: 8,
  doors: 4,
  lines: 8,
  lineLength: 220,
  textLength: 220,
  nameLength: 40,
  npcNameLength: 30,
  labelLength: 40,
  totalText: 6000,
  fileBytes: 64 * 1024,
  files: 50,
} as const;

/** Identifiant de la forge elle-même : toujours présente, jamais définie par un fichier. */
export const FORGE_ROOM_ID = "forge";
