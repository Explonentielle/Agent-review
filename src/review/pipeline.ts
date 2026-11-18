import { createRunner, type AgentRunner } from "../agent/index.js";
import { agentRunConfig } from "../claude/process.js";
import type { Config } from "../config.js";
import { assertBudgetAvailable } from "../budget.js";
import type { CostRepo } from "../db/costs.js";
import type { DevTaskRepo } from "../db/devTasks.js";
import type { ReviewRepo, ReviewRow } from "../db/reviews.js";
import type { ForgeRegistry } from "../connectors/registry.js";
import type { Ticket } from "../connectors/types.js";
import { errorMessage, log } from "../logger.js";
import { loadSystemPrompt } from "../prompts.js";
import { compileRules, type SettingsStore } from "../settings/store.js";
import { buildReviewPrompt, countChangedLines, filterDiffs, findLinkedIssueIids } from "./context.js";
import { decide } from "./decision.js";
import { runReviewAgent } from "./engine.js";
import { formatReviewComment } from "./format.js";
import { ReviewResultSchema } from "./schema.js";

export interface PipelineDeps {
  config: Config;
  /** Forges configurées : une review passe toujours par la forge qui l'a créée (colonne « source »). */
  forges: ForgeRegistry;
  costs: CostRepo;
  reviews: ReviewRepo;
  settings: SettingsStore;
  /**
   * Tâches de l'agent dev : quand la MR relue a été faite par l'agent, son ticket est connu exactement (la tâche l'enregistre) et la review
   * l'utilise au lieu de deviner les « #N » du titre. Absent : la review devine toujours d'après le texte.
   */
  tasks?: Pick<DevTaskRepo, "findByMergeRequest">;
  /** Force le mode ombre quel que soit le réglage (review manuelle en ligne de commande). */
  forceShadow?: boolean;
  /** Exécuteur d'agent imposé (tests). Par défaut : celui qui correspond aux réglages. */
  runner?: AgentRunner;
}

