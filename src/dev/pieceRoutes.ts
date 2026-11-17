import type { FastifyInstance, FastifyReply } from "fastify";
import type { ForgeRegistry } from "../connectors/registry.js";
import type { ChangeRequest, ChangeRequestState, CheckStatus, ForgeKind } from "../connectors/types.js";
import type { DevTaskRepo, DevTaskRow } from "../db/devTasks.js";
import type { ReviewRepo, ReviewRow, ReviewStatus } from "../db/reviews.js";
import { GithubError } from "../github/client.js";
import { GitlabError } from "../gitlab/client.js";
import { errorMessage, log } from "../logger.js";
import type { ReviewResult } from "../review/schema.js";
import type { SettingsStore } from "../settings/store.js";
import { REVIEW_OK, mergeReadiness, type Readiness } from "./merge.js";

/**
 * Routes de la « pièce » : la MR faite par l'agent dev. La relecture par le Gardien (l'agent de review) et, une fois qu'elle est OK, la
 * fusion dans la branche cible du projet. La fusion est une écriture chez la forge décidée par une personne (un clic confirmé), et seulement
 * si les règles de `merge.ts` sont satisfaites, recalculées ici à partir de ce que la forge dit maintenant.
 */
export interface PieceContext {
  /** Dépôts et connexions de la personne servie (résolus à chaque requête). */
  deps: { forges: ForgeRegistry; tasks: DevTaskRepo; reviews: ReviewRepo; settings: SettingsStore; enqueueReview: (reviewId: number) => void };
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
}

export interface PieceSummary {
  /** `unknown` : la forge n'a pas répondu. */
  state: ChangeRequestState | "unknown";
  draft: boolean;
  review: { id: number; status: ReviewStatus; current: boolean | null } | null;
}

/**
 * L'état en direct des pièces de quelques tâches : la MR chez la forge (ouverte, fusionnée, fermée) et la dernière review. Au plus 15 pièces,
 * lues en parallèle ; une forge qui ne répond pas donne `unknown` sans empêcher les autres. Sert à afficher le statut réel d'une pièce dans la forge.
 * @param deps Forges et reviews de la personne.
 * @param tasks Tâches à résumer (seules celles qui ont ouvert une MR comptent).
 * @returns Le résumé de chaque pièce, par identifiant de tâche.
 */
export async function summarizePieces(deps: { forges: ForgeRegistry; reviews: ReviewRepo }, tasks: DevTaskRow[]): Promise<Map<number, PieceSummary>> {
  const out = new Map<number, PieceSummary>();
  const forged = tasks.filter((t) => t.mr_iid && (t.status === "mr_created" || t.status === "mr_updated")).slice(0, 15);
  await Promise.all(
    forged.map(async (t) => {
      let mr: ChangeRequest | null = null;
      try {
        mr = await deps.forges.get(t.source).connector.getChangeRequest(t.project_id, t.mr_iid!);
      } catch (err) {
        log.warn("pieces.mr_unreadable", { taskId: t.id, error: errorMessage(err) });
      }
      const review = (await deps.reviews.listForMergeRequest(t.source, t.project_id, t.mr_iid!))[0] ?? null;
      out.set(t.id, {
        state: mr ? mr.state : "unknown",
        draft: mr?.draft ?? false,
        review: review ? { id: review.id, status: review.status, current: mr ? review.head_sha === mr.headSha : null } : null,
      });
    }),
  );
  return out;
}

/** Erreur lisible par la personne, avec son code HTTP. */
class PieceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reasons?: string[],
  ) {
    super(message);
  }
}

