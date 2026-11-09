import type { Db } from "./db.js";

export type ReviewStatus =
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
  projectId: number;
  projectPath: string;
  mrIid: number;
  mrTitle: string;
  mrUrl: string;
  author: string;
  headSha: string;
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

export function createReviewRepo(db: Db) {
  const touch = `updated_at = ${db.sql.now}`;

  return {
    /** Insère une review si ce commit de cette MR n'a jamais été vu. Retourne l'id, ou null si déjà connue. */
    async insertIfNew(r: NewReview): Promise<number | null> {
      const row = await db.get<{ id: number }>(
        `INSERT INTO reviews (project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, mr_iid, head_sha) DO NOTHING
         RETURNING id`,
        [r.projectId, r.projectPath, r.mrIid, r.mrTitle, r.mrUrl, r.author, r.headSha],
      );
      return row ? row.id : null;
    },

    get(id: number): Promise<ReviewRow | undefined> {
      return db.get<ReviewRow>("SELECT * FROM reviews WHERE id = ?", [id]);
    },

    list(status?: ReviewStatus, limit = 100): Promise<ReviewRow[]> {
      if (status) return db.all<ReviewRow>("SELECT * FROM reviews WHERE status = ? ORDER BY updated_at DESC LIMIT ?", [status, limit]);
      return db.all<ReviewRow>("SELECT * FROM reviews ORDER BY updated_at DESC LIMIT ?", [limit]);
    },

    /** Reviews interrompues par un arrêt du process (à remettre en file au démarrage). */
    listInterrupted(): Promise<ReviewRow[]> {
      return db.all<ReviewRow>("SELECT * FROM reviews WHERE status IN ('queued', 'running')");
    },

    async setStatus(id: number, status: ReviewStatus): Promise<void> {
      await db.run(`UPDATE reviews SET status = ?, ${touch} WHERE id = ?`, [status, id]);
    },

    async saveResult(id: number, r: SavedResult): Promise<void> {
      await db.run(
        `UPDATE reviews
         SET status = ?, decision_reasons = ?, result_json = ?, changed_lines = ?, cost_usd = ?, num_turns = ?, error = NULL, ${touch}
         WHERE id = ?`,
        [r.status, JSON.stringify(r.decisionReasons), r.resultJson, r.changedLines, r.costUsd, r.numTurns, id],
      );
    },

    async saveError(id: number, message: string): Promise<void> {
      await db.run(`UPDATE reviews SET status = 'error', error = ?, ${touch} WHERE id = ?`, [message, id]);
    },

    async saveFeedback(id: number, agree: boolean, note: string | null): Promise<void> {
      await db.run(`UPDATE reviews SET feedback_agree = ?, feedback_note = ?, ${touch} WHERE id = ?`, [agree ? 1 : 0, note, id]);
    },

    async logAction(reviewId: number, kind: "comment" | "approve" | "dismiss" | "retry", automatic: boolean, detail?: string): Promise<void> {
      await db.run("INSERT INTO actions (review_id, kind, automatic, detail) VALUES (?, ?, ?, ?)", [reviewId, kind, automatic ? 1 : 0, detail ?? null]);
    },

    async countByStatus(): Promise<Record<string, number>> {
      const rows = await db.all<{ status: string; n: number }>("SELECT status, CAST(COUNT(*) AS INTEGER) AS n FROM reviews GROUP BY status");
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },

    /** Taux d'accord entre l'agent et toi (mode ombre) : base de la décision de passer en mode auto. */
    async agreementStats(): Promise<{ rated: number; agreed: number }> {
      const row = await db.get<{ rated: number; agreed: number }>(
        "SELECT CAST(COUNT(*) AS INTEGER) AS rated, CAST(COALESCE(SUM(feedback_agree), 0) AS INTEGER) AS agreed FROM reviews WHERE feedback_agree IS NOT NULL",
      );
      return row ?? { rated: 0, agreed: 0 };
    },
  };
}
