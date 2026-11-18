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

/** Limite personnelle atteinte : budget du mois (mode clé API) ou nombre d'agents du jour. Le message dit quoi faire. */
export class UserQuotaError extends Error {
  constructor(
    readonly kind: "budget" | "runs",
    message: string,
  ) {
    super(message);
    this.name = "UserQuotaError";
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

/**
 * Refuse de lancer un agent pour une personne qui a atteint SA limite. Deux limites, chacune sans effet à 0 : le budget du mois en dollars (seulement en mode clé API,
 * comme le budget de l'espace) et le nombre d'agents (reviews et tâches de dev) lancés depuis le début de la journée UTC (dans les deux modes : c'est la seule limite qui
 * protège un abonnement). La valeur propre au membre prime sur la valeur par défaut de l'espace.
 * @param settings Réglages de l'espace (valeurs par défaut des limites, mode de connexion à Claude).
 * @param costs Consommation de l'espace.
 * @param userId Personne pour qui l'agent est lancé, ou null (review ou tâche d'avant les quotas : aucune limite personnelle).
 * @param options `pending` : l'agent à lancer n'est pas encore compté (contrôle avant création) ; sinon il l'est déjà (contrôle au démarrage de la file). `now` : date de référence.
 * @returns Rien.
 * @throws UserQuotaError Si une limite personnelle est atteinte.
 */
export async function assertQuotaAvailable(settings: Settings, costs: CostRepo, userId: number | null, options: { pending?: boolean; now?: Date } = {}): Promise<void> {
  if (userId === null) return;
  const now = options.now ?? new Date();
  const own = await costs.memberQuota(userId);
  const monthlyUsd = own.budgetUsd ?? settings.quotas.perUserMonthlyUsd;
  const dailyRuns = own.dailyRuns ?? settings.quotas.perUserDailyRuns;

  if (settings.agentAuth === "api" && monthlyUsd > 0) {
    const spent = await costs.userMonthTotal(userId, currentMonth(now));
    if (spent >= monthlyUsd) {
      throw new UserQuotaError("budget", `Ton budget mensuel est atteint : ${spent.toFixed(2)} $ dépensés sur ${monthlyUsd.toFixed(2)} $. Un administrateur peut le relever (Paramètres > Équipe), ou attends le mois prochain.`);
    }
  }
  if (dailyRuns > 0) {
    const runs = (await costs.userRunsToday(userId, now)) + (options.pending ? 1 : 0);
    if (runs > dailyRuns) {
      throw new UserQuotaError("runs", `Tu as atteint ta limite de ${dailyRuns} agent${dailyRuns > 1 ? "s" : ""} par jour. Un administrateur peut la relever (Paramètres > Équipe), ou réessaie demain (UTC).`);
    }
  }
}
