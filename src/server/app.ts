import path from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { DevTaskRepo } from "../db/devTasks.js";
import type { ReviewStatus } from "../db/reviews.js";
import { cancelDevTask } from "../dev/pipeline.js";
import { renderTemplate, slugify } from "../dev/templates.js";
import { errorMessage } from "../logger.js";
import { PROJECT_ROOT } from "../paths.js";
import { readDefaultSystemPrompt } from "../prompts.js";
import { approve, publishComment, type PipelineDeps } from "../review/pipeline.js";
import type { Finding, ReviewResult } from "../review/schema.js";
import { ALLOWED_EFFORTS, ALLOWED_MODELS, DEFAULT_SETTINGS, type Settings } from "../settings/schema.js";

export interface ServerDeps extends PipelineDeps {
  tasks: DevTaskRepo;
  enqueueReview: (reviewId: number) => void;
  enqueueDev: (taskId: number) => void;
  queueSize: () => number;
}

type IdParams = { Params: { id: string } };

/** Colonne de l'onglet Tickets d'après les labels du workflow réglés dans le dashboard. */
export function classifyIssue(labels: string[], workflow: Settings["workflow"]): "techValidation" | "inProgress" | "todo" | "other" {
  const has = (list: string[]) => list.some((l) => labels.includes(l));
  if (has(workflow.techValidationLabels)) return "techValidation";
  if (has(workflow.inProgressLabels)) return "inProgress";
  if (has(workflow.todoLabels)) return "todo";
  return "other";
}

