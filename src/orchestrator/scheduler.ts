import { BudgetExceededError, UserQuotaError, assertQuotaAvailable } from "../budget.js";
import type { PlanItemRow, PlanItemStatus, PlanRow, PlanStatus } from "../db/plans.js";
import { cancelTask } from "../dev/pipeline.js";
import { errorMessage, log } from "../logger.js";
import { runChatTurn } from "./chat.js";
import type { PlanDeps } from "./deps.js";
import { toDbTime } from "./schedule.js";

/** Délai entre deux passages de l'orchestrateur sur les plans actifs. */
export const TICK_MS = 15_000;
/** Un ticket pris mais sans tâche depuis plus longtemps que cela a perdu son lancement (arrêt de l'outil entre les deux écritures). */
const LAUNCH_GRACE_MS = 2 * 60_000;

/** Statuts d'un plan que la personne peut encore annuler. */
const CANCELLABLE: PlanStatus[] = ["waiting_chat", "chatting", "review", "scheduled", "running", "paused", "failed"];
const SETTLED: PlanItemStatus[] = ["done", "skipped", "cancelled"];

/**
 * Message qui explique pourquoi la tâche de l'agent n'a pas abouti.
 * @param status Statut final de la tâche.
 * @param taskId Identifiant de la tâche.
 * @param error Erreur enregistrée par la tâche.
 * @returns Le message affiché sur le ticket du plan.
 */
function failureOf(status: string | undefined, taskId: number | null, error: string | null | undefined): string {
  if (status === "blocked") return `L'agent a besoin de précisions : lis ses questions dans la tâche #${taskId}.`;
  if (status === "cancelled") return "La tâche de l'agent a été annulée.";
  if (!status) return "La tâche de l'agent est introuvable.";
  return (error ?? "La tâche de l'agent a échoué.").slice(0, 500);
}

/**
 * Reporte sur les tickets du plan le résultat des tâches de l'agent qui ont fini : MR ouverte ou mise à jour = terminé ; échec, annulation ou
 * questions de l'agent = en échec.
 * @param deps Dépôts de la personne.
 * @param items Tickets du plan.
 * @param now Date de référence.
 * @returns Rien.
 */
async function syncItems(deps: PlanDeps, items: PlanItemRow[], now: Date): Promise<void> {
  const running = items.filter((i) => i.status === "running");
  const tasks = await deps.tasks.getMany(running.flatMap((i) => (i.task_id === null ? [] : [i.task_id])));
  for (const item of running) {
    if (item.task_id === null) {
      // Pris, mais la tâche n'est pas encore créée : un lancement en cours, sauf si l'outil s'est arrêté entre les deux écritures
      if (item.updated_at > toDbTime(new Date(now.getTime() - LAUNCH_GRACE_MS))) continue;
      await deps.plans.updateItem(item.id, { status: "failed", error: "Le lancement du ticket a été interrompu." }, ["running"]);
      continue;
    }
    const task = tasks.get(item.task_id);
    if (task?.status === "queued" || task?.status === "running") continue;
    if (task?.status === "mr_created" || task?.status === "mr_updated") await deps.plans.updateItem(item.id, { status: "done", error: null }, ["running"]);
    else await deps.plans.updateItem(item.id, { status: "failed", error: failureOf(task?.status, item.task_id, task?.error) }, ["running"]);
  }
}

/**
 * Lance la tâche de l'agent dev sur le ticket du plan. Les refus qui peuvent passer (quota atteint, agent déjà au travail sur ce ticket) laissent
 * le ticket en attente pour le prochain passage ; les autres le mettent en échec.
 * @param deps Dépôts de la personne.
 * @param plan Plan en cours.
 * @param item Prochain ticket à lancer.
 * @returns Rien.
 */
async function launchItem(deps: PlanDeps, plan: PlanRow, item: PlanItemRow): Promise<void> {
  const fail = (message: string) => deps.plans.updateItem(item.id, { status: "failed", error: message }, ["pending"]);
  if (item.issue_iid === null) {
    await fail("Le ticket n'a pas été créé chez la forge.");
    return;
  }
  const project = await deps.settings.getProject(plan.source, plan.project_id);
  if (!project?.devEnabled) {
    await fail("Projet non configuré pour l'agent dev (Paramètres > Projets).");
    return;
  }
  // Un agent travaille déjà sur ce ticket (lancé à la main) : on attend qu'il ait fini
  if (await deps.tasks.findActive(plan.source, plan.project_id, item.issue_iid)) return;
  try {
    await assertQuotaAvailable(await deps.settings.get(), deps.costs, plan.user_id, { pending: true });
  } catch (err) {
    if (!(err instanceof UserQuotaError || err instanceof BudgetExceededError)) throw err;
    await deps.plans.update(plan.id, { error: `En attente : ${err.message}` });
    return;
  }
  // Un seul lancement par ticket, même si deux passages arrivent en même temps
  if (!(await deps.plans.claimItem(item.id))) return;
  try {
    const taskId = await deps.tasks.insert({
      source: plan.source,
      projectId: plan.project_id,
      projectPath: project.path,
      issueIid: item.issue_iid,
      issueTitle: item.title,
      issueUrl: item.issue_url ?? "",
      extraInstructions: null,
    });
    await deps.plans.updateItem(item.id, { task_id: taskId });
    await deps.tasks.addEvent(taskId, "step", `Tâche créée par le plan #${plan.id} (ticket ${item.position}), en attente de l'agent`);
    if (plan.error) await deps.plans.update(plan.id, { error: null });
    deps.enqueueDev(taskId);
    log.info("plan.item_started", { planId: plan.id, itemId: item.id, taskId });
  } catch (err) {
    await deps.plans.updateItem(item.id, { status: "failed", error: errorMessage(err).slice(0, 500) }, ["running"]);
  }
}

