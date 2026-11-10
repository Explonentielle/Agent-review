import type { Db } from "./db.js";

export interface AuditEntry {
  id: number;
  workspace_id: number;
  /** Personne qui a agi, ou null si l'action ne vient d'aucune personne identifiée. */
  user_id: number | null;
  /** Forge touchée (gitlab ou github). */
  source: string;
  /** Ce qui a été fait : `change_request_create`, `change_request_comment`, `change_request_approve`, `ticket_labels`, `push_branch`. */
  action: string;
  /** Sur quoi : projet et numéro (`12/34`) ou nom de branche. */
  target: string;
  /** Précisions utiles (JSON) : jamais de jeton ni de texte intégral des commentaires. */
  detail: string | null;
  outcome: "ok" | "error";
  error: string | null;
  created_at: string;
}

export interface NewAuditEntry {
  source: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
  /** Message d'erreur si l'écriture a échoué ; absent si elle a réussi. */
  error?: string;
}

export type AuditRepo = ReturnType<typeof createAuditRepo>;

const MAX_DETAIL = 2000;
const MAX_ERROR = 500;

/**
 * Journal des écritures faites sur les forges (commentaires, approbations, MR, labels, branches poussées) pour UN espace et UNE personne :
 * qui, quand, quoi, sur quelle cible, avec quel résultat. Les lectures ne sont pas tracées. Chaque requête est limitée à l'espace.
 * @param db Base de données.
 * @param workspaceId Espace auquel le journal est lié.
 * @param userId Personne qui agit, ou null.
 * @returns Les opérations du journal.
 */
export function createAuditRepo(db: Db, workspaceId: number, userId: number | null) {
  return {
    /**
     * Ajoute une ligne au journal.
     * @param entry Ce qui a été écrit sur la forge, et son éventuelle erreur.
     * @returns Rien.
     */
    async record(entry: NewAuditEntry): Promise<void> {
      await db.run("INSERT INTO audit_log (workspace_id, user_id, source, action, target, detail, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        workspaceId,
        userId,
        entry.source,
        entry.action,
        entry.target,
        entry.detail ? JSON.stringify(entry.detail).slice(0, MAX_DETAIL) : null,
        entry.error === undefined ? "ok" : "error",
        entry.error === undefined ? null : entry.error.slice(0, MAX_ERROR),
      ]);
    },

    /**
     * Lignes du journal de l'espace, les plus récentes d'abord.
     * @param limit Nombre maximum de lignes.
     * @param beforeId Ne renvoyer que les lignes plus anciennes que cet identifiant (pagination).
     * @returns Les lignes.
     */
    list(limit = 100, beforeId?: number): Promise<AuditEntry[]> {
      if (beforeId !== undefined) {
        return db.all<AuditEntry>("SELECT * FROM audit_log WHERE workspace_id = ? AND id < ? ORDER BY id DESC LIMIT ?", [workspaceId, beforeId, limit]);
      }
      return db.all<AuditEntry>("SELECT * FROM audit_log WHERE workspace_id = ? ORDER BY id DESC LIMIT ?", [workspaceId, limit]);
    },
  };
}
