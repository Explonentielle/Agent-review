import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AttachmentError, LIMITS, checkAttachment, checkTotals, describeName, type AttachmentKind } from "./rules.js";

/** Un fichier rangé : l'identifiant sert à le retrouver, le nom est celui qu'on affiche (déjà assaini). */
export interface AttachmentInfo {
  id: string;
  name: string;
  size: number;
  kind: AttachmentKind;
}

/** À qui appartiennent des fichiers : une tâche de l'agent dev, ou un ticket (créé avec le Scribe, avant qu'une tâche existe). */
export type AttachmentOwner = { task: number } | { ticket: { source: string; projectId: number; iid: number } };

/** Fichier posé dans un dossier de travail : son nom d'arrivée, son chemin absolu et son type. */
export interface Materialized extends AttachmentInfo {
  path: string;
}

/** Identifiant : horodatage en hexadécimal (donc trié par ordre d'envoi) puis quatre octets au hasard. Rien d'autre n'est accepté dans un chemin. */
const ID_PATTERN = /^[0-9a-f]{20}$/;
let lastStamp = 0;
function newId(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp.toString(16).padStart(16, "0") + randomBytes(2).toString("hex");
}

const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

/** Dossier d'un propriétaire. Chaque composante est contrôlée : aucun texte libre n'entre dans un chemin. */
function ownerDirName(owner: AttachmentOwner): string {
  if ("task" in owner) {
    if (!Number.isSafeInteger(owner.task) || owner.task <= 0) throw new AttachmentError("Tâche invalide.");
    return `task-${owner.task}`;
  }
  const { source, projectId, iid } = owner.ticket;
  if (!/^[a-z0-9]{1,20}$/.test(source) || !Number.isSafeInteger(projectId) || projectId <= 0 || !Number.isSafeInteger(iid) || iid <= 0) {
    throw new AttachmentError("Ticket invalide.");
  }
  return `ticket-${source}-${projectId}-${iid}`;
}

/**
 * Pièces jointes d'un espace : captures d'écran, maquettes, données. Rangées dans des fichiers sous `<racine>/<espace>/`, sans table ni
 * migration : `staging/` pour les fichiers envoyés et pas encore rattachés (purgés après un jour), puis un dossier par tâche ou par ticket.
 * L'objet est lié à UN espace : il ne peut ni lire ni écrire ailleurs, car tous les chemins en dérivent.
 * @param root Dossier racine (`<DATA_DIR>/attachments`).
 * @param workspaceId Espace servi.
 * @returns Les opérations sur les pièces jointes de cet espace.
 */
