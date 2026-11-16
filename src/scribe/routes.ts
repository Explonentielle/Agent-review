import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRunner } from "../agent/index.js";
import type { AgentRunner } from "../agent/runner.js";
import { agentRunConfig } from "../claude/process.js";
import type { Config } from "../config.js";
import type { ForgeRegistry } from "../connectors/registry.js";
import type { ForgeKind, Ticket } from "../connectors/types.js";
import type { DevTaskRepo } from "../db/devTasks.js";
import { errorMessage, log } from "../logger.js";
import { loadSystemPrompt } from "../prompts.js";
import type { SettingsStore } from "../settings/store.js";
import type { Settings } from "../settings/schema.js";
import { ScribeInputError, cleanIdea, cleanProject, cleanTicket } from "./clean.js";
import { draftProject, draftTicket } from "./engine.js";
import { ScribeForgeError, explainForgeError } from "./errors.js";
import { HOURLY, ScribeLimitError, createLimiter } from "./limiter.js";
import { buildProjectPrompt, buildTicketPrompt } from "./prompt.js";

/** Ce que les routes du Scribe empruntent au serveur. */
export interface ScribeContext {
  /** Dépôts et connexions de la personne servie (résolus à chaque requête). */
  deps: { config: Config; forges: ForgeRegistry; settings: SettingsStore; tasks: DevTaskRepo };
  whoIs: (req: FastifyRequest) => { userId: number };
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
  forgeOf: (value: unknown) => ForgeKind;
  /** Colonne d'un ticket d'après ses étiquettes (réglages du workflow). */
  classify: (labels: string[], workflow: Settings["workflow"]) => string;
  /** Exécuteur d'agent imposé (tests). Absent : celui des réglages de la personne. */
  runner?: AgentRunner | undefined;
}

const MAX_FORGE_TICKETS = 100;

