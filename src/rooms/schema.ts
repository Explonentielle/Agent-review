import { z } from "zod";
import { COLORS, DIRECTIONS, DOOR_STYLES, FORGE_ROOM_ID, GRID, LIMITS, NPC_LOOKS, OBJECTS, OBJECT_TYPES, THEMES, type ObjectType } from "./catalog.js";
import { GameSchema, checkGame } from "./game.js";
import { text } from "./text.js";

/** Identifiant : minuscules, chiffres et tirets. Il sert aussi de nom de fichier. */
const ID = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;

const tile = z.number().int().min(0).max(GRID.width - 1);
const row = z.number().int().min(0).max(GRID.height - 1);

const ObjectSchema = z
  .object({
    type: z.enum(OBJECT_TYPES),
    x: tile,
    y: row,
    w: z.number().int().min(1).max(GRID.width).optional(),
    h: z.number().int().min(1).max(GRID.height).optional(),
    color: z.enum(COLORS).optional(),
    text: text(LIMITS.textLength).optional(),
  })
  .strict();

const NpcSchema = z
  .object({
    id: z.string().regex(ID, "identifiant : minuscules, chiffres et tirets"),
    name: text(LIMITS.npcNameLength),
    look: z.enum(NPC_LOOKS),
    x: tile,
    y: row,
    dir: z.enum(DIRECTIONS).default("down"),
    lines: z.array(text(LIMITS.lineLength)).min(1).max(LIMITS.lines),
    /** Ce personnage propose le jeu de la salle (« Jouer ? » après ses répliques). Il faut alors un `game`. */
    plays: z.boolean().optional(),
  })
  .strict();

const DoorSchema = z
  .object({
    /** Première des deux tuiles de la porte, dans le mur du bas. */
    x: tile,
    /** Salle d'arrivée : `forge` ou une autre salle. */
    to: z.string().regex(ID),
    label: text(LIMITS.labelLength),
    /** Dessin de la porte : `wood` (par défaut) ou `iron`. */
    style: z.enum(DOOR_STYLES).optional(),
    /** Où apparaît la personne dans la salle d'arrivée ; absent : le point d'arrivée de cette salle. */
    spawn: z.tuple([tile, row]).optional(),
  })
  .strict();

export const RoomSchema = z
  .object({
    format: z.literal(1),
    id: z.string().regex(ID, "identifiant : minuscules, chiffres et tirets").refine((v) => v !== FORGE_ROOM_ID, "« forge » est réservé"),
    name: text(LIMITS.nameLength),
    theme: z.enum(THEMES),
    /** Montrer une porte vers cette salle dans la forge (trois salles au plus, par ordre d'identifiant). */
    hub: z.boolean().default(false),
    /** Où apparaît la personne qui entre. */
    spawn: z.tuple([tile, row]),
    objects: z.array(ObjectSchema).max(LIMITS.objects).default([]),
    npcs: z.array(NpcSchema).max(LIMITS.npcs).default([]),
    doors: z.array(DoorSchema).min(1, "une salle a au moins une porte, sinon on n'en sort pas").max(LIMITS.doors),
    /** Un jeu décrit en données (src/rooms/game.ts), lancé par le personnage qui a `plays: true`. */
    game: GameSchema.optional(),
  })
  .strict();

export type Room = z.infer<typeof RoomSchema>;
export type RoomObject = z.infer<typeof ObjectSchema>;

export type RoomResult = { ok: true; room: Room } | { ok: false; errors: string[] };

/** Rectangle occupé par un objet, taille du catalogue ou, pour un tapis, celle choisie dans la salle. */
export function footprint(o: RoomObject): { x: number; y: number; w: number; h: number } {
  const spec = OBJECTS[o.type];
  return { x: o.x, y: o.y, w: "resizable" in spec && spec.resizable ? (o.w ?? 1) : spec.w, h: "resizable" in spec && spec.resizable ? (o.h ?? 1) : spec.h };
}

const key = (x: number, y: number): string => `${x},${y}`;

/**
 * Valide une salle : forme du fichier, puis règles de la grille (tout est dans la salle, au bon endroit, sans chevauchement) et enfin
 * jouabilité (on peut atteindre chaque personnage, chaque objet à lire et chaque porte depuis l'arrivée).
 * @param raw Contenu JSON déjà lu du fichier.
 * @returns La salle validée, ou la liste des problèmes, en français, tous à la fois.
 */