/** Traduit un refus de la forge à la fusion en ce que la personne peut faire. */
export function explainMergeError(kind: ForgeKind, err: unknown): unknown {
  const status = err instanceof GitlabError || err instanceof GithubError ? err.status : null;
  if (status === null) return err;
  const forge = kind === "github" ? "GitHub" : "GitLab";
  const detail = err instanceof Error ? err.message.replace(/^.*?→ \d+ : /, "").slice(0, 240) : "";
  if (status === 401) return new PieceError(`${forge} refuse le jeton (expiré, révoqué ou invalide).`, 401);
  if (status === 403) {
    return new PieceError(
      kind === "github"
        ? `${forge} refuse la fusion : le jeton doit avoir « Pull requests : lecture et écriture » et « Contents : lecture et écriture », et la branche cible peut exiger plus de droits.`
        : `${forge} refuse la fusion : sur une branche protégée, fusionner demande souvent le rôle Maintainer, et le jeton doit avoir le scope « api ».`,
      403,
    );
  }
  if (status === 409) return new PieceError("La MR a reçu un nouveau commit depuis la review : relance la relecture sur la version actuelle.", 409);
  if (status === 405 || status === 406 || status === 422) {
    return new PieceError(`${forge} refuse la fusion (conflit avec la branche cible, intégration continue exigée ou règle de protection de la branche) : ${detail}`, 409);
  }
  if (status === 404) return new PieceError(`${forge} ne trouve pas cette MR ou le jeton n'y a pas accès.`, 404);
  return err;
}

/** Un point de la relecture, tel que l'affiche la forge (texte non fiable : il est échappé à l'affichage et jamais exécuté). */
export interface FindingView { severity: "blocking" | "important" | "suggestion"; confirmed: boolean; title: string; location: string; explanation: string; suggestion: string | null }

/** Compte les points de la review par sévérité et les donne un par un, bornés (null si la review n'a pas de résultat). */
function summarize(review: ReviewRow): { verdict: string; summary: string; blocking: number; important: number; suggestion: number; findings: FindingView[]; questions: string[] } | null {
  if (!review.result_json) return null;
  try {
    const r = JSON.parse(review.result_json) as ReviewResult;
    const n = (s: "blocking" | "important" | "suggestion") => r.findings.filter((f) => f.severity === s).length;
    const order = { blocking: 0, important: 1, suggestion: 2 } as const;
    const findings = [...r.findings].sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 30).map((f) => ({
      severity: f.severity, confirmed: f.confirmed, title: f.title.slice(0, 200), location: f.location.slice(0, 200), explanation: f.explanation.slice(0, 1200), suggestion: f.suggestion?.slice(0, 800) ?? null,
    }));
    return { verdict: r.verdict, summary: r.summary.slice(0, 1200), blocking: n("blocking"), important: n("important"), suggestion: n("suggestion"), findings, questions: r.questions_for_author.slice(0, 10).map((q) => q.slice(0, 400)) };
  } catch {
    return null;
  }
}