/**
 * Routes du Scribe : voir les tickets d'un projet, rédiger un brouillon avec l'agent, et, seulement quand la personne l'a validé, créer
 * le ticket ou le projet chez la forge. Le brouillon n'écrit jamais chez la forge ; la création passe par le connecteur (donc par le
 * journal d'audit), après une validation déterministe (`clean.ts`) et sous un plafond horaire (`limiter.ts`).
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 */
export function registerScribe(app: FastifyInstance, ctx: ScribeContext): void {
  const limiter = createLimiter();
  const { deps, fail } = ctx;
  const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const projectIdOf = (value: unknown): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new ScribeInputError("Projet invalide.");
    return n;
  };
  /** Erreurs de saisie et de plafond : lisibles telles quelles ; celles de la forge sont traduites par l'appelant. */
  const failScribe = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ScribeInputError) return reply.code(400).send({ error: err.message });
    if (err instanceof ScribeLimitError) return reply.code(429).send({ error: err.message });
    if (err instanceof ScribeForgeError) return reply.code(err.status).send({ error: err.message });
    return fail(reply, err);
  };

  /** Où l'on peut créer un projet (compte personnel, groupes ou organisations). */
  app.get<{ Querystring: { source?: string } }>("/api/forge/namespaces", async (req, reply) => {
    try {
      const source = ctx.forgeOf(req.query.source);
      return await deps.forges.get(source).connector.listNamespaces().catch((err: unknown) => {
        throw explainForgeError(source, "list", err);
      });
    } catch (err) {
      return failScribe(reply, err);
    }
  });

  /** Tickets ouverts d'un projet, avec le travail de l'agent dev quand il y en a. */
  app.get<{ Querystring: { source?: string; projectId?: string } }>("/api/forge/tickets", async (req, reply) => {
    try {
      const source = ctx.forgeOf(req.query.source);
      const projectId = projectIdOf(req.query.projectId);
      const [tickets, settings, latest, projects] = await Promise.all([
        deps.forges.get(source).connector.listProjectTickets(projectId).catch((err: unknown) => {
          throw explainForgeError(source, "list", err);
        }),
        deps.settings.get(),
        deps.tasks.latestByIssue(),
        deps.settings.listProjects(),
      ]);
      const project = projects.find((p) => p.source === source && p.projectId === projectId);
      return {
        source,
        projectId,
        devReady: Boolean(project?.devEnabled),
        tickets: tickets.slice(0, MAX_FORGE_TICKETS).map((t: Ticket) => {
          const task = latest.get(`${source}#${projectId}#${t.iid}`);
          return {
            iid: t.iid,
            title: t.title,
            labels: t.labels,
            url: t.url,
            updatedAt: t.updatedAt,
            column: ctx.classify(t.labels, settings.workflow),
            task: task ? { id: task.id, status: task.status, mrUrl: task.mr_url, error: task.error ? task.error.slice(0, 300) : null } : null,
          };
        }),
      };
    } catch (err) {
      return failScribe(reply, err);
    }
  });

  /** Rédige un brouillon (ticket ou projet) avec l'agent. N'écrit rien chez la forge. */
  app.post("/api/scribe/draft", async (req, reply) => {
    try {
      const b = body(req);
      const kind = b.kind === "project" ? "project" : b.kind === "ticket" ? "ticket" : null;
      if (!kind) throw new ScribeInputError("Dis-moi si c'est un ticket ou un projet.");
      const source = ctx.forgeOf(b.source);
      const idea = cleanIdea(b.idea);
      limiter.take(`${ctx.whoIs(req).userId}:draft`, HOURLY.drafts, "brouillons");

      const connector = deps.forges.get(source).connector;
      const settings = await deps.settings.get();
      const systemPrompt = await loadSystemPrompt("scribe", { override: "", instructions: "", project: null });
      // Quelques tours suffisent : l'agent n'a aucun outil et ne fait que rédiger
      const engine = { ...agentRunConfig(settings.review), maxTurns: 3, timeoutMs: 3 * 60_000 };
      const runner = ctx.runner ?? createRunner(deps.config, settings);

      if (kind === "ticket") {
        const projectId = projectIdOf(b.projectId);
        const project = await connector.getProject(projectId).catch((err: unknown) => {
          throw explainForgeError(source, "list", err);
        });
        let recent: Ticket[] = [];
        try {
          recent = await connector.listProjectTickets(projectId);
        } catch (err) {
          log.warn("scribe.recent_tickets_failed", { source, projectId, error: errorMessage(err) });
        }
        const allowedLabels = [...new Set([...settings.workflow.todoLabels, ...recent.flatMap((t) => t.labels)])].filter((l) => l.length > 0 && l.length <= 50 && !l.includes(",")).slice(0, 40);
        const { draft, costUsd } = await draftTicket({
          systemPrompt,
          prompt: buildTicketPrompt({ idea, project: { path: project.path, description: project.description }, recentTitles: recent.map((t) => t.title), allowedLabels }),
          engine,
          runner,
        });
        log.info("scribe.draft", { kind, source, projectId, costUsd });
        return {
          kind,
          project: { source, projectId, path: project.path },
          // L'agent ne peut proposer que des étiquettes autorisées : le reste est écarté ici, pas laissé à sa discrétion
          draft: { title: draft.title, description: draft.description, labels: draft.labels.filter((l) => allowedLabels.includes(l)), questions: draft.questions.slice(0, 5) },
          allowedLabels,
          costUsd,
        };
      }

      let existing: string[] = [];
      try {
        existing = (await connector.searchProjects("")).map((p) => p.path);
      } catch (err) {
        log.warn("scribe.projects_failed", { source, error: errorMessage(err) });
      }
      const { draft, costUsd } = await draftProject({ systemPrompt, prompt: buildProjectPrompt({ idea, existingProjects: existing }), engine, runner });
      log.info("scribe.draft", { kind, source, costUsd });
      return {
        kind,
        source,
        draft: { name: draft.name, description: draft.description, firstTickets: draft.first_tickets.slice(0, 8), questions: draft.questions.slice(0, 5) },
        costUsd,
      };
    } catch (err) {
      return failScribe(reply, err);
    }
  });

  /** Crée un ticket chez la forge, après la validation de la personne. */
  app.post("/api/scribe/tickets", async (req, reply) => {
    try {
      const b = body(req);
      const source = ctx.forgeOf(b.source);
      const projectId = projectIdOf(b.projectId);
      const ticket = cleanTicket({ title: b.title, description: b.description, labels: b.labels });
      limiter.take(`${ctx.whoIs(req).userId}:ticket`, HOURLY.tickets, "tickets créés");
      const created = await deps.forges.get(source).connector.createTicket(projectId, ticket).catch((err: unknown) => {
        throw explainForgeError(source, "ticket", err);
      });
      log.info("scribe.ticket_created", { source, projectId, iid: created.iid });
      return { source, projectId, iid: created.iid, title: created.title, url: created.url, projectPath: created.projectPath };
    } catch (err) {
      return failScribe(reply, err);
    }
  });

  /** Crée un projet (et, si la personne les a gardés, ses premiers tickets) chez la forge, après sa validation. */
  app.post("/api/scribe/projects", async (req, reply) => {
    try {
      const b = body(req);
      const source = ctx.forgeOf(b.source);
      const project = cleanProject({ name: b.name, description: b.description, private: b.private, withReadme: b.withReadme, namespaceId: b.namespaceId, tickets: b.tickets });
      const who = ctx.whoIs(req).userId;
      limiter.take(`${who}:project`, HOURLY.projects, "projets créés");
      // Les tickets de départ comptent dans le plafond, et il est vérifié avant de créer quoi que ce soit
      for (let i = 0; i < project.tickets.length; i++) limiter.take(`${who}:ticket`, HOURLY.tickets, "tickets créés");

      const connector = deps.forges.get(source).connector;
      const created = await connector
        .createProject({ name: project.name, description: project.description, ...(project.namespaceId !== undefined ? { namespaceId: project.namespaceId } : {}), private: project.private, withReadme: project.withReadme })
        .catch((err: unknown) => {
          throw explainForgeError(source, "project", err);
        });
      log.info("scribe.project_created", { source, projectId: created.id, private: project.private });

      // Un ticket qui échoue n'annule ni le projet ni les autres tickets : le résultat dit lesquels sont partis
      const tickets: Array<{ title: string; ok: boolean; iid?: number; url?: string; error?: string }> = [];
      for (const t of project.tickets) {
        try {
          const ticket = await connector.createTicket(created.id, t);
          tickets.push({ title: t.title, ok: true, iid: ticket.iid, url: ticket.url });
        } catch (err) {
          const explained = explainForgeError(source, "ticket", err);
          tickets.push({ title: t.title, ok: false, error: errorMessage(explained) });
        }
      }
      return { source, project: { id: created.id, path: created.path, name: created.name, url: created.url }, tickets };
    } catch (err) {
      return failScribe(reply, err);
    }
  });
}