/**
 * Fait avancer UN plan d'un pas : démarre le chat planifié dont l'heure est venue, passe l'exécution planifiée en cours, reporte le résultat des
 * tâches terminées, puis lance le ticket suivant. Rien ne s'exécute sans validation : seuls les plans validés (planifié, en cours, en pause) ou dont
 * la personne a planifié le chat sont concernés. Si un ticket échoue, le plan s'arrête (statut « en échec ») : les tickets suivants ne sont pas lancés.
 * @param deps Dépôts, forges et file de la personne.
 * @param planId Plan à faire avancer.
 * @param now Date de référence (remplaçable dans les tests).
 * @returns Rien.
 */
export async function advancePlan(deps: PlanDeps, planId: number, now: Date = new Date()): Promise<void> {
  const plan = await deps.plans.get(planId);
  if (!plan) return;
  const nowDb = toDbTime(now);

  if (plan.status === "waiting_chat") {
    if (plan.chat_at && plan.chat_at > nowDb) return;
    if (await deps.plans.startChat(plan.id)) await runChatTurn(deps, { ...plan, status: "chatting", busy: 1 });
    return;
  }
  if (plan.status === "scheduled") {
    if (plan.run_at && plan.run_at > nowDb) return;
    if (!(await deps.plans.transition(plan.id, ["scheduled"], "running"))) return;
    plan.status = "running";
  }
  if (plan.status !== "running" && plan.status !== "paused") return;

  // Le résultat des tâches terminées est reporté même en pause ; seul le lancement du suivant est suspendu
  await syncItems(deps, await deps.plans.items(plan.id), now);
  if (plan.status !== "running") return;

  const items = await deps.plans.items(plan.id);
  const failed = items.find((i) => i.status === "failed");
  if (failed) {
    await deps.plans.transition(plan.id, ["running"], "failed", {
      error: `Le ticket « ${failed.title} » a échoué : ${failed.error ?? "raison inconnue"} Le plan est arrêté : les tickets suivants ne sont pas lancés.`,
    });
    return;
  }
  if (items.some((i) => i.status === "running")) return;
  const next = items.find((i) => i.status === "pending");
  if (!next) {
    if (items.every((i) => SETTLED.includes(i.status))) await deps.plans.transition(plan.id, ["running"], "done", { error: null });
    return;
  }
  if (next.run_at && next.run_at > nowDb) return;
  await launchItem(deps, plan, next);
}

/**
 * Un passage sur tous les plans actifs de la personne. Une erreur sur un plan n'empêche pas les autres d'avancer.
 * @param deps Dépôts, forges et file de la personne.
 * @param now Date de référence.
 * @returns Rien.
 */
export async function tickPlans(deps: PlanDeps, now: Date = new Date()): Promise<void> {
  for (const plan of await deps.plans.listActive()) {
    try {
      await advancePlan(deps, plan.id, now);
    } catch (err) {
      log.error("plan.advance_failed", { planId: plan.id, error: errorMessage(err) });
    }
  }
}

/**
 * Démarre l'orchestrateur d'une personne : il repasse sur ses plans à intervalle régulier (les dates de lancement sont tenues à ce délai près).
 * @param deps Dépôts, forges et file de la personne.
 * @param intervalMs Délai entre deux passages.
 * @returns La fonction qui l'arrête.
 */
export function startPlanScheduler(deps: PlanDeps, intervalMs: number = TICK_MS): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tickPlans(deps)
      .catch((err: unknown) => log.error("plan.tick_failed", { error: errorMessage(err) }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Annule un plan : plus rien n'est lancé, les tickets qui n'ont pas démarré sont annulés et l'agent en cours est arrêté. Les tickets déjà créés chez
 * la forge y restent (l'outil ne les supprime pas), ainsi que les branches et MR déjà ouvertes.
 * @param deps Dépôts de la personne.
 * @param planId Plan à annuler.
 * @returns Vrai si le plan a été annulé, faux s'il était déjà terminé ou annulé (ou inconnu).
 */
export async function cancelPlan(deps: PlanDeps, planId: number): Promise<boolean> {
  if (!(await deps.plans.transition(planId, CANCELLABLE, "cancelled", { error: null }))) return false;
  await deps.plans.cancelNotStarted(planId);
  for (const item of (await deps.plans.items(planId)).filter((i) => i.status === "running")) {
    if (item.task_id !== null) await cancelTask(deps.tasks, item.task_id);
    await deps.plans.updateItem(item.id, { status: "cancelled", error: null }, ["running"]);
  }
  return true;
}
