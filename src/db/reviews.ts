import type { Db } from "./index.js";

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
  const touch = "updated_at = datetime('now')";

  return {
    /** Insère une review si ce commit de cette MR n'a jamais été vu. Retourne l'id, ou null si déjà connue. */
    insertIfNew(r: NewReview): number | null {
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO reviews (project_id, project_path, mr_iid, mr_title, mr_url, author, head_sha)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.projectId, r.projectPath, r.mrIid, r.mrTitle, r.mrUrl, r.author, r.headSha);
      return res.changes > 0 ? Number(res.lastInsertRowid) : null;
    },

    get(id: number): ReviewRow | undefined {
      return db.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as ReviewRow | undefined;
    },

    list(status?: ReviewStatus, limit = 100): ReviewRow[] {
      if (status) {
        return db
          .prepare("SELECT * FROM reviews WHERE status = ? ORDER BY updated_at DESC LIMIT ?")
          .all(status, limit) as unknown as ReviewRow[];
      }
      return db.prepare("SELECT * FROM reviews ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as ReviewRow[];
    },

    /** Reviews interrompues par un arrêt du process (à remettre en file au démarrage). */
    listInterrupted(): ReviewRow[] {
      return db.prepare("SELECT * FROM reviews WHERE status IN ('queued', 'running')").all() as unknown as ReviewRow[];
    },

    setStatus(id: number, status: ReviewStatus): void {
      db.prepare(`UPDATE reviews SET status = ?, ${touch} WHERE id = ?`).run(status, id);
    },

    saveResult(id: number, r: SavedResult): void {
      db.prepare(
        `UPDATE reviews
         SET status = ?, decision_reasons = ?, result_json = ?, changed_lines = ?, cost_usd = ?, num_turns = ?, error = NULL, ${touch}
         WHERE id = ?`,
      ).run(r.status, JSON.stringify(r.decisionReasons), r.resultJson, r.changedLines, r.costUsd, r.numTurns, id);
    },

    saveError(id: number, message: string): void {
      db.prepare(`UPDATE reviews SET status = 'error', error = ?, ${touch} WHERE id = ?`).run(message, id);
    },

    saveFeedback(id: number, agree: boolean, note: string | null): void {
      db.prepare(`UPDATE reviews SET feedback_agree = ?, feedback_note = ?, ${touch} WHERE id = ?`).run(
        agree ? 1 : 0,
        note,
        id,
      );
    },

    logAction(reviewId: number, kind: "comment" | "approve" | "dismiss" | "retry", automatic: boolean, detail?: string): void {
      db.prepare("INSERT INTO actions (review_id, kind, automatic, detail) VALUES (?, ?, ?, ?)").run(
        reviewId,
        kind,
        automatic ? 1 : 0,
        detail ?? null,
      );
    },

    countByStatus(): Record<string, number> {
      const rows = db.prepare("SELECT status, COUNT(*) AS n FROM reviews GROUP BY status").all() as unknown as Array<{
        status: string;
        n: number;
      }>;
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },

    /** Taux d'accord entre l'agent et toi (mode ombre) : base de la décision de passer en mode auto. */
    agreementStats(): { rated: number; agreed: number } {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS rated, COALESCE(SUM(feedback_agree), 0) AS agreed FROM reviews WHERE feedback_agree IS NOT NULL",
        )
        .get() as { rated: number; agreed: number };
      return row;
    },
  };
}
