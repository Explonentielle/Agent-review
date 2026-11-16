import type { FastifyInstance, FastifyReply } from "fastify";
import type { DevTaskRepo } from "../db/devTasks.js";
import { AttachmentError, LIMITS } from "./rules.js";
import type { AttachmentOwner, AttachmentStore } from "./store.js";

/** Ce que les routes des pièces jointes empruntent au serveur. */
export interface AttachmentRoutesContext {
  /** Pièces jointes de la personne servie (résolues à chaque requête). Absentes : la fonction est désactivée. */
  deps: { attachments?: AttachmentStore | undefined };
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
}

const UNAVAILABLE = "Les pièces jointes ne sont pas disponibles sur cette installation.";

/**
 * Répond à une erreur de pièce jointe : le refus (type, taille, plafond) est lisible tel quel ; le reste passe par le traitement général.
 * @param reply Réponse.
 * @param err Erreur levée.
 * @param fail Traitement général des erreurs du serveur.
 * @returns La réponse envoyée.
 */
export function failAttachment(reply: FastifyReply, err: unknown, fail: AttachmentRoutesContext["fail"]): unknown {
  if (err instanceof AttachmentError) return reply.code(err.status).send({ error: err.message });
  return fail(reply, err);
}

/**
 * Lit la liste d'identifiants de fichiers d'une demande (`attachments`).
 * @param value Valeur reçue (absente : aucun fichier).
 * @returns Les identifiants.
 * @throws AttachmentError Si ce n'est pas une liste de textes de taille raisonnable.
 */
export function attachmentIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.maxFiles || value.some((v) => typeof v !== "string")) {
    throw new AttachmentError("La liste des fichiers joints est invalide.");
  }
  return value as string[];
}

/**
 * À appeler AVANT de créer une tâche : vérifie que les fichiers envoyés existent encore et que, avec ceux qu'elle héritera (ticket, tâche
 * précédente), ils tiennent dans les plafonds. Un refus ne crée donc aucune tâche.
 * @param deps Pièces jointes de la personne.
 * @param copyFrom Propriétaires dont les fichiers seront copiés à la tâche.
 * @param ids Fichiers envoyés à rattacher.
 * @throws AttachmentError Si un fichier est refusé, ou si la fonction est indisponible alors que des fichiers sont joints.
 */
export async function planAttachments(deps: { attachments?: AttachmentStore | undefined }, copyFrom: AttachmentOwner[], ids: string[]): Promise<void> {
  if (!deps.attachments) {
    if (ids.length > 0) throw new AttachmentError(UNAVAILABLE, 501);
    return;
  }
  await deps.attachments.plan(copyFrom, ids);
}

/**
 * Donne à une tâche qui vient d'être créée ses pièces jointes : celles de ticket ou d'une tâche précédente (reprise, relance), puis les fichiers
 * que la personne vient d'envoyer. `planAttachments` a déjà tout vérifié : une erreur ici est un incident système (disque), la tâche passe alors
 * en erreur avec un message clair plutôt que de partir sans les fichiers.
 * @param deps Pièces jointes et tâches de la personne.
 * @param taskId Tâche créée, pas encore mise en file.
 * @param sources Propriétaires à copier, puis fichiers envoyés à rattacher.
 * @returns Les noms des fichiers de la tâche.
 * @throws Error Si les fichiers n'ont pas pu être rattachés (la tâche est marquée en erreur).
 */
export async function giveAttachments(
  deps: { attachments?: AttachmentStore | undefined; tasks: DevTaskRepo },
  taskId: number,
  sources: { copyFrom: AttachmentOwner[]; ids: string[] },
): Promise<string[]> {
  const store = deps.attachments;
  if (!store) return [];
  try {
    for (const from of sources.copyFrom) await store.copy(from, { task: taskId });
    if (sources.ids.length > 0) await store.attach({ task: taskId }, sources.ids);
    return (await store.list({ task: taskId })).map((f) => f.name);
  } catch (err) {
    await store.remove({ task: taskId });
    await deps.tasks.update(taskId, { status: "error", error: "Les pièces jointes n'ont pas pu être rattachées à la tâche : rien n'a été lancé. Réessaie en renvoyant les fichiers." });
    throw err;
  }
}

/**
 * Routes des pièces jointes : envoyer un fichier (il reste en attente), le retirer, lister ceux d'une tâche. Le contenu est contrôlé par
 * `checkAttachment` (type, taille, contenu réel) avant d'être écrit ; rien n'est jamais renvoyé au navigateur sous forme de page.
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 */
export function registerAttachments(app: FastifyInstance, ctx: AttachmentRoutesContext): void {
  const { deps, fail } = ctx;
  const store = (): AttachmentStore => {
    if (!deps.attachments) throw new AttachmentError(UNAVAILABLE, 501);
    return deps.attachments;
  };

  // Le corps d'un envoi est le fichier lui-même, en octets. Un peu de marge sur la limite : le refus lisible (« trop gros ») vient du contrôle.
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: LIMITS.maxBinaryBytes + 64 * 1024 }, (_req, body, done) => done(null, body));

  /** Reçoit un fichier (nom en paramètre) et le met en attente : `{ id, name, size, kind }`. */
  app.post<{ Querystring: { name?: string } }>("/api/attachments", async (req, reply) => {
    try {
      if (!Buffer.isBuffer(req.body)) throw new AttachmentError("Aucun fichier reçu.");
      return await store().stage(String(req.query.name ?? ""), req.body);
    } catch (err) {
      return failAttachment(reply, err, fail);
    }
  });

  /** Retire un fichier en attente (la personne l'a ôté de sa liste avant de valider). */
  app.post<{ Params: { id: string } }>("/api/attachments/:id/discard", async (req, reply) => {
    try {
      return { ok: true, existed: await store().discard(req.params.id) };
    } catch (err) {
      return failAttachment(reply, err, fail);
    }
  });

  /** Fichiers joints à une tâche, pour les afficher sur sa page. */
  app.get<{ Params: { id: string } }>("/api/tasks/:id/attachments", async (req, reply) => {
    try {
      if (!deps.attachments) return { attachments: [] };
      return { attachments: await deps.attachments.list({ task: Number(req.params.id) }) };
    } catch (err) {
      return failAttachment(reply, err, fail);
    }
  });
}