export function validateRoom(raw: unknown): RoomResult {
  const parsed = RoomSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "salle"} : ${i.message}`) };
  const room = parsed.data;
  const errors: string[] = [];

  const solid = new Set<string>();
  const place = (what: string, x: number, y: number, w: number, h: number, blocks: boolean) => {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (blocks) {
          if (solid.has(key(i, j))) errors.push(`${what} : la case ${i},${j} est déjà occupée`);
          solid.add(key(i, j));
        }
      }
    }
  };

  room.objects.forEach((o, n) => {
    const name = `objects.${n} (${o.type})`;
    const spec = OBJECTS[o.type as ObjectType];
    const resizable = "resizable" in spec && spec.resizable;
    if (!resizable && (o.w !== undefined || o.h !== undefined)) errors.push(`${name} : la taille de cet objet est fixe (${spec.w} x ${spec.h}), retire w et h`);
    if (!("color" in spec && spec.color) && o.color !== undefined) errors.push(`${name} : cet objet n'a pas de couleur`);
    if (!("text" in spec && spec.text) && o.text !== undefined) errors.push(`${name} : cet objet ne peut pas porter de texte`);
    const f = footprint(o);
    const top = spec.where === "floor" ? GRID.floorTop : 0;
    const bottom = spec.where === "floor" ? GRID.floorBottom : GRID.floorTop - 1;
    if (o.x + f.w > GRID.width || o.y < top || o.y + f.h - 1 > bottom) {
      errors.push(`${name} : sort de la zone permise (${spec.where === "floor" ? `sol : colonnes 0 à ${GRID.width - 1}, rangées ${GRID.floorTop} à ${GRID.floorBottom}` : `mur du fond : rangées 0 à ${GRID.floorTop - 1}`})`);
      return;
    }
    place(name, f.x, f.y, f.w, f.h, spec.solid);
  });

  const npcIds = new Set<string>();
  room.npcs.forEach((n, i) => {
    const name = `npcs.${i} (${n.name})`;
    if (npcIds.has(n.id)) errors.push(`${name} : identifiant « ${n.id} » en double`);
    npcIds.add(n.id);
    if (n.y < GRID.floorTop || n.y > GRID.floorBottom) { errors.push(`${name} : un personnage se tient au sol (rangées ${GRID.floorTop} à ${GRID.floorBottom})`); return; }
    place(name, n.x, n.y, 1, 1, true);
  });

  if (room.spawn[1] < GRID.floorTop || room.spawn[1] > GRID.floorBottom) errors.push(`spawn : doit être au sol (rangées ${GRID.floorTop} à ${GRID.floorBottom})`);
  else if (solid.has(key(...room.spawn))) errors.push("spawn : cette case est occupée");

  const doorTiles = new Set<string>();
  room.doors.forEach((d, i) => {
    const name = `doors.${i} (${d.label})`;
    if (d.x < 1 || d.x + 1 > GRID.width - 2) errors.push(`${name} : x doit être entre 1 et ${GRID.width - 3} (une porte fait deux tuiles de large)`);
    for (const dx of [0, 1]) {
      if (doorTiles.has(key(d.x + dx, GRID.doorRow))) errors.push(`${name} : chevauche une autre porte`);
      doorTiles.add(key(d.x + dx, GRID.doorRow));
    }
    if (d.spawn && (d.spawn[1] < GRID.floorTop || d.spawn[1] > GRID.floorBottom)) errors.push(`${name} : spawn doit être au sol`);
  });

  const players = room.npcs.filter((n) => n.plays);
  if (room.game && players.length === 0) errors.push("game : personne ne propose ce jeu, mets « plays: true » sur un personnage");
  if (!room.game && players.length > 0) errors.push(`npcs : ${players[0]!.name} propose un jeu mais la salle n'a pas de « game »`);
  if (players.length > 1) errors.push("npcs : un seul personnage propose le jeu de la salle");
  if (room.game) errors.push(...checkGame(room.game).map((e) => `game.${e}`));

  const total = [...room.npcs.flatMap((n) => n.lines), ...room.objects.map((o) => o.text ?? "")].join("").length;
  if (total > LIMITS.totalText) errors.push(`textes : ${total} caractères au total, ${LIMITS.totalText} au plus`);

  if (errors.length === 0) errors.push(...reachabilityErrors(room, solid));
  return errors.length ? { ok: false, errors } : { ok: true, room };
}

/** Parcours depuis l'arrivée : tout ce qui se touche ou se lit doit être atteignable. */
function reachabilityErrors(room: Room, solid: Set<string>): string[] {
  const seen = new Set<string>([key(...room.spawn)]);
  const queue: Array<[number, number]> = [room.spawn];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= GRID.width || ny < GRID.floorTop || ny > GRID.floorBottom || solid.has(key(nx, ny)) || seen.has(key(nx, ny))) continue;
      seen.add(key(nx, ny));
      queue.push([nx, ny]);
    }
  }
  /** Une case libre atteignable à côté du rectangle (on touche un objet depuis une case voisine, en le regardant). */
  const touchable = (x: number, y: number, w: number, h: number): boolean => {
    for (let j = y - 1; j <= y + h; j++) for (let i = x - 1; i <= x + w; i++) {
      const inside = i >= x && i < x + w && j >= y && j < y + h;
      const diagonal = (i < x || i >= x + w) && (j < y || j >= y + h);
      if (!inside && !diagonal && seen.has(key(i, j))) return true;
    }
    return false;
  };
  const errors: string[] = [];
  room.npcs.forEach((n) => { if (!touchable(n.x, n.y, 1, 1)) errors.push(`${n.name} est inatteignable depuis l'arrivée`); });
  room.objects.forEach((o) => {
    if (o.text === undefined) return;
    const f = footprint(o);
    if (!touchable(f.x, f.y, f.w, f.h)) errors.push(`${o.type} à ${o.x},${o.y} porte un texte mais on ne peut pas l'atteindre`);
  });
  room.doors.forEach((d) => { if (!touchable(d.x, GRID.doorRow, 2, 1)) errors.push(`la porte « ${d.label} » est inatteignable depuis l'arrivée`); });
  return errors;
}
