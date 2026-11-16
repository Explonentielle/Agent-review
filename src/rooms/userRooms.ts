import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIMITS } from "./catalog.js";
import { validateRoom, type Room } from "./schema.js";

/** Qui voit une salle : seulement son auteur (par défaut), ou tous les membres de son espace. */
export type Visibility = "private" | "team";
export const VISIBILITIES: readonly Visibility[] = ["private", "team"];

export interface RoomMeta {
  ownerId: number;
  visibility: Visibility;
  createdAt: string;
  updatedAt: string;
}
export interface StoredRoom {
  room: Room;
  meta: RoomMeta;
}

/** Refus lisible par la personne (salle invalide, plafond atteint, salle introuvable ou d'un autre). */
export class RoomStoreError extends Error {
  constructor(message: string, readonly status = 400, readonly errors: string[] = []) {
    super(message);
    this.name = "RoomStoreError";
  }
}

/** Plafond de salles par personne. */
export const MAX_ROOMS_PER_USER = 20;

/** Identifiant d'une salle d'utilisateur : « u<id de l'auteur>-<nom> ». Il porte l'auteur : on sait dans quel dossier la lire sans parcourir les autres. */
const USER_ROOM_ID = /^u(\d{1,9})-[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?$/;

/** @returns L'auteur d'après l'identifiant d'une salle d'utilisateur, ou null si ce n'en est pas une. */
export function ownerOfRoomId(id: string): number | null {
  const m = USER_ROOM_ID.exec(id);
  return m ? Number(m[1]) : null;
}

function slugify(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Règles imposées à une salle d'utilisateur, quoi que dise la salle reçue : l'identifiant est celui qu'on lui donne, pas de porte magique dans la
 * forge, et des portes qui ne mènent qu'à la forge.
 * @param input Salle proposée (objet JSON).
 * @param id Identifiant à lui donner.
 * @returns La salle prête à être validée.
 */
export function normalizeUserRoom(input: Record<string, unknown>, id: string): Record<string, unknown> {
  const doors = Array.isArray(input.doors) ? (input.doors as Array<Record<string, unknown>>).map((d) => ({ ...d, to: "forge", spawn: undefined })) : input.doors;
  return { ...input, id, hub: false, doors };
}

/**
 * Salles créées par les personnes, rangées en fichiers sous `<racine>/<espace>/<auteur>/<id>.json` : sans table ni migration. Un espace ne voit jamais
 * les salles d'un autre (tous les chemins en dérivent), et à l'intérieur d'un espace une salle est PRIVÉE tant que son auteur ne la partage pas à l'équipe.
 * Chaque fichier est revalidé à chaque lecture : un fichier abîmé ou modifié à la main est ignoré, jamais servi.
 * @param root Dossier racine (`<DATA_DIR>/rooms`), partagé par toutes les personnes de l'installation.
 * @param workspaceId Espace servi.
 * @returns Les opérations sur les salles de cet espace.
 */
export function createRoomStore(root: string, workspaceId: number) {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) throw new Error("Espace invalide");
  const base = path.resolve(root, String(workspaceId));
  const dirOf = (userId: number) => {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new RoomStoreError("Personne invalide.");
    return path.join(base, String(userId));
  };

  /** Lit et revalide un fichier de salle ; null s'il est absent, illisible, invalide ou ne correspond pas à son dossier. */
  async function readFileRoom(userId: number, id: string): Promise<StoredRoom | null> {
    try {
      const raw = JSON.parse(await readFile(path.join(dirOf(userId), `${id}.json`), "utf8")) as { meta?: Partial<RoomMeta>; room?: unknown };
      const result = validateRoom(raw.room);
      const meta = raw.meta;
      if (!result.ok || result.room.id !== id || ownerOfRoomId(id) !== userId) return null;
      if (!meta || meta.ownerId !== userId || !VISIBILITIES.includes(meta.visibility as Visibility)) return null;
      return { room: result.room, meta: { ownerId: userId, visibility: meta.visibility as Visibility, createdAt: String(meta.createdAt ?? ""), updatedAt: String(meta.updatedAt ?? "") } };
    } catch {
      return null;
    }
  }

  async function idsOf(userId: number): Promise<string[]> {
    const dir = dirOf(userId); // une personne invalide est refusée ici, pas confondue avec un dossier absent
    try {
      return (await readdir(dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => ownerOfRoomId(id) === userId);
    } catch {
      return [];
    }
  }

  const canSee = (stored: StoredRoom, userId: number) => stored.meta.ownerId === userId || stored.meta.visibility === "team";

  return {
    /** Les salles que cette personne peut visiter : les siennes, et celles que d'autres membres de l'espace ont partagées à l'équipe. */
    async list(userId: number): Promise<StoredRoom[]> {
      let owners: number[];
      try {
        owners = (await readdir(base)).filter((d) => /^\d{1,9}$/.test(d)).map(Number);
      } catch {
        return [];
      }
      const out: StoredRoom[] = [];
      for (const owner of owners) {
        for (const id of await idsOf(owner)) {
          const stored = await readFileRoom(owner, id);
          if (stored && canSee(stored, userId)) out.push(stored);
        }
      }
      return out.sort((a, b) => Number(b.meta.ownerId === userId) - Number(a.meta.ownerId === userId) || a.room.name.localeCompare(b.room.name, "fr"));
    },

    /** Une salle, si cette personne a le droit de la voir (sinon comme si elle n'existait pas). */
    async get(userId: number, id: string): Promise<StoredRoom | null> {
      const owner = ownerOfRoomId(id);
      if (owner === null) return null;
      const stored = await readFileRoom(owner, id);
      return stored && canSee(stored, userId) ? stored : null;
    },

    /** Nombre de salles de cette personne. */
    async count(userId: number): Promise<number> {
      return (await idsOf(userId)).length;
    },

    /**
     * Valide puis range une salle. Les règles de sécurité sont IMPOSÉES ici, quoi que dise la salle reçue : l'identifiant est celui de l'auteur, la
     * salle n'a pas de porte magique dans la forge, et ses portes ne mènent qu'à la forge. Privée par défaut.
     * @param userId Auteur.
     * @param raw Salle proposée (par un agent ou à la main).
     * @param options `visibility` (privée par défaut), `id` pour mettre à jour une de ses salles.
     * @param taken Identifiants déjà pris ailleurs (salles livrées avec l'outil).
     * @returns La salle rangée.
     * @throws RoomStoreError Salle invalide (avec la liste des erreurs), plafond atteint ou salle d'un autre.
     */
    async save(userId: number, raw: unknown, options: { visibility?: Visibility; id?: string } = {}, taken: ReadonlySet<string> = new Set()): Promise<StoredRoom> {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RoomStoreError("La salle doit être un objet.", 400);
      const visibility = options.visibility ?? "private";
      if (!VISIBILITIES.includes(visibility)) throw new RoomStoreError("Visibilité inconnue : privée ou équipe.");
      const existing = options.id ? await readFileRoom(userId, options.id) : null;
      if (options.id && !existing) throw new RoomStoreError("Salle introuvable.", 404);
      const mine = await idsOf(userId);
      if (!existing && mine.length >= MAX_ROOMS_PER_USER) throw new RoomStoreError(`Tu as déjà ${MAX_ROOMS_PER_USER} salles : supprime-en une avant d'en créer une autre.`, 409);

      const input = raw as Record<string, unknown>;
      let id = options.id;
      if (!id) {
        const prefix = `u${userId}-`;
        const slug = slugify(String(input.name ?? input.id ?? "salle")).slice(0, 29 - prefix.length).replace(/-+$/, "") || "salle";
        id = `${prefix}${slug}`;
        for (let n = 2; mine.includes(id) || taken.has(id); n++) id = `${prefix}${slug.slice(0, 29 - prefix.length - String(n).length - 1)}-${n}`;
      }
      const result = validateRoom(normalizeUserRoom(input, id));
      if (!result.ok) throw new RoomStoreError("La salle est invalide.", 422, result.errors);
      const body = JSON.stringify(result.room);
      if (body.length > LIMITS.fileBytes) throw new RoomStoreError(`La salle est trop grosse (${LIMITS.fileBytes} octets au plus).`, 413);

      const now = new Date().toISOString();
      const meta: RoomMeta = { ownerId: userId, visibility, createdAt: existing?.meta.createdAt || now, updatedAt: now };
      await mkdir(dirOf(userId), { recursive: true });
      const target = path.join(dirOf(userId), `${id}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ meta, room: result.room }, null, 2), "utf8");
      await rename(temp, target);
      return { room: result.room, meta };
    },

    /** Change qui voit une salle. Seul son auteur le peut. */
    async setVisibility(userId: number, id: string, visibility: Visibility): Promise<StoredRoom> {
      if (!VISIBILITIES.includes(visibility)) throw new RoomStoreError("Visibilité inconnue : privée ou équipe.");
      const stored = await readFileRoom(userId, id);
      if (!stored) throw new RoomStoreError("Salle introuvable.", 404);
      const meta: RoomMeta = { ...stored.meta, visibility, updatedAt: new Date().toISOString() };
      const target = path.join(dirOf(userId), `${id}.json`);
      const temp = `${target}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify({ meta, room: stored.room }, null, 2), "utf8");
      await rename(temp, target);
      return { room: stored.room, meta };
    },

    /** Supprime une salle. Seul son auteur le peut. */
    async remove(userId: number, id: string): Promise<void> {
      if (!(await readFileRoom(userId, id))) throw new RoomStoreError("Salle introuvable.", 404);
      await rm(path.join(dirOf(userId), `${id}.json`), { force: true });
    },
  };
}

export type RoomStore = ReturnType<typeof createRoomStore>;