/**
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 */
export function registerPiece(app: FastifyInstance, ctx: PieceContext): void {
  const { deps, fail } = ctx;
  const failPiece = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PieceError) return reply.code(err.status).send({ error: err.message, ...(err.reasons ? { reasons: err.reasons } : {}) });
    return fail(reply, err);
  };

  /** La tâche, si c'est bien une tâche qui a ouvert une MR. */
  async function pieceTask(id: number): Promise<DevTaskRow & { mr_iid: number }> {
    const task = await deps.tasks.get(id);
    if (!task) throw new PieceError("Tâche introuvable", 404);
    if (!task.mr_iid || (task.status !== "mr_created" && task.status !== "mr_updated")) throw new PieceError("Seule une tâche qui a ouvert une MR peut être relue ou fusionnée.", 400);
    return task as DevTaskRow & { mr_iid: number };
  }

  /** Tout ce que la fusion exige, lu maintenant chez la forge et dans l'outil. */
  async function readPiece(task: DevTaskRow & { mr_iid: number }) {
    const connector = deps.forges.get(task.source).connector;
    const mr: ChangeRequest = await connector.getChangeRequest(task.project_id, task.mr_iid).catch((err: unknown) => {
      throw new PieceError(`Impossible de lire la MR chez la forge : ${errorMessage(explainMergeError(task.source, err))}`, 502);
    });
    const reviews = await deps.reviews.listForMergeRequest(task.source, task.project_id, task.mr_iid);
    const project = await deps.settings.getProject(task.source, task.project_id);
    let checks: CheckStatus[] = [];
    let checksError: string | undefined;
    if (mr.state === "opened") {
      try {
        checks = await connector.getCheckStatuses(task.project_id, mr.headSha);
      } catch (err) {
        checksError = errorMessage(err).slice(0, 120);
      }
    }
    const latest = reviews[0] ?? null;
    const readiness: Readiness = project
      ? mergeReadiness({
          mr: { state: mr.state, draft: mr.draft, headSha: mr.headSha, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch },
          taskBranch: task.branch,
          projectTargetBranch: project.targetBranch,
          review: latest ? { status: latest.status, headSha: latest.head_sha } : null,
          checks,
          ...(checksError ? { checksError } : {}),
        })
      : { state: "blocked", ok: false, reasons: ["Le projet n'est plus configuré dans l'outil (Paramètres > Projets)."] };
    return { connector, mr, latest, checks, readiness, project };
  }

  /**
   * Les pièces forgées par l'agent dev qui attendent encore : une par MR ouverte, la plus récente d'abord, avec l'état de leur relecture.
   * Sert au Gardien, dans la forge. Une MR déjà fusionnée ou fermée n'y figure plus ; une forge qui ne répond pas n'empêche pas d'afficher les autres.
   */
  app.get("/api/pieces", async (_req, reply) => {
    try {
      const seen = new Set<string>();
      const latest: Array<DevTaskRow & { mr_iid: number }> = [];
      for (const t of await deps.tasks.list(200)) {
        if (!t.mr_iid || (t.status !== "mr_created" && t.status !== "mr_updated")) continue;
        const key = `${t.source}#${t.project_id}#${t.mr_iid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        latest.push(t as DevTaskRow & { mr_iid: number });
      }
      const items = await Promise.all(
        latest.slice(0, 20).map(async (t) => {
          let mr: ChangeRequest | null = null;
          let readiness: Readiness | null = null;
          const review = (await deps.reviews.listForMergeRequest(t.source, t.project_id, t.mr_iid))[0] ?? null;
          try {
            if (review && REVIEW_OK.includes(review.status)) {
              // Relue sans point à analyser : on lit aussi la CI et les règles, pour proposer la fusion quand elle est permise
              const piece = await readPiece(t);
              mr = piece.mr;
              readiness = piece.readiness;
            } else {
              mr = await deps.forges.get(t.source).connector.getChangeRequest(t.project_id, t.mr_iid);
            }
          } catch (err) {
            log.warn("pieces.mr_unreadable", { taskId: t.id, error: errorMessage(err) });
          }
          return {
            taskId: t.id,
            source: t.source,
            projectPath: t.project_path,
            issueIid: t.issue_iid,
            issueTitle: t.issue_title,
            mrIid: t.mr_iid,
            mrUrl: t.mr_url,
            mr: mr ? { state: mr.state, draft: mr.draft, targetBranch: mr.targetBranch } : null,
            readiness: readiness ? { ok: readiness.ok, reasons: readiness.reasons } : null,
            review: review ? { id: review.id, status: review.status, current: mr ? review.head_sha === mr.headSha : null } : null,
          };
        }),
      );
      return items.filter((i) => !i.mr || i.mr.state === "opened");
    } catch (err) {
      return failPiece(reply, err);
    }
  });

  /** État de la pièce : la MR, la dernière review, la CI et ce qui empêche ou permet la fusion. */
  app.get<{ Params: { id: string } }>("/api/tasks/:id/piece", async (req, reply) => {
    try {
      const task = await pieceTask(Number(req.params.id));
      const { mr, latest, checks, readiness, project } = await readPiece(task);
      const review = latest ? { id: latest.id, status: latest.status, current: latest.head_sha === mr.headSha, error: latest.error, ...(summarize(latest) ?? {}) } : null;
      // Un agent est-il déjà en train de reprendre cette pièce ? Alors on ne propose pas de nouvelle reprise.
      const active = await deps.tasks.findActive(task.source, task.project_id, task.issue_iid);
      const points = (review?.findings?.length ?? 0) + (review?.questions?.length ?? 0);
      const canFix = mr.state === "opened" && Boolean(project?.devEnabled) && !active && review !== null && review.current === true && points > 0 && !["queued", "running", "detected", "error"].includes(review.status);
      return {
        taskId: task.id,
        source: task.source,
        mr: { iid: mr.iid, url: mr.url, title: mr.title, state: mr.state, draft: mr.draft, headSha: mr.headSha, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch },
        review,
        followup: active ? { id: active.id, status: active.status } : null,
        canFix,
        checks: {
          total: checks.length,
          failed: checks.filter((c) => ["failed", "canceled", "cancelled"].includes(c.status.toLowerCase())).length,
          pending: checks.filter((c) => ["running", "pending", "created", "preparing", "scheduled", "waiting_for_resource"].includes(c.status.toLowerCase())).length,
        },
        readiness,
      };
    } catch (err) {
      return failPiece(reply, err);
    }
  });

  /** Lance la relecture de la pièce par le Gardien. Aucun commentaire ni approbation n'est posté : c'est un contrôle avant fusion. */
  app.post<{ Params: { id: string }; Body: { again?: boolean } | null }>("/api/tasks/:id/review", async (req, reply) => {
    try {
      const task = await pieceTask(Number(req.params.id));
      const connector = deps.forges.get(task.source).connector;
      const mr = await connector.getChangeRequest(task.project_id, task.mr_iid).catch((err: unknown) => {
        throw new PieceError(`Impossible de lire la MR chez la forge : ${errorMessage(explainMergeError(task.source, err))}`, 502);
      });
      if (mr.state !== "opened") throw new PieceError(mr.state === "merged" ? "La MR est déjà fusionnée." : "La MR est fermée.", 409);

      const existing = (await deps.reviews.listForMergeRequest(task.source, task.project_id, task.mr_iid)).find((r) => r.head_sha === mr.headSha);
      if (existing) {
        const waiting = existing.status === "queued" || existing.status === "running";
        const redo = existing.status === "detected" || existing.status === "error" || existing.status === "dismissed" || (req.body?.again === true && !waiting);
        if (!redo) return { id: existing.id, status: existing.status, already: true };
        await deps.reviews.setStatus(existing.id, "queued");
        await deps.reviews.logAction(existing.id, "retry", false);
        deps.enqueueReview(existing.id);
        return { id: existing.id, status: "queued", already: false };
      }
      const id = await deps.reviews.insertIfNew({
        source: task.source,
        projectId: task.project_id,
        projectPath: task.project_path,
        mrIid: mr.iid,
        mrTitle: mr.title,
        mrUrl: mr.url,
        author: mr.author.username,
        headSha: mr.headSha,
        status: "queued",
      });
      if (id === null) throw new PieceError("Une review de cette version existe déjà : réessaie dans un instant.", 409);
      deps.enqueueReview(id);
      log.info("piece.review_started", { taskId: task.id, reviewId: id, mr: mr.iid });
      return { id, status: "queued", already: false };
    } catch (err) {
      return failPiece(reply, err);
    }
  });

  /** Fusionne la pièce dans la branche cible du projet : après une review OK sur le commit actuel, et un clic confirmé de la personne. */
  app.post<{ Params: { id: string } }>("/api/tasks/:id/merge", async (req, reply) => {
    try {
      const task = await pieceTask(Number(req.params.id));
      const first = await readPiece(task);
      if (!first.readiness.ok) throw new PieceError(first.readiness.reasons[0] ?? "La fusion n'est pas permise.", 409, first.readiness.reasons);
      const reviewed = first.latest!.head_sha; // la règle ci-dessus garantit une review sur le commit actuel
      const { connector } = first;

      try {
        if (first.mr.draft) await connector.markChangeRequestReady(task.project_id, task.mr_iid);
        // La sortie du brouillon ne change pas le code, mais on ne fusionne que ce qui a été relu : on revérifie le commit juste avant
        const again = await connector.getChangeRequest(task.project_id, task.mr_iid);
        if (again.headSha !== reviewed) throw new PieceError("La MR a reçu un nouveau commit depuis la review : relance la relecture sur la version actuelle.", 409);
        await connector.mergeChangeRequest(task.project_id, task.mr_iid, reviewed);
      } catch (err) {
        throw explainMergeError(task.source, err);
      }

      await deps.tasks.addEvent(task.id, "step", `MR !${task.mr_iid} fusionnée dans ${first.mr.targetBranch} (commit relu ${reviewed.slice(0, 8)})`);
      log.info("piece.merged", { taskId: task.id, mr: task.mr_iid, target: first.mr.targetBranch });
      return { ok: true, merged: true, target: first.mr.targetBranch };
    } catch (err) {
      return failPiece(reply, err);
    }
  });
}
