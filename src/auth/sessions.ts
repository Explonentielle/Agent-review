import { createHash, randomBytes } from "node:crypto";
import type { Role } from "../db/accounts.js";
import type { Db } from "../db/db.js";

/** Ce que la session donne à une requête : qui agit, dans quel espace, avec quel rôle. */
export interface SessionContext {
  userId: number;
  workspaceId: number;
  role: Role;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

/**
 * Empreinte d'un jeton de session : seule elle est stockée, un vol de la base ne donne donc aucune session utilisable.
 * @param token Jeton de session.
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
 * Sessions de connexion. Le jeton est tiré au hasard (256 bits), remis au navigateur dans un cookie, et la base ne garde que son empreinte.
 * Une session n'est valable que tant qu'elle n'a pas expiré ET que l'utilisateur est toujours membre de l'espace qu'elle désigne.
 * @param db Base de données.
 * @param days Durée de validité d'une session, en jours.
 * @returns Les opérations sur les sessions.
 */
export function createSessionStore(db: Db, days: number) {
  return {
    /**
     * Ouvre une session.
     * @param userId Utilisateur connecté.
     * @param workspaceId Espace actif (dont l'utilisateur est membre).
     * @returns Le jeton à remettre au navigateur : il n'est plus récupérable ensuite.
     */
    async create(userId: number, workspaceId: number): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      await db.run("INSERT INTO sessions (token_hash, user_id, workspace_id, expires_at) VALUES (?, ?, ?, ?)", [hashOf(token), userId, workspaceId, expiryIn(days)]);
      return token;
    },

    /**
     * Retrouve le contexte d'une session.
     * @param token Jeton présenté par le navigateur.
     * @returns Le contexte, ou null si le jeton est inconnu, expiré, ou si l'utilisateur n'est plus membre de l'espace.
     */
    async resolve(token: string): Promise<SessionContext | null> {
      if (token === "") return null;
      const row = await db.get<{ user_id: number; workspace_id: number; role: Role }>(
        `SELECT s.user_id AS user_id, s.workspace_id AS workspace_id, m.role AS role
           FROM sessions s JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ${db.sql.now}`,
        [hashOf(token)],
      );
      return row ? { userId: row.user_id, workspaceId: row.workspace_id, role: row.role } : null;
    },

    /**
     * Ferme une session (déconnexion).
     * @param token Jeton de la session.
     * @returns Rien (sans effet si elle n'existe plus).
     */
    async delete(token: string): Promise<void> {
      await db.run("DELETE FROM sessions WHERE token_hash = ?", [hashOf(token)]);
    },

    /**
     * Change l'espace actif d'une session, à condition que la personne en soit membre.
     * @param token Jeton de la session.
     * @param workspaceId Espace voulu.
     * @returns Vrai si la session désigne maintenant cet espace, faux si elle est inconnue ou si la personne n'est pas membre de cet espace.
     */
    async switchWorkspace(token: string, workspaceId: number): Promise<boolean> {
      if (token === "") return false;
      const res = await db.run(
        `UPDATE sessions SET workspace_id = ?
          WHERE token_hash = ? AND expires_at > ${db.sql.now}
            AND EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = ? AND m.user_id = sessions.user_id)`,
        [workspaceId, hashOf(token), workspaceId],
      );
      return res.changes === 1;
    },

    /**
     * Ferme les sessions d'un utilisateur dans un espace (retrait de cet espace). Ses sessions dans d'autres espaces ne sont pas touchées.
     * @param userId Utilisateur concerné.
     * @param workspaceId Espace qu'il quitte.
     * @returns Le nombre de sessions fermées.
     */
    async deleteForMember(userId: number, workspaceId: number): Promise<number> {
      return (await db.run("DELETE FROM sessions WHERE user_id = ? AND workspace_id = ?", [userId, workspaceId])).changes;
    },

    /**
     * Ferme toutes les sessions d'un utilisateur (retrait d'accès).
     * @param userId Utilisateur concerné.
     * @returns Le nombre de sessions fermées.
     */
    async deleteForUser(userId: number): Promise<number> {
      return (await db.run("DELETE FROM sessions WHERE user_id = ?", [userId])).changes;
    },

    /**
     * Supprime les sessions expirées.
     * @returns Le nombre de sessions supprimées.
     */
    async purgeExpired(): Promise<number> {
      return (await db.run(`DELETE FROM sessions WHERE expires_at <= ${db.sql.now}`)).changes;
    },
  };
}
