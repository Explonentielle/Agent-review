import { createHash, randomBytes } from "node:crypto";
import { AccountError, ROLES, type Role } from "./accounts.js";
import type { Db } from "./db.js";

/** Invitation en attente, telle que la voit l'administrateur de l'espace (jamais le jeton). */
export interface InvitationRow {
  id: number;
  workspace_id: number;
  role: Role;
  note: string;
  forge_login: string | null;
  /** Adresse à laquelle le lien a été envoyé (invitation par email), ou null (lien à transmettre à la main). */
  email: string | null;
  created_by: number;
  created_by_name: string;
  created_at: string;
  expires_at: string;
}

/** Invitation retrouvée par son jeton : de quoi afficher la page d'accueil et valider la connexion de l'invité. */
export interface InvitationLookup {
  id: number;
  workspaceId: number;
  workspaceName: string;
  role: Role;
  note: string;
  forgeLogin: string | null;
  /** Adresse visée : seule la personne qui lit cette boîte a reçu le lien, elle crée donc son compte (ou se connecte) avec cette adresse. */
  email: string | null;
  invitedBy: string;
}

export type InvitationRepo = ReturnType<typeof createInvitationRepo>;

/** Durée de validité par défaut d'une invitation, en jours, et plafond. */
export const INVITATION_DAYS = 7;
export const MAX_INVITATION_DAYS = 30;
/** Invitations en attente au plus dans un espace : un lien oublié ne doit pas s'accumuler sans fin. */
export const MAX_PENDING_INVITATIONS = 50;

const MAX_NOTE_LENGTH = 200;
const FORGE_LOGIN = /^(gitlab|github):[a-z0-9][a-z0-9_.-]{0,99}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Empreinte d'un jeton d'invitation : seule elle est stockée, un vol de la base ne donne donc aucun lien utilisable.
 * @param token Jeton d'invitation.
 * @returns Empreinte SHA-256 en hexadécimal.
 */
function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Date d'expiration au format texte de la base (UTC, AAAA-MM-JJ HH:MM:SS).
 * @param days Durée de validité en jours.
 * @returns La date d'expiration.
 */
