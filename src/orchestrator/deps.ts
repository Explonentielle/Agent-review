import type { AgentRunner } from "../agent/runner.js";
import type { Config } from "../config.js";
import type { ForgeRegistry } from "../connectors/registry.js";
import type { CostRepo } from "../db/costs.js";
import type { DevTaskRepo } from "../db/devTasks.js";
import type { PlanRepo } from "../db/plans.js";
import type { SettingsStore } from "../settings/store.js";

/** Ce que l'orchestrateur emprunte à la personne servie : ses dépôts, ses connexions aux forges et sa file de tâches de dev. */
export interface PlanDeps {
  config: Config;
  /** Forges de la personne : un plan passe toujours par celle qui l'a ouvert (colonne « source »). */
  forges: ForgeRegistry;
  settings: SettingsStore;
  costs: CostRepo;
  tasks: DevTaskRepo;
  plans: PlanRepo;
  /** Met une tâche de dev en file. */
  enqueueDev: (taskId: number) => void;
  /** Exécuteur d'agent imposé (tests). Absent : celui des réglages de la personne. */
  runner?: AgentRunner | undefined;
}

/** Tickets d'un plan au plus : au-delà, la validation créerait trop de tickets d'un coup. */
export const MAX_PLAN_ITEMS = 25;
/** Messages de la personne au plus par plan : borne la consommation d'un chat qui ne conclut pas. */
export const MAX_USER_MESSAGES = 30;
