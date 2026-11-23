import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentRunner } from "../agent/runner.js";
import type { ForgeKind } from "../connectors/types.js";
import type { PlanItemRow, PlanRepo, PlanRow } from "../db/plans.js";
import { errorMessage, log } from "../logger.js";
import { ScribeInputError, cleanIdea, cleanTicket } from "../scribe/clean.js";
import { ScribeForgeError, explainForgeError } from "../scribe/errors.js";
import { HOURLY, ScribeLimitError, createLimiter } from "../scribe/limiter.js";
import type { TenantDeps } from "../tenants/manager.js";
import { runChatTurn } from "./chat.js";
import { MAX_PLAN_ITEMS, MAX_USER_MESSAGES, type PlanDeps } from "./deps.js";
import { PlanConflictError, PlanForbiddenError, PlanInputError, PlanNotFoundError } from "./errors.js";
import { advancePlan, cancelPlan } from "./scheduler.js";
import { parseWhen, toDbTime, toIso } from "./schedule.js";

/** Ce que les routes de l'orchestrateur empruntent au serveur. */
export interface PlanContext {
  /** Dépôts et connexions de la personne servie (résolus à chaque requête). */
  deps: TenantDeps;
  whoIs: (req: FastifyRequest) => { userId: number };
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
  forgeOf: (value: unknown) => ForgeKind;
  /** Exécuteur d'agent imposé (tests). Absent : celui des réglages de la personne. */
  runner?: AgentRunner | undefined;
}

/** Statuts où le chat est ouvert : la personne peut écrire et corriger la liste des tickets. */
const EDITABLE = ["chatting", "review"] as const;

