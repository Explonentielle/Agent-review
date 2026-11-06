import { readFile } from "node:fs/promises";
import path from "node:path";
import { agentRunConfig } from "../claude/process.js";
import type { Config } from "../config.js";
import type { ReviewRepo, ReviewRow } from "../db/reviews.js";
import type { GitlabClient } from "../gitlab/client.js";
import type { GitlabIssue } from "../gitlab/types.js";
import { errorMessage, log } from "../logger.js";
import { PROJECT_ROOT } from "../paths.js";
import { compileRules, type SettingsStore } from "../settings/store.js";
import { buildReviewPrompt, countChangedLines, filterDiffs, findLinkedIssueIids } from "./context.js";
import { decide } from "./decision.js";
import { runReviewAgent } from "./engine.js";
import { formatReviewComment } from "./format.js";
import { ReviewResultSchema } from "./schema.js";
import type { RepoWorkspace } from "./workspace.js";

export interface PipelineDeps {
  config: Config;
  gitlab: GitlabClient;
  reviews: ReviewRepo;
  workspace: RepoWorkspace;
  settings: SettingsStore;
  /** Force le mode ombre quel que soit le réglage (review manuelle en ligne de commande). */
  forceShadow?: boolean;
}

/**
 * Prompt système = règles de review génériques + tes instructions perso.
 * Relu à chaque review : modifier les fichiers de prompts/ s'applique sans redémarrer.
 */
async function loadSystemPrompt(): Promise<string> {
  const [base, perso] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, "prompts", "review-system.md"), "utf8"),
    readFile(path.join(PROJECT_ROOT, "prompts", "instructions-perso.md"), "utf8").catch(() => ""),
  ]);
  return perso.trim() ? `${base}\n\n# Instructions spécifiques du reviewer\n\n${perso}` : base;
}

export async function runReview(reviewId: number, deps: PipelineDeps): Promise<void> {
  const { config, gitlab, reviews, workspace } = deps;
  const row = reviews.get(reviewId);
  if (!row) return;
  // Relus à chaque review : une modification dans le dashboard s'applique sans redémarrer
  const settings = deps.settings.get();
  const actionMode = deps.forceShadow ? "shadow" : settings.actionMode;

  reviews.setStatus(reviewId, "running");
  log.info("review.start", { reviewId, project: row.project_path, mr: row.mr_iid });

  let cleanup: (() => Promise<void>) | undefined;
  try {
    const [project, mr] = await Promise.all([gitlab.getProject(row.project_id), gitlab.getMergeRequest(row.project_id, row.mr_iid)]);

    if (mr.sha !== row.head_sha) {
      // Nouveau commit poussé depuis la détection : le poller créera une review pour le nouveau sha
      reviews.setStatus(reviewId, "dismissed");
      reviews.logAction(reviewId, "dismiss", true, `obsolète : la MR est passée à ${mr.sha.slice(0, 8)}`);
      return;
    }

    const allDiffs = await gitlab.getMergeRequestDiffs(row.project_id, row.mr_iid);
    const diffs = filterDiffs(allDiffs);
    const [commits, statuses, issues] = await Promise.all([
      gitlab.getMergeRequestCommits(row.project_id, row.mr_iid),
      gitlab.getCommitStatuses(row.project_id, mr.sha),
      Promise.all(findLinkedIssueIids(mr).map((iid) => gitlab.getIssue(row.project_id, iid))),
    ]);

    const checkout = await workspace.checkoutMergeRequest(row.project_id, project.http_url_to_repo, row.mr_iid, mr.sha);
    cleanup = checkout.cleanup;

    const { result, costUsd, numTurns } = await runReviewAgent({
      cwd: checkout.path,
      systemPrompt: await loadSystemPrompt(),
      prompt: buildReviewPrompt({
        project,
        mr,
        issues: issues.filter((i): i is GitlabIssue => i !== null),
        diffs,
        commits,
        statuses,
      }),
      engine: agentRunConfig(config.claudeBin, settings.review),
    });

    const changedLines = countChangedLines(diffs);
    const decision = decide({ result, changedLines, changedPaths: diffs.map((d) => d.new_path) }, compileRules(settings));

    reviews.saveResult(reviewId, {
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
    reviews.saveError(reviewId, errorMessage(err));
  } finally {
    await cleanup?.();
  }
}

function requireResult(row: ReviewRow) {
  if (!row.result_json) throw new Error(`La review ${row.id} n'a pas encore de résultat`);
  return ReviewResultSchema.parse(JSON.parse(row.result_json));
}

export async function publishComment(reviewId: number, deps: PipelineDeps, automatic: boolean): Promise<void> {
  const row = deps.reviews.get(reviewId);
  if (!row) throw new Error(`Review ${reviewId} introuvable`);

  const body = formatReviewComment(requireResult(row), { model: deps.settings.get().review.model, sha: row.head_sha });
  await deps.gitlab.createMergeRequestDiscussion(row.project_id, row.mr_iid, body);

  deps.reviews.setStatus(reviewId, "published");
  deps.reviews.logAction(reviewId, "comment", automatic);
  log.info("review.published", { reviewId, automatic });
}

export async function approve(reviewId: number, deps: PipelineDeps, automatic: boolean): Promise<void> {
  const row = deps.reviews.get(reviewId);
  if (!row) throw new Error(`Review ${reviewId} introuvable`);

  // Le sha garantit qu'on approuve exactement le code reviewé
  await deps.gitlab.approveMergeRequest(row.project_id, row.mr_iid, row.head_sha);

  deps.reviews.setStatus(reviewId, "approved");
  deps.reviews.logAction(reviewId, "approve", automatic);
  log.info("review.approved", { reviewId, automatic });
}