export async function runReview(reviewId: number, deps: PipelineDeps): Promise<void> {
  const { config, reviews } = deps;
  const row = await reviews.get(reviewId);
  if (!row) return;
  // Relus à chaque review : une modification dans le dashboard s'applique sans redémarrer
  const settings = await deps.settings.get();
  let actionMode = deps.forceShadow ? "shadow" : settings.actionMode;

  await reviews.setStatus(reviewId, "running");
  log.info("review.start", { reviewId, project: row.project_path, mr: row.mr_iid });

  let cleanup: (() => Promise<void>) | undefined;
  try {
    await assertBudgetAvailable(settings, deps.costs);
    const { connector, workspace } = deps.forges.get(row.source);
    const [project, mr] = await Promise.all([connector.getProject(row.project_id), connector.getChangeRequest(row.project_id, row.mr_iid)]);
    // La MR de l'agent dev est la tienne : la relire est un contrôle avant fusion, jamais un commentaire ni une approbation automatiques
    if (mr.author.username === deps.forges.get(row.source).username) actionMode = "shadow";

    if (mr.headSha !== row.head_sha) {
      // Nouveau commit poussé depuis la détection : le poller créera une review pour le nouveau sha
      await reviews.setStatus(reviewId, "dismissed");
      await reviews.logAction(reviewId, "dismiss", true, `obsolète : la MR est passée à ${mr.headSha.slice(0, 8)}`);
      return;
    }

    const allDiffs = await connector.getChangeRequestDiffs(row.project_id, row.mr_iid);
    const diffs = filterDiffs(allDiffs);
    // Ticket de la MR : le lien exact quand c'est l'agent dev qui l'a faite, sinon les « #N » du titre et de la description (une MR de collègue)
    const ownTask = await deps.tasks?.findByMergeRequest(row.source, row.project_id, row.mr_iid);
    const linkedIids = ownTask ? [ownTask.issue_iid] : findLinkedIssueIids(mr);
    const [commits, statuses, issues] = await Promise.all([
      connector.getChangeRequestCommits(row.project_id, row.mr_iid),
      connector.getCheckStatuses(row.project_id, mr.headSha),
      // Les tickets cités dans le titre ou la description (tout « #N », même dans une phrase) ne sont qu'un contexte facultatif : un ticket
      // supprimé, illisible ou qui n'est pas un ticket ne doit jamais faire échouer la review
      Promise.all(
        linkedIids.map((iid) =>
          connector.getTicket(row.project_id, iid).catch((err: unknown) => {
            log.warn("review.linked_issue_unreadable", { reviewId, issue: iid, error: errorMessage(err) });
            return null;
          }),
        ),
      ),
    ]);

    const checkout = await workspace.checkoutChangeRequest(row.project_id, project.cloneUrl, row.mr_iid, mr.headSha, connector.changeRequestHeadRef(row.mr_iid));
    cleanup = checkout.cleanup;

    const projectSettings = await deps.settings.getProject(row.source, row.project_id);
    const { result, costUsd, numTurns } = await runReviewAgent({
      cwd: checkout.path,
      systemPrompt: await loadSystemPrompt("review", {
        override: settings.systemPrompts.review,
        instructions: settings.instructions.review,
        project: projectSettings,
      }),
      prompt: buildReviewPrompt({
        project,
        mr,
        issues: issues.filter((i): i is Ticket => i !== null),
        diffs,
        commits,
        statuses,
      }),
      engine: agentRunConfig(settings.review),
      runner: deps.runner ?? createRunner(config, settings, projectSettings),
    });

    const changedLines = countChangedLines(diffs);
    const decision = decide({ result, changedLines, changedPaths: diffs.map((d) => d.newPath) }, compileRules(settings));

    await reviews.saveResult(reviewId, {
      status: decision.outcome,
      decisionReasons: decision.reasons,
      resultJson: JSON.stringify(result),
      changedLines,
      costUsd,
      numTurns,
    });
    log.info("review.done", { reviewId, outcome: decision.outcome, reasons: decision.reasons, costUsd, numTurns });

    if (decision.outcome === "auto_ok" && actionMode !== "shadow") {
      try {
        await publishComment(reviewId, deps, true);
        if (actionMode === "auto") await approve(reviewId, deps, true);
      } catch (err) {
        // La review elle-même est valide : on garde son statut, l'action reste rejouable depuis le dashboard
        log.error("review.auto_action_error", { reviewId, error: errorMessage(err) });
      }
    }
  } catch (err) {
    log.error("review.error", { reviewId, error: errorMessage(err) });
    await reviews.saveError(reviewId, errorMessage(err));
  } finally {
    await cleanup?.();
  }
}

function requireResult(row: ReviewRow) {
  if (!row.result_json) throw new Error(`La review ${row.id} n'a pas encore de résultat`);
  return ReviewResultSchema.parse(JSON.parse(row.result_json));
}

export async function publishComment(reviewId: number, deps: PipelineDeps, automatic: boolean): Promise<void> {
  const row = await deps.reviews.get(reviewId);
  if (!row) throw new Error(`Review ${reviewId} introuvable`);

  const body = formatReviewComment(requireResult(row), { model: (await deps.settings.get()).review.model, sha: row.head_sha });
  await deps.forges.get(row.source).connector.commentOnChangeRequest(row.project_id, row.mr_iid, body, "review");

  await deps.reviews.setStatus(reviewId, "published");
  await deps.reviews.logAction(reviewId, "comment", automatic);
  log.info("review.published", { reviewId, automatic });
}

export async function approve(reviewId: number, deps: PipelineDeps, automatic: boolean): Promise<void> {
  const row = await deps.reviews.get(reviewId);
  if (!row) throw new Error(`Review ${reviewId} introuvable`);

  // Le sha garantit qu'on approuve exactement le code reviewé
  await deps.forges.get(row.source).connector.approveChangeRequest(row.project_id, row.mr_iid, row.head_sha);

  await deps.reviews.setStatus(reviewId, "approved");
  await deps.reviews.logAction(reviewId, "approve", automatic);
  log.info("review.approved", { reviewId, automatic });
}