/**
 * Routes de l'orchestrateur : ouvrir un chat de cadrage (tout de suite ou à une date), relire et corriger le plan de tickets, le valider, puis suivre,
 * réordonner, mettre en pause ou annuler son exécution. Rien n'est créé chez la forge ni lancé avant la route `validate`, qui exige une confirmation
 * explicite ; l'agent du chat n'a aucun outil. La création passe par le connecteur (donc par le journal d'audit), après la validation déterministe de
 * `scribe/clean.ts` et sous un plafond horaire.
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 */
export function registerPlans(app: FastifyInstance, ctx: PlanContext): void {
  const limiter = createLimiter();
  const { fail } = ctx;
  const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const positiveInt = (value: unknown, what: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) throw new PlanInputError(`${what} invalide.`);
    return n;
  };

  /** Dépôts de la personne servie par cette requête. */
  const planDeps = (): PlanDeps => {
    const d = ctx.deps;
    if (!d.plans) throw new PlanConflictError("L'orchestrateur n'est pas disponible sur cette installation.");
    return { config: d.config, forges: d.forges, settings: d.settings, costs: d.costs, tasks: d.tasks, plans: d.plans, enqueueDev: d.enqueueDev, runner: ctx.runner };
  };
  /** Fait avancer le plan tout de suite, sans attendre le prochain passage de l'orchestrateur. Une erreur est journalisée : l'action de la personne a réussi. */
  const kick = (deps: PlanDeps, planId: number): Promise<void> =>
    advancePlan(deps, planId).catch((err: unknown) => log.warn("plan.advance_failed", { planId, error: errorMessage(err) }));

  /**
   * Le plan de l'URL, ou 404. Avec `req`, la requête doit venir de la personne qui a ouvert le plan : il s'exécute avec SES connexions aux forges et
   * SES quotas, un autre membre de l'espace peut le lire, le mettre en pause ou l'annuler, mais pas le faire avancer.
   */
  const planOf = async (plans: PlanRepo, id: unknown, req?: FastifyRequest): Promise<PlanRow> => {
    const plan = await plans.get(positiveInt(id, "Plan"));
    if (!plan) throw new PlanNotFoundError();
    if (req && plan.user_id !== null && plan.user_id !== ctx.whoIs(req).userId) throw new PlanForbiddenError("Ce plan a été ouvert par une autre personne de l'espace : elle seule peut le faire avancer.");
    return plan;
  };

  const failPlan = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PlanNotFoundError) return reply.code(404).send({ error: "Plan introuvable" });
    if (err instanceof PlanInputError || err instanceof ScribeInputError) return reply.code(400).send({ error: err.message });
    if (err instanceof PlanForbiddenError) return reply.code(403).send({ error: err.message });
    if (err instanceof PlanConflictError) return reply.code(409).send({ error: err.message });
    if (err instanceof ScribeLimitError) return reply.code(429).send({ error: err.message });
    if (err instanceof ScribeForgeError) return reply.code(err.status).send({ error: err.message });
    return fail(reply, err);
  };

  const present = (plan: PlanRow) => ({
    id: plan.id,
    source: plan.source,
    projectId: plan.project_id,
    projectPath: plan.project_path,
    kind: plan.kind,
    title: plan.title,
    status: plan.status,
    chatAt: toIso(plan.chat_at),
    runAt: toIso(plan.run_at),
    busy: plan.busy === 1,
    error: plan.error,
    costUsd: plan.cost_usd,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
  });

  /** Liste des plans de la personne, avec leur avancement. */
  app.get("/api/plans", async (_req, reply) => {
    try {
      const { plans } = planDeps();
      const [rows, counts] = await Promise.all([plans.list(), plans.countsByPlan()]);
      return rows.map((plan) => ({ ...present(plan), counts: counts.get(plan.id) ?? { total: 0, upcoming: 0, running: 0, done: 0, failed: 0, skipped: 0 } }));
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Un plan : échange de cadrage, tickets (avec l'état de la tâche de l'agent) et avancement. */
  app.get<{ Params: { id: string } }>("/api/plans/:id", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id);
      const [messages, items] = await Promise.all([deps.plans.messages(plan.id), deps.plans.items(plan.id)]);
      const tasks = await deps.tasks.getMany(items.flatMap((i) => (i.task_id === null ? [] : [i.task_id])));
      return {
        plan: present(plan),
        maxItems: MAX_PLAN_ITEMS,
        messages: messages.map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.created_at })),
        items: items.map((i) => {
          const task = i.task_id === null ? undefined : tasks.get(i.task_id);
          return {
            id: i.id,
            position: i.position,
            title: i.title,
            description: i.description,
            labels: JSON.parse(i.labels) as string[],
            runAt: toIso(i.run_at),
            status: i.status,
            issueIid: i.issue_iid,
            issueUrl: i.issue_url,
            error: i.error,
            task: task ? { id: task.id, status: task.status, mrUrl: task.mr_url } : null,
          };
        }),
      };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /**
   * Ouvre un plan : la personne décrit sa fonctionnalité ou son projet. Le chat commence tout de suite (l'orchestrateur répond par ses premières
   * questions) ou à la date choisie. Rien n'est créé chez la forge.
   */
  app.post("/api/plans", async (req, reply) => {
    try {
      const deps = planDeps();
      const b = body(req);
      const kind = b.kind === "project" ? "project" : b.kind === "feature" ? "feature" : null;
      if (!kind) throw new PlanInputError("Dis-moi si c'est une fonctionnalité ou un projet complet.");
      const source = ctx.forgeOf(b.source);
      const projectId = positiveInt(b.projectId, "Projet");
      const idea = cleanIdea(b.idea);
      const chatAt = parseWhen(b.chatAt);
      const project = await deps.settings.getProject(source, projectId);
      if (!project?.devEnabled) throw new PlanInputError("Projet non configuré pour l'agent dev (Paramètres > Projets) : le plan ne pourrait pas être exécuté.");
      if (!chatAt) limiter.take(`${ctx.whoIs(req).userId}:chat`, HOURLY.drafts, "tours de chat");

      const id = await deps.plans.insert({ source, projectId, projectPath: project.path, kind, title: idea.replace(/\s+/g, " ").slice(0, 80), firstMessage: idea, chatAt });
      if (chatAt) return { id, waiting: true };
      const plan = (await deps.plans.get(id))!;
      // L'échange qui suit est enregistré sur le plan : en cas d'erreur, la personne l'y retrouve et peut relancer
      if (!(await deps.plans.acquire(id, ["chatting"]))) return { id, waiting: false };
      const error = await runChatTurn(deps, plan);
      return { id, waiting: false, error };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /**
   * Un message de la personne dans le chat (ou, sans texte, une relance du dernier tour qui a échoué). L'orchestrateur répond par des questions ou
   * propose (ou corrige) la liste de tickets.
   */
  app.post<{ Params: { id: string } }>("/api/plans/:id/messages", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id, req);
      if (!(EDITABLE as readonly string[]).includes(plan.status)) throw new PlanConflictError("Le chat de ce plan n'est plus ouvert.");
      const items = await deps.plans.items(plan.id);
      if (items.some((i) => i.status !== "proposed")) throw new PlanConflictError("Les tickets de ce plan sont déjà créés : le chat ne peut plus les modifier.");
      const messages = await deps.plans.messages(plan.id);
      const raw = body(req).text;
      const text = typeof raw === "string" ? raw.replace(/\r\n/g, "\n").trim() : "";
      if (text) {
        if (text.length > 4000) throw new PlanInputError("Le message est trop long (4000 caractères au plus).");
        if (messages.filter((m) => m.role === "user").length >= MAX_USER_MESSAGES) throw new PlanConflictError(`Ce chat a atteint ${MAX_USER_MESSAGES} messages : valide le plan ou ouvres-en un nouveau.`);
      } else if (messages.at(-1)?.role !== "user") {
        throw new PlanInputError("Écris un message.");
      }
      limiter.take(`${ctx.whoIs(req).userId}:chat`, HOURLY.drafts, "tours de chat");
      if (!(await deps.plans.acquire(plan.id, [...EDITABLE]))) throw new PlanConflictError("Un échange est déjà en cours sur ce plan.");
      try {
        if (text) await deps.plans.addMessage(plan.id, "user", text);
      } catch (err) {
        await deps.plans.release(plan.id, { status: plan.status, error: errorMessage(err) });
        throw err;
      }
      return { ok: true, error: await runChatTurn(deps, plan) };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /**
   * Remplace la liste des tickets proposés par la version relue et corrigée par la personne (ordre, titres, descriptions, date de lancement de chaque
   * ticket). Les étiquettes ne peuvent qu'être retirées : seules celles déjà proposées au plan sont acceptées.
   */
  app.post<{ Params: { id: string } }>("/api/plans/:id/items", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id, req);
      const raw = body(req).items;
      if (!Array.isArray(raw) || raw.length === 0) throw new PlanInputError("Un plan a besoin d'au moins un ticket.");
      if (raw.length > MAX_PLAN_ITEMS) throw new PlanInputError(`Pas plus de ${MAX_PLAN_ITEMS} tickets dans un plan.`);
      const known = new Set((await deps.plans.items(plan.id)).flatMap((i) => JSON.parse(i.labels) as string[]));
      const items = raw.map((entry: unknown) => {
        const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
        const ticket = cleanTicket({ title: e.title, description: e.description, labels: e.labels });
        return { ...ticket, labels: ticket.labels.filter((l) => known.has(l)), runAt: parseWhen(e.runAt) };
      });
      if (!(await deps.plans.acquire(plan.id, [...EDITABLE]))) throw new PlanConflictError("Le plan est en cours d'échange ou n'est plus modifiable.");
      let replaced = false;
      try {
        replaced = await deps.plans.replaceProposed(plan.id, items);
      } finally {
        const current = (await deps.plans.get(plan.id))!;
        await deps.plans.release(plan.id, { status: replaced ? "review" : current.status, error: replaced ? null : current.error });
      }
      if (!replaced) throw new PlanConflictError("Les tickets de ce plan ne peuvent plus être modifiés.");
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /**
   * Valide le plan : la personne a relu la liste, `confirm` doit être vrai. Les tickets sont créés chez la forge, dans l'ordre, puis leur exécution est
   * planifiée (à `runAt`, ou tout de suite). Si la création échoue en route, les tickets déjà créés sont gardés, le plan reste en relecture et la
   * validation peut être relancée : elle reprend où elle s'est arrêtée.
   */
  app.post<{ Params: { id: string } }>("/api/plans/:id/validate", async (req, reply) => {
    try {
      const deps = planDeps();
      const b = body(req);
      if (b.confirm !== true) throw new PlanInputError("Il faut confirmer explicitement la validation du plan.");
      const plan = await planOf(deps.plans, req.params.id, req);
      const runAt = b.runAt === undefined ? plan.run_at : parseWhen(b.runAt);
      if (plan.status !== "review") throw new PlanConflictError("Seul un plan en relecture peut être validé.");
      if (!(await deps.plans.acquire(plan.id, ["review"]))) throw new PlanConflictError("Le plan est en cours d'échange ou de validation.");
      try {
        const items = await deps.plans.items(plan.id);
        if (items.length === 0) throw new PlanInputError("Le plan n'a aucun ticket.");
        const toCreate = items.filter((i) => i.status === "proposed");
        // Le plafond est vérifié pour tous les tickets avant d'en créer un seul
        const who = ctx.whoIs(req).userId;
        for (let i = 0; i < toCreate.length; i++) limiter.take(`${who}:ticket`, HOURLY.tickets, "tickets créés");

        const connector = deps.forges.get(plan.source).connector;
        let created = 0;
        for (const item of toCreate) {
          const current = await deps.plans.get(plan.id);
          if (current?.status !== "review") throw new PlanConflictError("Le plan a été annulé pendant sa validation.");
          try {
            const ticket = await connector.createTicket(plan.project_id, { title: item.title, description: item.description, labels: JSON.parse(item.labels) as string[] }).catch((err: unknown) => {
              throw explainForgeError(plan.source, "ticket", err);
            });
            await deps.plans.updateItem(item.id, { status: "pending", issue_iid: ticket.iid, issue_url: ticket.url, error: null }, ["proposed"]);
            created++;
          } catch (err) {
            const done = items.length - toCreate.length + created;
            throw new PlanConflictError(`Création interrompue après ${done} ticket${done > 1 ? "s" : ""} sur ${items.length} : ${errorMessage(err)} Les tickets déjà créés sont gardés : valide à nouveau pour reprendre.`);
          }
        }
        await deps.plans.update(plan.id, { run_at: runAt });
        const due = !runAt || runAt <= toDbTime(new Date());
        await deps.plans.release(plan.id, { status: due ? "running" : "scheduled", error: null });
        log.info("plan.validated", { planId: plan.id, tickets: items.length, created, runAt });
      } catch (err) {
        await deps.plans.release(plan.id, { status: "review", error: errorMessage(err) });
        throw err;
      }
      // Le premier ticket part sans attendre le prochain passage de l'orchestrateur
      await kick(deps, plan.id);
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /**
   * Planifie : date de lancement du chat (`chatAt`, null pour le lancer tout de suite), date de lancement de l'exécution (`runAt`, null pour dès
   * que le plan est validé) et date propre à un ticket (`items: [{ id, runAt }]`). Un ticket planifié plus tard retient aussi ceux qui le suivent.
   */
  app.post<{ Params: { id: string } }>("/api/plans/:id/schedule", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id, req);
      const b = body(req);
      if (!("chatAt" in b) && !("runAt" in b) && !Array.isArray(b.items)) throw new PlanInputError("Rien à planifier.");
      // Tout est contrôlé avant la première écriture : une date refusée ne laisse pas une planification à moitié faite
      const chatAt = "chatAt" in b ? (parseWhen(b.chatAt) ?? toDbTime(new Date())) : undefined; // sans date, le chat part tout de suite
      const runAt = "runAt" in b ? parseWhen(b.runAt) : undefined;
      if (chatAt !== undefined && plan.status !== "waiting_chat") throw new PlanConflictError("Le chat de ce plan a déjà commencé.");
      if (runAt !== undefined && !["chatting", "review", "scheduled", "paused"].includes(plan.status)) throw new PlanConflictError("La date de lancement ne peut plus changer à ce stade du plan.");
      const known = new Map((await deps.plans.items(plan.id)).map((i) => [i.id, i]));
      const changes = (Array.isArray(b.items) ? b.items : []).map((entry: unknown) => {
        const e = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
        const item = known.get(positiveInt(e.id, "Ticket"));
        if (!item || (item.status !== "proposed" && item.status !== "pending")) throw new PlanConflictError("Seul un ticket qui n'a pas démarré peut être replanifié.");
        return { id: item.id, runAt: parseWhen(e.runAt) };
      });
      if (chatAt !== undefined || runAt !== undefined) await deps.plans.update(plan.id, { ...(chatAt !== undefined ? { chat_at: chatAt } : {}), ...(runAt !== undefined ? { run_at: runAt } : {}) });
      for (const c of changes) await deps.plans.updateItem(c.id, { run_at: c.runAt }, ["proposed", "pending"]);
      // Un chat qui démarre dure le temps d'une réponse de l'agent : on n'attend pas sa fin pour répondre
      if (chatAt !== undefined) void kick(deps, plan.id);
      else await kick(deps, plan.id);
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Réordonne les tickets qui n'ont pas démarré : `order` liste TOUS les tickets en attente, dans le nouvel ordre. */
  app.post<{ Params: { id: string } }>("/api/plans/:id/reorder", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id, req);
      const raw = body(req).order;
      if (!Array.isArray(raw)) throw new PlanInputError("Ordre invalide.");
      if (!["scheduled", "running", "paused", "failed"].includes(plan.status)) throw new PlanConflictError("Le plan n'est pas validé : corrige l'ordre dans la liste des tickets.");
      if (!(await deps.plans.reorderPending(plan.id, raw.map((id) => positiveInt(id, "Ticket"))))) throw new PlanConflictError("L'ordre doit lister tous les tickets en attente, et eux seulement.");
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Met le plan en pause : aucun nouveau ticket n'est lancé ; l'agent en cours va à son terme. */
  app.post<{ Params: { id: string } }>("/api/plans/:id/pause", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id);
      if (!(await deps.plans.transition(plan.id, ["scheduled", "running"], "paused"))) throw new PlanConflictError("Seul un plan planifié ou en cours peut être mis en pause.");
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Reprend un plan en pause (ou arrêté sur un échec, une fois le ticket en échec relancé ou écarté). */
  app.post<{ Params: { id: string } }>("/api/plans/:id/resume", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id, req);
      if (plan.status === "failed" &&(await deps.plans.items(plan.id)).some((i) => i.status === "failed")) {
        throw new PlanConflictError("Relance ou écarte d'abord le ticket en échec.");
      }
      if (!(await deps.plans.transition(plan.id, ["paused", "failed"], "scheduled", { error: null }))) throw new PlanConflictError("Seul un plan en pause ou arrêté sur un échec peut être repris.");
      await kick(deps, plan.id);
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Annule le plan : les tickets qui n'ont pas démarré ne sont pas exécutés et l'agent en cours est arrêté. Les tickets déjà créés chez la forge y restent. */
  app.post<{ Params: { id: string } }>("/api/plans/:id/cancel", async (req, reply) => {
    try {
      const deps = planDeps();
      const plan = await planOf(deps.plans, req.params.id);
      if (!(await cancelPlan(deps, plan.id))) throw new PlanConflictError("Ce plan est déjà terminé ou annulé.");
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Un ticket du plan de l'URL, ou 404. */
  const itemOf = async (plans: PlanRepo, req: FastifyRequest, planId: unknown, itemId: unknown): Promise<{ plan: PlanRow; item: PlanItemRow }> => {
    const plan = await planOf(plans, planId, req);
    const item = (await plans.items(plan.id)).find((i) => i.id === positiveInt(itemId, "Ticket"));
    if (!item) throw new PlanNotFoundError();
    return { plan, item };
  };

  /** Écarte un ticket qui n'a pas démarré (ou qui a échoué) : il ne sera pas lancé, le plan passe au suivant. */
  app.post<{ Params: { id: string; itemId: string } }>("/api/plans/:id/items/:itemId/skip", async (req, reply) => {
    try {
      const deps = planDeps();
      const { plan, item } = await itemOf(deps.plans, req, req.params.id, req.params.itemId);
      if (!(await deps.plans.updateItem(item.id, { status: "skipped", error: null }, ["pending", "failed"]))) throw new PlanConflictError("Seul un ticket en attente ou en échec peut être écarté.");
      await kick(deps, plan.id);
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });

  /** Relance un ticket en échec : il redevient en attente, et un plan arrêté sur cet échec reprend. */
  app.post<{ Params: { id: string; itemId: string } }>("/api/plans/:id/items/:itemId/retry", async (req, reply) => {
    try {
      const deps = planDeps();
      const { plan, item } = await itemOf(deps.plans, req, req.params.id, req.params.itemId);
      if (!(await deps.plans.updateItem(item.id, { status: "pending", error: null, task_id: null }, ["failed"]))) throw new PlanConflictError("Seul un ticket en échec peut être relancé.");
      if (plan.status === "failed" && !(await deps.plans.items(plan.id)).some((i) => i.status === "failed")) await deps.plans.transition(plan.id, ["failed"], "scheduled", { error: null });
      await kick(deps, plan.id);
      return { ok: true };
    } catch (err) {
      return failPlan(reply, err);
    }
  });
}