export function createAttachmentStore(root: string, workspaceId: number) {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) throw new Error("Espace invalide");
  const base = path.resolve(root, String(workspaceId));
  const stagingDir = path.join(base, "staging");
  const ownerDir = (owner: AttachmentOwner) => path.join(base, ownerDirName(owner));

  /** Le fichier unique d'un dossier d'identifiant, avec son poids ; null s'il manque ou si son nom n'est plus accepté. */
  async function readEntry(dir: string, id: string): Promise<(AttachmentInfo & { file: string }) | null> {
    try {
      const names = await readdir(path.join(dir, id));
      const name = names[0];
      if (!name || names.length !== 1) return null;
      const meta = describeName(name);
      if (!meta) return null;
      const file = path.join(dir, id, name);
      return { id, name, size: (await stat(file)).size, kind: meta.kind, file };
    } catch {
      return null;
    }
  }

  /** Les fichiers d'un dossier, dans l'ordre d'envoi. */
  async function readAll(dir: string): Promise<Array<AttachmentInfo & { file: string }>> {
    let ids: string[];
    try {
      ids = (await readdir(dir)).filter(isId).sort();
    } catch {
      return [];
    }
    const out: Array<AttachmentInfo & { file: string }> = [];
    for (const id of ids) {
      const entry = await readEntry(dir, id);
      if (entry) out.push(entry);
    }
    return out;
  }

  const publicInfo = ({ id, name, size, kind }: AttachmentInfo): AttachmentInfo => ({ id, name, size, kind });

  /** Supprime les fichiers en attente trop anciens. */
  async function purgeStaged(maxAgeMs: number = LIMITS.stagedTtlMs): Promise<number> {
    let removed = 0;
    let ids: string[];
    try {
      ids = (await readdir(stagingDir)).filter(isId);
    } catch {
      return 0;
    }
    for (const id of ids) {
      try {
        if (Date.now() - (await stat(path.join(stagingDir, id))).mtimeMs > maxAgeMs) {
          await rm(path.join(stagingDir, id), { recursive: true, force: true });
          removed++;
        }
      } catch {
        /* déjà supprimé : rien à faire */
      }
    }
    return removed;
  }

  /**
   * Vérifie que des fichiers en attente existent et tiennent dans les plafonds avec ceux déjà rattachés, SANS rien déplacer :
   * à appeler avant de créer la tâche ou le ticket, pour ne pas en créer un qui échouerait ensuite.
   * @throws AttachmentError Identifiant inconnu, trop de fichiers ou trop de poids.
   */
  async function check(owner: AttachmentOwner, ids: string[]): Promise<AttachmentInfo[]> {
    return plan([owner], ids);
  }

  /**
   * Comme `check`, pour une tâche qui n'existe pas encore : les fichiers de ces propriétaires (ticket, tâche précédente), qui lui seront
   * copiés, plus les fichiers en attente, doivent tenir dans les plafonds. Ne déplace ni ne copie rien.
   * @throws AttachmentError Identifiant inconnu, trop de fichiers ou trop de poids.
   */
  async function plan(owners: AttachmentOwner[], ids: string[]): Promise<AttachmentInfo[]> {
    const staged: AttachmentInfo[] = [];
    for (const id of new Set(ids)) {
      const entry = isId(id) ? await readEntry(stagingDir, id) : null;
      if (!entry) throw new AttachmentError("Un des fichiers n'existe plus : envoie-le de nouveau.", 404);
      staged.push(publicInfo(entry));
    }
    // Un fichier copié garde son identifiant : présent chez deux propriétaires, il ne compte qu'une fois
    const existing = new Map<string, AttachmentInfo>();
    for (const owner of owners) for (const entry of await readAll(ownerDir(owner))) existing.set(entry.id, entry);
    checkTotals([...existing.values(), ...staged]);
    return staged;
  }

  return {
    check,
    plan,
    /**
     * Reçoit un fichier (contrôlé par `checkAttachment`) et le met en attente, le temps qu'on le rattache à une tâche ou à un ticket.
     * @throws AttachmentError Fichier refusé, ou trop de fichiers en attente.
     */
    async stage(rawName: string, bytes: Uint8Array): Promise<AttachmentInfo> {
      const checked = checkAttachment(rawName, bytes);
      await purgeStaged();
      if ((await readAll(stagingDir)).length >= LIMITS.maxStaged) {
        throw new AttachmentError("Trop de fichiers en attente : rattache-les à une tâche ou retire-en avant d'en ajouter.", 429);
      }
      const id = newId();
      await mkdir(path.join(stagingDir, id), { recursive: true });
      await writeFile(path.join(stagingDir, id, checked.name), bytes, { flag: "wx" });
      return { id, name: checked.name, size: checked.size, kind: checked.kind };
    },

    /**
     * Lit des fichiers en attente (nom, type et contenu), pour les envoyer chez la forge.
     * @throws AttachmentError Identifiant inconnu.
     */
    async readStaged(ids: string[]): Promise<Array<AttachmentInfo & { bytes: Uint8Array }>> {
      const out: Array<AttachmentInfo & { bytes: Uint8Array }> = [];
      for (const id of new Set(ids)) {
        const entry = isId(id) ? await readEntry(stagingDir, id) : null;
        if (!entry) throw new AttachmentError("Un des fichiers n'existe plus : envoie-le de nouveau.", 404);
        out.push({ ...publicInfo(entry), bytes: await readFile(entry.file) });
      }
      return out;
    },

    /** Retire un fichier en attente. @returns Vrai s'il existait. */
    async discard(id: string): Promise<boolean> {
      if (!isId(id)) return false;
      const existed = (await readEntry(stagingDir, id)) !== null;
      await rm(path.join(stagingDir, id), { recursive: true, force: true });
      return existed;
    },

    /** Rattache des fichiers en attente à un propriétaire (ils quittent `staging/`). @returns Tous les fichiers du propriétaire. */
    async attach(owner: AttachmentOwner, ids: string[]): Promise<AttachmentInfo[]> {
      await check(owner, ids);
      const dir = ownerDir(owner);
      await mkdir(dir, { recursive: true });
      for (const id of new Set(ids)) await rename(path.join(stagingDir, id), path.join(dir, id));
      return (await readAll(dir)).map(publicInfo);
    },

    /** Les fichiers d'un propriétaire, dans l'ordre d'envoi. */
    async list(owner: AttachmentOwner): Promise<AttachmentInfo[]> {
      return (await readAll(ownerDir(owner))).map(publicInfo);
    },

    /**
     * Copie les fichiers d'un propriétaire vers un autre (ticket vers tâche, tâche vers reprise ou relance). Chaque copie GARDE l'identifiant
     * d'origine : l'ordre d'envoi est conservé (les fichiers hérités restent avant les nouveaux) et recopier deux fois ne crée pas de doublon.
     * @returns Les fichiers copiés (ceux que la destination a déjà sont ignorés).
     */
    async copy(from: AttachmentOwner, to: AttachmentOwner): Promise<AttachmentInfo[]> {
      const source = await readAll(ownerDir(from));
      if (source.length === 0) return [];
      const dir = ownerDir(to);
      const existing = await readAll(dir);
      const have = new Set(existing.map((e) => e.id));
      const toCopy = source.filter((e) => !have.has(e.id));
      checkTotals([...existing, ...toCopy]);
      const copied: AttachmentInfo[] = [];
      for (const entry of toCopy) {
        await mkdir(path.join(dir, entry.id), { recursive: true });
        await copyFile(entry.file, path.join(dir, entry.id, entry.name));
        copied.push({ id: entry.id, name: entry.name, size: entry.size, kind: entry.kind });
      }
      return copied;
    },

    /**
     * Pose les fichiers d'un propriétaire dans un dossier (le dossier de travail de l'agent), à plat. Deux fichiers de même nom reçoivent
     * un suffixe (« capture (2).png »).
     * @param destDir Dossier absolu à créer.
     * @returns Les fichiers posés, avec leur chemin.
     */
    async materialize(owner: AttachmentOwner, destDir: string): Promise<Materialized[]> {
      const entries = await readAll(ownerDir(owner));
      if (entries.length === 0) return [];
      await mkdir(destDir, { recursive: true });
      const used = new Set<string>();
      const out: Materialized[] = [];
      for (const entry of entries) {
        const dot = entry.name.lastIndexOf(".");
        const stem = dot > 0 ? entry.name.slice(0, dot) : entry.name;
        const ext = dot > 0 ? entry.name.slice(dot) : "";
        let name = entry.name;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
        used.add(name.toLowerCase());
        const target = path.join(destDir, name);
        await copyFile(entry.file, target);
        out.push({ id: entry.id, name, size: entry.size, kind: entry.kind, path: target });
      }
      return out;
    },

    /** Supprime tous les fichiers d'un propriétaire. */
    async remove(owner: AttachmentOwner): Promise<void> {
      await rm(ownerDir(owner), { recursive: true, force: true });
    },

    purgeStaged,
  };
}

export type AttachmentStore = ReturnType<typeof createAttachmentStore>;