function fail(reply: FastifyReply, err: unknown, code = 502) {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "valeur"} : ${i.message}`).join(" · ") });
  }
  return reply.code(code).send({ error: errorMessage(err) });
}

/**
 * API + dashboard local. N'écoute que sur 127.0.0.1 (accessible depuis le navigateur Windows
 * grâce au forwarding localhost de WSL2), jamais exposé sur le réseau.
 */
export function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: path.join(PROJECT_ROOT, "public") });

  // Anti-CSRF : un site web ouvert dans ton navigateur pourrait sinon envoyer un POST vers
  // localhost:4321 et approuver une MR ou lancer l'agent à ta place. Un header custom impose
  // un preflight CORS que ce serveur ne valide jamais : seul le dashboard (même origine) peut agir.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-review-agent"] !== "1") {
      return reply.code(403).send({ error: "Header x-review-agent manquant" });
    }
  });

  // --- Général ---------------------------------------------------------------

  app.get("/api/stats", async () => {
    const settings = deps.settings.get();
    return {
      actionMode: settings.actionMode,
      model: settings.review.model,
      devModel: settings.dev.model,
      username: deps.config.gitlab.username,
      gitlabUrl: deps.config.gitlab.url,
      counts: deps.reviews.countByStatus(),
      queueSize: deps.queueSize(),
      agreement: deps.reviews.agreementStats(),
    };
  });

  // --- Paramètres ------------------------------------------------------------

  app.get("/api/settings", async () => ({
    settings: deps.settings.get(),
    defaults: DEFAULT_SETTINGS,
    options: { models: ALLOWED_MODELS, efforts: ALLOWED_EFFORTS },
    /** Prompts de base livrés avec l'outil, pour "repartir du prompt par défaut" dans le dashboard. */
    defaultSystemPrompts: { review: await readDefaultSystemPrompt("review"), dev: await readDefaultSystemPrompt("dev") },
  }));

  app.post<{ Body: unknown }>("/api/settings", async (req, reply) => {
    try {
      return { settings: deps.settings.save(req.body) };
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.get("/api/projects", async () => deps.settings.listProjects());

  app.post<{ Body: unknown }>("/api/projects", async (req, reply) => {
    try {
      return deps.settings.saveProject(req.body);
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.post<IdParams>("/api/projects/:id/delete", async (req) => {
    deps.settings.deleteProject(Number(req.params.id));
    return { ok: true };
  });

  app.get<{ Querystring: { search?: string } }>("/api/gitlab/projects", async (req, reply) => {
    try {
      const projects = await deps.gitlab.searchProjects(req.query.search ?? "");
      return projects.map((p) => ({ id: p.id, path: p.path_with_namespace, name: p.name, url: p.web_url }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<IdParams & { Querystring: { search?: string } }>("/api/gitlab/projects/:id/branches", async (req, reply) => {
    try {
      const branches = await deps.gitlab.listBranches(Number(req.params.id), req.query.search ?? "");
      return branches.map((b) => ({ name: b.name, default: b.default, protected: b.protected }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Tickets ---------------------------------------------------------------

  app.get("/api/issues", async (_req, reply) => {
    try {
      const settings = deps.settings.get();
      const projects = new Map(deps.settings.listProjects().map((p) => [p.projectId, p]));
      const latest = deps.tasks.latestByIssue();
      const issues = await deps.gitlab.listAssignedIssues();

      return issues.map((i) => {
        const project = projects.get(i.project_id);
        const task = latest.get(`${i.project_id}#${i.iid}`);
        return {
          projectId: i.project_id,
          projectPath: i.references?.full.replace(/#\d+$/, "") ?? String(i.project_id),
          iid: i.iid,
          title: i.title,
          labels: i.labels,
          url: i.web_url,
          updatedAt: i.updated_at ?? null,
          milestone: i.milestone?.title ?? null,
          column: classifyIssue(i.labels, settings.workflow),
          devReady: Boolean(project?.devEnabled),
          branchPreview: project?.devEnabled ? renderTemplate(settings.templates.branch, { iid: i.iid, title: i.title, slug: slugify(i.title) }) : null,
          baseBranch: project?.baseBranch ?? null,
          targetBranch: project?.targetBranch ?? null,
          task: task ? { id: task.id, status: task.status, mrUrl: task.mr_url, mrIid: task.mr_iid } : null,
        };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Agent dev -------------------------------------------------------------

  app.get("/api/tasks", async () => deps.tasks.list().map(({ result_json: _r, ...t }) => t));

  app.get<IdParams>("/api/tasks/:id", async (req, reply) => {
    const task = deps.tasks.get(Number(req.params.id));
    if (!task) return reply.code(404).send({ error: "Tâche introuvable" });
    return { ...task, result: task.result_json ? JSON.parse(task.result_json) : null };
  });

  app.get<IdParams & { Querystring: { after?: string } }>("/api/tasks/:id/events", async (req) => {
    return deps.tasks.events(Number(req.params.id), Number(req.query.after ?? 0));
  });

  app.post<{ Body: { projectId: number; issueIid: number; extraInstructions?: string } }>("/api/tasks", async (req, reply) => {
    try {
      const { projectId, issueIid } = req.body;
      const project = deps.settings.getProject(Number(projectId));
      if (!project?.devEnabled) return reply.code(400).send({ error: "Projet non configuré pour l'agent dev (Paramètres > Projets)" });
      if (deps.tasks.findActive(Number(projectId), Number(issueIid))) {
        return reply.code(409).send({ error: "Un agent travaille déjà sur ce ticket" });
      }
      const issue = await deps.gitlab.getIssue(Number(projectId), Number(issueIid));
      if (!issue) return reply.code(404).send({ error: "Ticket introuvable" });

      const id = deps.tasks.insert({
        projectId: project.projectId,
        projectPath: project.path,
        issueIid: issue.iid,
        issueTitle: issue.title,
        issueUrl: issue.web_url,
        extraInstructions: req.body.extraInstructions?.trim() || null,
      });
      deps.tasks.addEvent(id, "step", "Tâche créée, en attente de l'agent");
      deps.enqueueDev(id);
      return { id };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Reprise : relance l'agent sur la branche de la MR créée par cette tâche, avec des consignes. */
  app.post<IdParams & { Body: { instructions?: string } }>("/api/tasks/:id/followup", async (req, reply) => {
    try {
      const origin = deps.tasks.get(Number(req.params.id));
      if (!origin) return reply.code(404).send({ error: "Tâche introuvable" });
      const instructions = req.body?.instructions?.trim();
      if (!instructions) return reply.code(400).send({ error: "Les consignes de reprise sont obligatoires" });
      if (!origin.branch || !origin.mr_iid || !origin.mr_url || origin.status === "running" || origin.status === "queued") {
        return reply.code(400).send({ error: "Seule une tâche terminée liée à une MR peut être reprise" });
      }
      const project = deps.settings.getProject(origin.project_id);
      if (!project?.devEnabled) return reply.code(400).send({ error: "Projet non configuré pour l'agent dev (Paramètres > Projets)" });
      if (deps.tasks.findActive(origin.project_id, origin.issue_iid)) {
        return reply.code(409).send({ error: "Un agent travaille déjà sur ce ticket" });
      }

      const id = deps.tasks.insert({
        projectId: origin.project_id,
        projectPath: origin.project_path,
        issueIid: origin.issue_iid,
        issueTitle: origin.issue_title,
        issueUrl: origin.issue_url,
        extraInstructions: instructions,
        followup: {
          parentId: origin.id,
          branch: origin.branch,
          baseBranch: origin.base_branch,
          targetBranch: origin.target_branch,
          mrIid: origin.mr_iid,
          mrUrl: origin.mr_url,
        },
      });
      deps.tasks.addEvent(id, "step", `Reprise de la MR !${origin.mr_iid} (tâche #${origin.id}), en attente de l'agent`);
      deps.enqueueDev(id);
      return { id };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<IdParams>("/api/tasks/:id/cancel", async (req) => {
    const id = Number(req.params.id);
    const task = deps.tasks.get(id);
    if (!cancelDevTask(id) && task?.status === "queued") {
      deps.tasks.update(id, { status: "cancelled" });
      deps.tasks.addEvent(id, "step", "Tâche annulée avant démarrage");
    }
    return { ok: true };
  });

  /** Supprime le dossier de travail local d'une tâche terminée (la branche poussée n'est pas touchée). */
  app.post<IdParams>("/api/tasks/:id/cleanup", async (req, reply) => {
    try {
      const task = deps.tasks.get(Number(req.params.id));
      if (!task?.worktree_path) return { ok: true };
      if (task.status === "running" || task.status === "queued") return reply.code(409).send({ error: "Tâche en cours" });
      const project = await deps.gitlab.getProject(task.project_id);
      await deps.workspace.removeDevWorktree(task.project_id, project.http_url_to_repo, task.worktree_path);
      deps.tasks.update(task.id, { worktree_path: null });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Reviews ---------------------------------------------------------------

  /** Liste allégée : le résultat complet est remplacé par un décompte des points par sévérité. */
  app.get<{ Querystring: { status?: ReviewStatus } }>("/api/reviews", async (req) => {
    return deps.reviews.list(req.query.status).map(({ result_json, ...row }) => {
      const result = result_json ? (JSON.parse(result_json) as ReviewResult) : null;
      const count = (s: Finding["severity"]) => result?.findings.filter((f) => f.severity === s).length ?? 0;
      return {
        ...row,
        summary: result
          ? { blocking: count("blocking"), important: count("important"), suggestion: count("suggestion"), verdict: result.verdict, injection: result.injection_suspected }
          : null,
      };
    });
  });

  app.get<IdParams>("/api/reviews/:id", async (req, reply) => {
    const row = deps.reviews.get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "Review introuvable" });
    return { ...row, result: row.result_json ? JSON.parse(row.result_json) : null };
  });

  app.post<IdParams>("/api/reviews/:id/publish", async (req, reply) => {
    try {
      await publishComment(Number(req.params.id), deps, false);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<IdParams>("/api/reviews/:id/approve", async (req, reply) => {
    const id = Number(req.params.id);
    try {
      const row = deps.reviews.get(id);
      if (row?.status !== "published") await publishComment(id, deps, false);
      await approve(id, deps, false);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<IdParams>("/api/reviews/:id/dismiss", async (req) => {
    const id = Number(req.params.id);
    deps.reviews.setStatus(id, "dismissed");
    deps.reviews.logAction(id, "dismiss", false);
    return { ok: true };
  });

  app.post<IdParams>("/api/reviews/:id/retry", async (req) => {
    const id = Number(req.params.id);
    deps.reviews.setStatus(id, "queued");
    deps.reviews.logAction(id, "retry", false);
    deps.enqueueReview(id);
    return { ok: true };
  });

  /** Mode ombre : tu notes si tu es d'accord avec la décision de l'agent. */
  app.post<IdParams & { Body: { agree: boolean; note?: string } }>("/api/reviews/:id/feedback", async (req) => {
    deps.reviews.saveFeedback(Number(req.params.id), Boolean(req.body.agree), req.body.note?.trim() || null);
    return { ok: true };
  });

  return app;
}