function expiryIn(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Invitations à rejoindre un espace d'équipe. Le lien contient un jeton tiré au hasard (256 bits), valable une seule fois et pour une durée limitée.
 * Le jeton donne le droit d'entrer dans l'espace avec le rôle prévu : il doit donc rester secret, et peut être réservé à un compte de forge précis.
 * @param db Base de données.
 * @returns Les opérations sur les invitations.
 */
export function createInvitationRepo(db: Db) {
  return {
    /**
     * Crée une invitation dans un espace d'équipe. Une invitation par email ne doit être envoyée qu'à cette adresse : c'est ce qui prouve que la personne la lit,
     * son lien n'est donc jamais montré à l'administrateur.
     * @param input Espace, rôle donné, mot libre pour s'y retrouver, compte de forge visé ou adresse email visée (au plus un des deux), validité en jours, et auteur.
     * @returns Le jeton (à remettre dans le lien : il n'est plus récupérable ensuite), son identifiant et sa date d'expiration.
     * @throws AccountError Si le rôle, le compte de forge ou l'adresse est invalide (ou les deux donnés), l'espace n'est pas une équipe, ou trop d'invitations sont en attente.
     */
    async create(input: { workspaceId: number; role: string; note?: string; forgeLogin?: string | null; email?: string | null; days?: number; createdBy: number }): Promise<{ id: number; token: string; expiresAt: string }> {
      if (!(ROLES as readonly string[]).includes(input.role)) throw new AccountError(`Rôle inconnu : ${ROLES.join(", ")}`);
      const note = (input.note ?? "").trim();
      if (note.length > MAX_NOTE_LENGTH) throw new AccountError(`Le mot d'accompagnement fait ${MAX_NOTE_LENGTH} caractères au plus`);
      const forgeLogin = input.forgeLogin?.trim().toLowerCase() || null;
      if (forgeLogin !== null && !FORGE_LOGIN.test(forgeLogin)) throw new AccountError("Le compte de forge doit avoir la forme forge:identifiant (ex. github:alice)");
      const email = input.email?.trim().toLowerCase() || null;
      if (email !== null && (email.length > 254 || !EMAIL_FORMAT.test(email))) throw new AccountError("Adresse email invalide");
      if (email !== null && forgeLogin !== null) throw new AccountError("Une invitation vise une adresse email ou un compte de forge, pas les deux");
      const days = input.days ?? INVITATION_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > MAX_INVITATION_DAYS) throw new AccountError(`La validité va de 1 à ${MAX_INVITATION_DAYS} jours`);

      const workspace = await db.get<{ kind: string }>("SELECT kind FROM workspaces WHERE id = ?", [input.workspaceId]);
      if (!workspace) throw new AccountError("Espace introuvable");
      if (workspace.kind !== "team") throw new AccountError("On n'invite que dans un espace d'équipe : transforme d'abord cet espace en équipe");
      const pending = await db.get<{ n: number }>(
        `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM invitations WHERE workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${db.sql.now}`,
        [input.workspaceId],
      );
      if (Number(pending!.n) >= MAX_PENDING_INVITATIONS) throw new AccountError(`${MAX_PENDING_INVITATIONS} invitations sont déjà en attente : révoque celles qui ne servent plus`);

      const token = randomBytes(32).toString("base64url");
      const expiresAt = expiryIn(days);
      const row = await db.get<{ id: number }>(
        "INSERT INTO invitations (workspace_id, token_hash, role, note, forge_login, email, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
        [input.workspaceId, hashOf(token), input.role, note, forgeLogin, email, input.createdBy, expiresAt],
      );
      return { id: row!.id, token, expiresAt };
    },

    /**
     * Invitations en attente d'un espace (ni utilisées, ni révoquées, ni expirées).
     * @param workspaceId Identifiant de l'espace.
     * @returns Les invitations, la plus récente d'abord.
     */
    listPending(workspaceId: number): Promise<InvitationRow[]> {
      return db.all<InvitationRow>(
        `SELECT i.id AS id, i.workspace_id AS workspace_id, i.role AS role, i.note AS note, i.forge_login AS forge_login, i.email AS email, i.created_by AS created_by,
                u.name AS created_by_name, i.created_at AS created_at, i.expires_at AS expires_at
           FROM invitations i JOIN users u ON u.id = i.created_by
          WHERE i.workspace_id = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${db.sql.now}
          ORDER BY i.id DESC`,
        [workspaceId],
      );
    },

    /**
     * Révoque une invitation en attente de cet espace : son lien ne marche plus.
     * @param workspaceId Identifiant de l'espace.
     * @param id Identifiant de l'invitation.
     * @returns Rien.
     * @throws AccountError Si elle n'existe pas dans cet espace, ou n'est plus en attente.
     */
    async revoke(workspaceId: number, id: number): Promise<void> {
      const res = await db.run(`UPDATE invitations SET revoked_at = ${db.sql.now} WHERE id = ? AND workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL`, [id, workspaceId]);
      if (res.changes === 0) throw new AccountError("Invitation introuvable ou déjà utilisée");
    },

    /**
     * Retrouve une invitation valable par son jeton.
     * @param token Jeton lu dans le lien.
     * @returns L'invitation, ou null si le jeton est inconnu, utilisé, révoqué ou expiré (le même refus dans tous les cas).
     */
    async lookup(token: string): Promise<InvitationLookup | null> {
      if (token === "" || token.length > 200) return null;
      const row = await db.get<{ id: number; workspace_id: number; workspace_name: string; role: Role; note: string; forge_login: string | null; email: string | null; invited_by: string }>(
        `SELECT i.id AS id, i.workspace_id AS workspace_id, w.name AS workspace_name, i.role AS role, i.note AS note, i.forge_login AS forge_login, i.email AS email, u.name AS invited_by
           FROM invitations i JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.created_by
          WHERE i.token_hash = ? AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${db.sql.now}`,
        [hashOf(token)],
      );
      return row ? { id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name, role: row.role, note: row.note, forgeLogin: row.forge_login, email: row.email, invitedBy: row.invited_by } : null;
    },

    /**
     * Marque une invitation comme utilisée, en une seule instruction : de deux personnes qui l'utilisent en même temps, une seule l'obtient.
     * @param id Identifiant de l'invitation.
     * @param userId Personne qui l'utilise.
     * @returns Vrai si cette personne a obtenu l'invitation, faux si elle n'est plus valable.
     */
    async consume(id: number, userId: number): Promise<boolean> {
      const res = await db.run(
        `UPDATE invitations SET used_by = ?, used_at = ${db.sql.now} WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ${db.sql.now}`,
        [userId, id],
      );
      return res.changes === 1;
    },
  };
}
