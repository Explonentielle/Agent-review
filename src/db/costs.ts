import type { Db } from "./db.js";

export type CostRepo = ReturnType<typeof createCostRepo>;

export interface CostLine {
  kind: "review" | "dev";
  projectPath: string;
  usd: number;
  count: number;
}

/** Mois courant au format AAAA-MM (UTC, comme les dates enregistrées en base). */
export const currentMonth = (now = new Date()): string => now.toISOString().slice(0, 7);

/**
 * Consommation des agents d'UN espace. Le coût vient de la CLI (`total_cost_usd`) : en mode clé API c'est ce qui
 * est facturé, sur l'abonnement c'est un équivalent API, un indicateur de consommation et non une facture.
 * Rattaché au mois de la dernière mise à jour de la review ou de la tâche, c'est-à-dire de sa fin.
 * @param db Base de données.
 * @param workspaceId Espace dont on mesure la consommation : celle des autres espaces n'entre jamais dans les totaux.
 * @returns Le détail et le total du mois.
 */
export function createCostRepo(db: Db, workspaceId: number) {
  const lines = async (month: string): Promise<CostLine[]> => {
    const rows = await db.all<{ kind: "review" | "dev"; project_path: string; usd: number; count: number }>(
      `SELECT 'review' AS kind, project_path, SUM(cost_usd) AS usd, CAST(COUNT(*) AS INTEGER) AS count
         FROM reviews WHERE workspace_id = ? AND cost_usd IS NOT NULL AND substr(updated_at, 1, 7) = ? GROUP BY project_path
       UNION ALL
       SELECT 'dev', project_path, SUM(cost_usd), CAST(COUNT(*) AS INTEGER)
         FROM dev_tasks WHERE workspace_id = ? AND cost_usd IS NOT NULL AND substr(updated_at, 1, 7) = ? GROUP BY project_path
       ORDER BY usd DESC`,
      [workspaceId, month, workspaceId, month],
    );
    return rows.map((r) => ({ kind: r.kind, projectPath: r.project_path, usd: Number(r.usd), count: Number(r.count) }));
  };

  return {
    /** Détail par type de tâche et par projet, du plus coûteux au moins coûteux. */
    breakdown: lines,

    async monthTotal(month: string): Promise<number> {
      return (await lines(month)).reduce((sum, l) => sum + l.usd, 0);
    },

    /**
     * Ce qu'une personne a consommé dans l'espace pendant un mois (reviews et tâches qu'elle a lancées, rattachées au mois de leur fin).
     * @param userId Personne concernée.
     * @param month Mois au format AAAA-MM.
     * @returns Le coût total en dollars (0 si rien, ou si ses reviews et tâches n'ont pas de coût connu).
     */
    async userMonthTotal(userId: number, month: string): Promise<number> {
      const row = await db.get<{ usd: number | null }>(
        `SELECT (SELECT COALESCE(SUM(cost_usd), 0) FROM reviews WHERE workspace_id = ? AND user_id = ? AND cost_usd IS NOT NULL AND substr(updated_at, 1, 7) = ?)
              + (SELECT COALESCE(SUM(cost_usd), 0) FROM dev_tasks WHERE workspace_id = ? AND user_id = ? AND cost_usd IS NOT NULL AND substr(updated_at, 1, 7) = ?) AS usd`,
        [workspaceId, userId, month, workspaceId, userId, month],
      );
      return Number(row?.usd ?? 0);
    },

    /**
     * Combien d'agents (reviews et tâches de dev) une personne a lancés dans l'espace depuis le début de la journée UTC.
     * @param userId Personne concernée.
     * @param now Date de référence (aujourd'hui par défaut).
     * @returns Le nombre de lancements du jour, ceux qui viennent d'être créés compris.
     */
    async userRunsToday(userId: number, now = new Date()): Promise<number> {
      const day = now.toISOString().slice(0, 10);
      const row = await db.get<{ n: number }>(
        `SELECT CAST((SELECT COUNT(*) FROM reviews WHERE workspace_id = ? AND user_id = ? AND substr(created_at, 1, 10) = ?)
                   + (SELECT COUNT(*) FROM dev_tasks WHERE workspace_id = ? AND user_id = ? AND substr(created_at, 1, 10) = ?) AS INTEGER) AS n`,
        [workspaceId, userId, day, workspaceId, userId, day],
      );
      return Number(row?.n ?? 0);
    },

    /**
     * Limites propres à un membre de l'espace.
     * @param userId Personne concernée.
     * @returns Son budget mensuel et son nombre d'agents par jour (null : valeur par défaut de l'espace ; 0 : sans limite), ou null/null si elle n'est pas membre.
     */
    async memberQuota(userId: number): Promise<{ budgetUsd: number | null; dailyRuns: number | null }> {
      const row = await db.get<{ budget_usd: number | null; daily_runs: number | null }>("SELECT budget_usd, daily_runs FROM memberships WHERE workspace_id = ? AND user_id = ?", [workspaceId, userId]);
      return { budgetUsd: row?.budget_usd === null || row?.budget_usd === undefined ? null : Number(row.budget_usd), dailyRuns: row?.daily_runs === null || row?.daily_runs === undefined ? null : Number(row.daily_runs) };
    },
  };
}
