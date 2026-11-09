import { currentMonth, type CostRepo } from "./db/costs.js";
import type { Settings } from "./settings/schema.js";

export class BudgetExceededError extends Error {
  constructor(spent: number, limit: number) {
    super(
      `Budget mensuel atteint : ${spent.toFixed(2)} $ dépensés sur ${limit.toFixed(2)} $. ` +
        "Augmente le budget dans Paramètres > Modèles, repasse sur l'abonnement, ou attends le mois prochain.",
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Refuse de lancer un agent si le budget du mois est atteint. Seulement en mode clé API (c'est là que
 * chaque tâche est facturée) et seulement si un budget est fixé : sur l'abonnement, les coûts sont
 * un équivalent API sans conséquence financière.
 */
export async function assertBudgetAvailable(settings: Settings, costs: CostRepo, now = new Date()): Promise<void> {
  if (settings.agentAuth !== "api" || settings.budget.monthlyUsd <= 0) return;
  const spent = await costs.monthTotal(currentMonth(now));
  if (spent >= settings.budget.monthlyUsd) throw new BudgetExceededError(spent, settings.budget.monthlyUsd);
}
