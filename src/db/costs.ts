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
 * Consommation des agents. Le coût vient de la CLI (`total_cost_usd`) : en mode clé API c'est ce qui
 * est facturé, sur l'abonnement c'est un équivalent API, un indicateur de consommation et non une facture.
 * Rattaché au mois de la dernière mise à jour de la review ou de la tâche, c'est-à-dire de sa fin.
 */
export function createCostRepo(db: Db) {
  const lines = async (month: string): Promise<CostLine[]> => {
    const rows = await db.all<{ kind: "review" | "dev"; project_path: string; usd: number; count: number }>(
      `SELECT 'review' AS kind, project_path, SUM(cost_usd) AS usd, CAST(COUNT(*) AS INTEGER) AS count
         FROM reviews WHERE cost_usd IS NOT NULL AND substr(updated_at, 1, 7) = ? GROUP BY project_path
       UNION ALL
       SELECT 'dev', project_path, SUM(cost_usd), CAST(COUNT(*) AS INTEGER)
         FROM dev_tasks WHERE cost_usd IS NOT NULL AND substr(updated_at, 1, 7) = ? GROUP BY project_path
       ORDER BY usd DESC`,
      [month, month],
    );
    return rows.map((r) => ({ kind: r.kind, projectPath: r.project_path, usd: Number(r.usd), count: Number(r.count) }));
  };

  return {
    /** Détail par type de tâche et par projet, du plus coûteux au moins coûteux. */
    breakdown: lines,

    async monthTotal(month: string): Promise<number> {
      return (await lines(month)).reduce((sum, l) => sum + l.usd, 0);
    },
  };
}
