import { DEFAULT_FORGE } from "../connectors/forges.js";
import type { ForgeKind } from "../connectors/types.js";
import type { Db } from "./db.js";

export type ReviewStatus =
  | "detected" // détectée mais pas lancée : le déclenchement manuel attend ton clic
  | "queued" // détectée, en attente de l'agent
  | "running" // review en cours
  | "needs_human" // l'agent a trouvé des points qui demandent ton analyse
  | "auto_ok" // uniquement des points mineurs : publiable / approuvable sans toi
  | "published" // commentaire posté sur la MR
  | "approved" // commentaire posté + MR approuvée
  | "dismissed" // ignorée manuellement
  | "error";

export interface ReviewRow {
  id: number;
  /** Espace auquel appartient la review. */
  workspace_id: number;
  /** Forge d'où vient la demande de fusion. */
  source: ForgeKind;
  project_id: number;
  project_path: string;
  mr_iid: number;
  mr_title: string;
  mr_url: string;
  author: string;
  head_sha: string;
  status: ReviewStatus;
  decision_reasons: string | null;
  result_json: string | null;
  changed_lines: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  error: string | null;
  feedback_agree: number | null;
  feedback_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewReview {
  /** Forge d'où vient la demande de fusion (GitLab par défaut). */
  source?: ForgeKind;
  projectId: number;
  projectPath: string;
  mrIid: number;
  mrTitle: string;
  mrUrl: string;
  author: string;
  headSha: string;
  /** `detected` : la review attend d'être lancée à la main (déclenchement manuel). Par défaut `queued` : l'agent la prend. */
  status?: "queued" | "detected";
}

export interface SavedResult {
  status: Extract<ReviewStatus, "needs_human" | "auto_ok">;
  decisionReasons: string[];
  resultJson: string;
  changedLines: number;
  costUsd: number | null;
  numTurns: number | null;
}

export type ReviewRepo = ReturnType<typeof createReviewRepo>;

/**
 * Reviews d'UN espace : toute requête est limitée à `workspaceId`, une review d'un autre espace est introuvable
 * (lecture, modification, journal d'actions). Aucune méthode ne permet de sortir de l'espace.
 * @param db Base de données.
 * @param workspaceId Espace auquel le dépôt est lié.
 * @returns Les opérations sur les reviews de cet espace.
 */
export function createReviewRepo(db: Db, workspaceId: number) {
  const touch = `updated_at = ${db.sql.now}`;

  return {
    /**
     * Insère une review si ce commit de cette MR n'a jamais été vu dans cet espace.
     * @param r Demande de fusion détectée.
     * @returns L'id de la review créée, ou null si ce commit est déjà connu de l'espace.
     */
    async insertIfNew(r: NewReview): Promise<number | null> {
      const row = await db.get<{ id: number }>(
        `INSERT INTO reviews (workspace_id, source, project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, source, project_id, mr_iid, head_sha) DO NOTHING
         RETURNING id`,
        [workspaceId, r.source ?? DEFAULT_FORGE, r.projectId, r.projectPath, r.mrIid, r.mrTitle, r.mrUrl, r.author, r.headSha, r.status ?? "queued"],
      );
      return row ? row.id : null;
    },

    /**
     * Lit une review de l'espace.
     * @param id Identifiant de la review.
     * @returns La review, ou undefined si elle n'existe pas dans cet espace.
     */
    get(id: number): Promise<ReviewRow | undefined> {
      return db.get<ReviewRow>("SELECT * FROM reviews WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
    },

    /**
     * Reviews de l'espace, les plus récemment mises à jour d'abord.
     * @param status Statut à filtrer, ou absent pour tous.
     * @param limit Nombre maximum de reviews.
     * @returns Les reviews.
     */
    list(status?: ReviewStatus, limit = 100): Promise<ReviewRow[]> {
      if (status) return db.all<ReviewRow>("SELECT * FROM reviews WHERE workspace_id = ? AND status = ? ORDER BY updated_at DESC LIMIT ?", [workspaceId, status, limit]);
      return db.all<ReviewRow>("SELECT * FROM reviews WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?", [workspaceId, limit]);
    },

    /**
     * Reviews de l'espace interrompues par un arrêt du process (à remettre en file au démarrage).
     * @returns Les reviews en attente ou en cours.
     */
    listInterrupted(): Promise<ReviewRow[]> {
      return db.all<ReviewRow>("SELECT * FROM reviews WHERE workspace_id = ? AND status IN ('queued', 'running')", [workspaceId]);
    },

    /**
     * Change le statut d'une review de l'espace.
     * @param id Identifiant de la review.
     * @param status Nouveau statut.
     * @returns Rien (sans effet si la review n'est pas dans l'espace).
     */
    async setStatus(id: number, status: ReviewStatus): Promise<void> {
      await db.run(`UPDATE reviews SET status = ?, ${touch} WHERE id = ? AND workspace_id = ?`, [status, id, workspaceId]);
    },

    /**
     * Enregistre le résultat d'une review de l'espace.
     * @param id Identifiant de la review.
     * @param r Résultat de l'agent et décision.
     * @returns Rien (sans effet si la review n'est pas dans l'espace).
     */
    async saveResult(id: number, r: SavedResult): Promise<void> {
      await db.run(
        `UPDATE reviews
         SET status = ?, decision_reasons = ?, result_json = ?, changed_lines = ?, cost_usd = ?, num_turns = ?, error = NULL, ${touch}
         WHERE id = ? AND workspace_id = ?`,
        [r.status, JSON.stringify(r.decisionReasons), r.resultJson, r.changedLines, r.costUsd, r.numTurns, id, workspaceId],
      );
    },

    /**
     * Marque une review de l'espace en erreur.
     * @param id Identifiant de la review.
     * @param message Message d'erreur.
     * @returns Rien (sans effet si la review n'est pas dans l'espace).
     */
    async saveError(id: number, message: string): Promise<void> {
      await db.run(`UPDATE reviews SET status = 'error', error = ?, ${touch} WHERE id = ? AND workspace_id = ?`, [message, id, workspaceId]);
    },

    /**
     * Enregistre ton avis sur une review de l'espace.
     * @param id Identifiant de la review.
     * @param agree Accord avec l'agent.
     * @param note Remarque libre, ou null.
     * @returns Rien (sans effet si la review n'est pas dans l'espace).
     */
    async saveFeedback(id: number, agree: boolean, note: string | null): Promise<void> {
      await db.run(`UPDATE reviews SET feedback_agree = ?, feedback_note = ?, ${touch} WHERE id = ? AND workspace_id = ?`, [agree ? 1 : 0, note, id, workspaceId]);
    },

    /**
     * Ajoute une ligne au journal des actions d'une review de l'espace.
     * @param reviewId Identifiant de la review.
     * @param kind Type d'action.
     * @param automatic Vrai si l'outil l'a faite seul.
     * @param detail Détail libre.
     * @returns Rien.
     * @throws Error Si la review n'est pas dans l'espace : rien n'est écrit.
     */
    async logAction(reviewId: number, kind: "comment" | "approve" | "dismiss" | "retry" | "start", automatic: boolean, detail?: string): Promise<void> {
      const res = await db.run(
        "INSERT INTO actions (review_id, kind, automatic, detail) SELECT id, CAST(? AS TEXT), CAST(? AS INTEGER), CAST(? AS TEXT) FROM reviews WHERE id = ? AND workspace_id = ?",
        [kind, automatic ? 1 : 0, detail ?? null, reviewId, workspaceId],
      );
      if (res.changes === 0) throw new Error(`Review ${reviewId} introuvable dans cet espace`);
    },

    /**
     * Nombre de reviews de l'espace par statut.
     * @returns Un objet statut vers effectif.
     */
    async countByStatus(): Promise<Record<string, number>> {
      const rows = await db.all<{ status: string; n: number }>("SELECT status, CAST(COUNT(*) AS INTEGER) AS n FROM reviews WHERE workspace_id = ? GROUP BY status", [workspaceId]);
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },

    /**
     * Taux d'accord entre l'agent et toi (mode ombre) : base de la décision de passer en mode auto.
     * @returns Le nombre de reviews notées et celles où tu étais d'accord, dans cet espace.
     */
    async agreementStats(): Promise<{ rated: number; agreed: number }> {
      const row = await db.get<{ rated: number; agreed: number }>(
        "SELECT CAST(COUNT(*) AS INTEGER) AS rated, CAST(COALESCE(SUM(feedback_agree), 0) AS INTEGER) AS agreed FROM reviews WHERE workspace_id = ? AND feedback_agree IS NOT NULL",
        [workspaceId],
      );
      return row ?? { rated: 0, agreed: 0 };
    },
  };
}
