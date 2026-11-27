import { BudgetExceededError, UserQuotaError, assertQuotaAvailable } from "../budget.js";
import type { ChangeRequest } from "../connectors/types.js";
import type { PlanItemRow, PlanItemStatus, PlanRow, PlanStatus } from "../db/plans.js";
import { cancelTask } from "../dev/pipeline.js";
import { errorMessage, log } from "../logger.js";
import { runChatTurn } from "./chat.js";
import type { NotifyEvent } from "../notify/webhook.js";
import type { PlanDeps } from "./deps.js";
import { toDbTime } from "./schedule.js";

/** Délai entre deux passages de l'orchestrateur sur les plans actifs. */
export const TICK_MS = 15_000;
/** Un ticket pris mais sans tâche depuis plus longtemps que cela a perdu son lancement (arrêt de l'outil entre les deux écritures). */
const LAUNCH_GRACE_MS = 2 * 60_000;
/** Délai minimum entre deux questions à la forge sur la MR qu'un plan attend : le planificateur passe plus souvent, la forge n'a pas à suivre. */
export const MERGE_CHECK_MS = 30_000;

/** Dernière question posée à la forge pour chaque plan, en mémoire : après un redémarrage de l'outil, la première vérification est immédiate. */
const lastMergeCheck = new Map<number, number>();

/**
 * Oublie les dernières vérifications de fusion (le délai minimum entre deux questions à la forge ne s'applique plus). Sert aux tests.
 * @returns Rien.
 */
export function resetMergeChecks(): void {
  lastMergeCheck.clear();
}

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
 * Option « attendre la fusion » du plan : vérifie que la MR du dernier ticket terminé est fusionnée avant de lancer le suivant, qui partirait sinon d'une
 * base sans son code. Sans MR connue pour ce ticket, rien ne retient le suivant. Une MR encore ouverte, une forge qui ne répond pas ou une MR qui ne vise pas
 * la branche d'où partent les tickets laissent le plan en attente, avec l'explication sur le plan ; une MR fermée sans fusion met le ticket en échec (la
 * personne le relance ou l'écarte). Seule la MR du dernier ticket terminé est contrôlée : les précédentes l'ont été à leur tour.
 * @param deps Dépôts, forges et réglages de la personne.
 * @param plan Plan en cours.
 * @param items Tickets du plan, dans l'ordre d'exécution.
 * @param next Prochain ticket à lancer.
 * @param now Date de référence.
 * @returns Vrai si le ticket suivant peut partir, faux s'il faut attendre.
 */
async function mergeGate(deps: PlanDeps, plan: PlanRow, items: PlanItemRow[], next: PlanItemRow, now: Date): Promise<boolean> {
  const previous = items.slice(0, items.indexOf(next)).filter((i) => i.status === "done").at(-1);
  if (!previous || previous.task_id === null) return true;
  const task = (await deps.tasks.getMany([previous.task_id])).get(previous.task_id);
  if (!task || task.mr_iid === null) return true;
  const mrIid = task.mr_iid;

  /** Garde l'explication sur le plan (sans réécrire à chaque passage), prévient la personne la première fois si un message est donné, et signale qu'il faut attendre. */
  const wait = async (message: string, notice?: NotifyEvent): Promise<false> => {
    if (plan.error !== message) {
      await deps.plans.update(plan.id, { error: message });
      if (notice) deps.notify?.(notice);
    }
    return false;
  };

  const last = lastMergeCheck.get(plan.id);
  if (last !== undefined && now.getTime() - last < MERGE_CHECK_MS) return false;
  lastMergeCheck.set(plan.id, now.getTime());

  let mr: ChangeRequest;
  try {
    mr = await deps.forges.get(plan.source).connector.getChangeRequest(plan.project_id, mrIid);
  } catch (err) {
    log.warn("plan.merge_check_failed", { planId: plan.id, error: errorMessage(err) });
    return wait(`En attente : la forge n'a pas répondu à propos de la MR !${mrIid} (${errorMessage(err).slice(0, 200)}). Nouvel essai dans un instant.`);
  }

  // Fusionner ailleurs que dans la branche d'où partent les tickets ne leur donnerait pas le code de cette MR
  const project = await deps.settings.getProject(plan.source, plan.project_id);
  if (project && mr.targetBranch !== project.baseBranch) {
    return wait(
      `En attente : la MR !${mr.iid} vise « ${mr.targetBranch} » alors que les tickets partent de « ${project.baseBranch} » : sa fusion ne leur donnerait pas son code. Aligne les deux branches (Paramètres > Projets) ou désactive l'attente de la fusion.`,
    );
  }
  if (mr.state === "merged") {
    lastMergeCheck.delete(plan.id);
    return true;
  }
  if (mr.state === "closed") {
    await deps.plans.updateItem(previous.id, { status: "failed", error: `La MR !${mr.iid} a été fermée sans être fusionnée : le ticket suivant en dépend. Relance ce ticket ou écarte-le.` }, ["done"]);
    return false;
  }
  return wait(`En attente de la fusion de la MR !${mr.iid} (ticket « ${previous.title} ») avant de lancer « ${next.title} ». Fusionne-la sur la forge ou depuis l'outil.`, {
    kind: "plan_waiting_merge",
    title: `MR à fusionner : ${plan.title}`,
    detail: `La MR !${mr.iid} (ticket « ${previous.title} ») attend ta fusion pour lancer « ${next.title} ».`,
    url: mr.url,
  });
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
 * tâches terminées, puis lance le ticket suivant (une fois la MR du précédent fusionnée, si le plan l'exige). Rien ne s'exécute sans validation : seuls
 * les plans validés (planifié, en cours, en pause) ou dont la personne a planifié le chat sont concernés. Si un ticket échoue, le plan s'arrête (statut
 * « en échec ») : les tickets suivants ne sont pas lancés.
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
    const error = `Le ticket « ${failed.title} » a échoué : ${failed.error ?? "raison inconnue"} Le plan est arrêté : les tickets suivants ne sont pas lancés.`;
    if (await deps.plans.transition(plan.id, ["running"], "failed", { error })) deps.notify?.({ kind: "plan_failed", title: `Plan en échec : ${plan.title}`, detail: error });
    return;
  }
  if (items.some((i) => i.status === "running")) return;
  const next = items.find((i) => i.status === "pending");
  if (!next) {
    if (items.every((i) => SETTLED.includes(i.status)) && (await deps.plans.transition(plan.id, ["running"], "done", { error: null }))) {
      const done = items.filter((i) => i.status === "done").length;
      deps.notify?.({ kind: "plan_done", title: `Plan terminé : ${plan.title}`, detail: `${done} ticket${done > 1 ? "s" : ""} sur ${items.length} traité${done > 1 ? "s" : ""} : les MR sont ouvertes.` });
    }
    return;
  }
  if (next.run_at && next.run_at > nowDb) return;
  if (plan.wait_for_merge === 1) {
    if (!(await mergeGate(deps, plan, items, next, now))) return;
    if (plan.error) await deps.plans.update(plan.id, { error: null }); // l'attente est levée : son explication ne vaut plus
  }
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
  lastMergeCheck.delete(planId);
  await deps.plans.cancelNotStarted(planId);
  for (const item of (await deps.plans.items(planId)).filter((i) => i.status === "running")) {
    if (item.task_id !== null) await cancelTask(deps.tasks, item.task_id);
    await deps.plans.updateItem(item.id, { status: "cancelled", error: null }, ["running"]);
  }
  return true;
}
