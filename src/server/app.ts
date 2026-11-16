import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import Fastify, { type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { DEFAULT_FORGE, FORGE_KINDS } from "../connectors/forges.js";
import type { ForgeKind } from "../connectors/types.js";
import { diagnoseAgentRuntime, type RuntimeDiagnostic } from "../agent/dockerDiagnostic.js";
import { allowedImages, imageFor } from "../agent/imageName.js";
import { attachmentIds, failAttachment, giveAttachments, planAttachments, registerAttachments } from "../attachments/routes.js";
import type { AttachmentOwner } from "../attachments/store.js";
import { registerAuth, type AuthRuntime } from "../auth/routes.js";
import type { AccountContext, AccountRepo } from "../db/accounts.js";
import { currentMonth } from "../db/costs.js";
import type { ReviewStatus } from "../db/reviews.js";
import { cancelDevTask } from "../dev/pipeline.js";
import { renderTemplate, slugify } from "../dev/templates.js";
import { errorMessage, log } from "../logger.js";
import { PROJECT_ROOT } from "../paths.js";
import { readDefaultSystemPrompt } from "../prompts.js";
import { approve, publishComment, type PipelineDeps } from "../review/pipeline.js";
import type { Finding, ReviewResult } from "../review/schema.js";
import { SecretError } from "../secrets/crypto.js";
import { SecretConflictError, deleteManagedSecret, describeSecrets, managedName, saveManagedSecret } from "../secrets/vault.js";
import { ALLOWED_EFFORTS, ALLOWED_MODELS, DEFAULT_SETTINGS, type Settings } from "../settings/schema.js";
import type { TenantContext, TenantDeps } from "../tenants/manager.js";
import { computeArmory } from "../game/armory.js";
import { LOOT_CATALOG, computeDrops } from "../game/loot.js";
import { computeHero, REVIEW_DONE, TASK_FORGED } from "../game/hero.js";
import { computePrestige, computeProgress } from "../game/progress.js";
import { MAX_WORKERS, pickWorkers } from "../game/workers.js";
import { registerPiece, summarizePieces } from "../dev/pieceRoutes.js";
import { registerRooms } from "../rooms/routes.js";
import { registerScribe } from "../scribe/routes.js";
import { registerTerminal, type TerminalFeature } from "../terminal/routes.js";
import type { AgentRunner } from "../agent/runner.js";

/** Ce que le serveur reçoit : les dépôts et connexions de l'utilisateur local (servis sans connexion), et de quoi servir les autres personnes. */
export interface ServerDeps extends TenantDeps {
  /** Comptes, pour dire qui est connecté. */
  accounts: AccountRepo;
  /** Utilisateur, espace et rôle servis sans connexion. */
  local: AccountContext;
  /** Connexion par compte de forge. Absente : pas de connexion, l'outil sert l'utilisateur local. */
  auth?: AuthRuntime;
  /**
   * Retrouve les dépôts, connexions aux forges et files ACTUELS d'une personne : celle d'une session, ou l'utilisateur local quand il n'y a pas
   * de connexion. Appelée à chaque requête, donc elle suit les reconstructions. Absente : toute session d'un autre espace que l'espace local
   * est refusée, et les dépôts reçus ci-dessus (ceux de l'utilisateur local) servent tels quels.
   */
  tenants?: (who: TenantContext) => Promise<TenantDeps>;
  /** Terminal Claude du navigateur (connexion de l'abonnement) et état de la connexion. Absent : routes non montées. */
  terminal?: TerminalFeature;
  /** Exécuteur d'agent imposé au Scribe (tests). Absent : celui des réglages de la personne. */
  scribeRunner?: AgentRunner;
}

/**
 * Propriétés de `ServerDeps` communes à toutes les personnes. Toutes les autres sont celles de la personne servie : une propriété ajoutée
 * plus tard est donc propre à la personne par défaut, jamais partagée par oubli.
 */
const SHARED_KEYS = new Set<string | symbol>(["accounts", "local", "auth", "tenants", "terminal", "scribeRunner"]);

type IdParams = { Params: { id: string } };

/** Colonne de l'onglet Tickets d'après les labels du workflow réglés dans le dashboard. */
export function classifyIssue(labels: string[], workflow: Settings["workflow"]): "techValidation" | "inProgress" | "todo" | "other" {
  const has = (list: string[]) => list.some((l) => labels.includes(l));
  if (has(workflow.techValidationLabels)) return "techValidation";
  if (has(workflow.inProgressLabels)) return "inProgress";
  if (has(workflow.todoLabels)) return "todo";
  return "other";
}

/** Requête invalide (paramètre inconnu) : répondue en 400. */
class BadRequestError extends Error {}

function fail(reply: FastifyReply, err: unknown, code = 502) {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".") || "valeur"} : ${i.message}`).join(" · ") });
  }
  if (err instanceof BadRequestError || err instanceof SecretError) return reply.code(400).send({ error: err.message });
  if (err instanceof SecretConflictError) return reply.code(409).send({ error: err.message });
  return reply.code(code).send({ error: errorMessage(err) });
}

/** Forge demandée par le dashboard (GitLab si le paramètre est absent, comme avant l'arrivée de GitHub). */
function forgeOf(value: unknown): ForgeKind {
  if (value === undefined || value === null || value === "") return DEFAULT_FORGE;
  const kind = FORGE_KINDS.find((k) => k === value);
  if (!kind) throw new BadRequestError(`Forge inconnue : ${String(value)}`);
  return kind;
}

/**
 * API + dashboard local. N'écoute que sur 127.0.0.1 (accessible depuis le navigateur Windows
 * grâce au forwarding localhost de WSL2), jamais exposé sur le réseau.
 */
export function buildServer(base: ServerDeps) {
  const app = Fastify({ logger: false });

  // Chaque requête d'une personne connectée est servie avec SES dépôts, SES connexions aux forges et SES files : `deps` redirige les propriétés
  // qui dépendent de la personne vers celles de la requête en cours (contexte asynchrone), le reste vient de `base`.
  const requestDeps = new AsyncLocalStorage<TenantDeps>();
  const deps = new Proxy(base, {
    get(target, prop) {
      const scoped = requestDeps.getStore();
      return Reflect.get(scoped && !SHARED_KEYS.has(prop) ? scoped : target, prop);
    },
  });

  app.register(fastifyStatic, { root: path.join(PROJECT_ROOT, "public") });

  // Anti-CSRF : un site web ouvert dans ton navigateur pourrait sinon envoyer un POST vers
  // localhost:4321 et approuver une MR ou lancer l'agent à ta place. Un header custom impose
  // un preflight CORS que ce serveur ne valide jamais : seul le dashboard (même origine) peut agir.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-review-agent"] !== "1") {
      return reply.code(403).send({ error: "Header x-review-agent manquant" });
    }
  });

  // Connexion (si configurée) : sans session valide, tout est refusé sauf la page de connexion et l'aller-retour OAuth
  if (deps.auth) registerAuth(app, deps.auth);

  if (base.tenants) {
    // Les routes /api sont servies avec les dépôts et connexions ACTUELS de la personne (ceux de sa session, ou ceux de l'utilisateur local
    // sans connexion) : une reconstruction, par exemple après l'enregistrement d'un jeton dans le dashboard, est suivie sans redémarrer
    const resolve = base.tenants;
    app.addHook("onRequest", (req, reply, done) => {
      const who = req.session ?? (deps.auth ? null : deps.local);
      if (!who || !req.url.startsWith("/api/")) return done();
      resolve(who).then(
        (tenant) => requestDeps.run(tenant, done),
        (err: unknown) => void reply.code(500).send({ error: errorMessage(err) }),
      );
    });
  } else if (deps.auth) {
    // Les dépôts reçus sont liés à l'espace local : une session d'un autre espace ne doit jamais être servie par eux
    app.addHook("onRequest", async (req, reply) => {
      if (req.session && req.session.workspaceId !== deps.local.workspaceId && req.url.startsWith("/api/")) {
        return reply.code(403).send({ error: "Cet espace n'est pas servi par cette installation" });
      }
    });
  }

  // --- Général ---------------------------------------------------------------

  /** Qui est connecté : l'utilisateur, son espace actif et son rôle (sans connexion, l'utilisateur local). */
  app.get("/api/me", async (req) => {
    const context = req.session ?? deps.local;
    const [user, workspace] = await Promise.all([deps.accounts.getUser(context.userId), deps.accounts.getWorkspace(context.workspaceId)]);
    return {
      mode: deps.auth ? "login" : "local",
      user: user ? { id: user.id, name: user.name } : null,
      workspace: workspace ? { id: workspace.id, name: workspace.name, kind: workspace.kind } : null,
      role: context.role,
    };
  });

  app.get("/api/stats", async () => {
    const settings = await deps.settings.get();
    const primary = deps.forges.has(DEFAULT_FORGE) ? deps.forges.get(DEFAULT_FORGE) : deps.forges.all()[0]; // aucune forge tant que la personne n'a pas enregistré de jeton
    return {
      actionMode: settings.actionMode,
      model: settings.review.model,
      devModel: settings.dev.model,
      username: primary?.username ?? "",
      gitlabUrl: deps.config.gitlab?.url ?? "",
      /** Forges configurées sur cette machine (jamais leurs jetons). */
      forges: deps.forges.all().map((f) => ({ kind: f.connector.kind, username: f.username })),
      agentAuth: settings.agentAuth,
      /** Présence seulement : la clé n'est jamais renvoyée. */
      apiKeyConfigured: deps.config.anthropicApiKey !== null,
      counts: await deps.reviews.countByStatus(),
      queueSize: deps.queueSize(),
      agreement: await deps.reviews.agreementStats(),
    };
  });

  /** Consommation du mois : sur l'abonnement un équivalent API, en mode clé API le montant facturé. */
  /** Journal des écritures de la personne sur les forges, les plus récentes d'abord. */
  app.get<{ Querystring: { limit?: string; before?: string } }>("/api/audit", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const before = Number(req.query.before) || undefined;
    return (await deps.audit.list(limit, before)).map(({ workspace_id: _w, user_id: _u, ...entry }) => ({ ...entry, detail: entry.detail ? JSON.parse(entry.detail) : null }));
  });

  app.get("/api/costs", async () => {
    const settings = await deps.settings.get();
    const month = currentMonth();
    const lines = await deps.costs.breakdown(month);
    return {
      month,
      agentAuth: settings.agentAuth,
      budgetUsd: settings.budget.monthlyUsd,
      totalUsd: lines.reduce((sum, l) => sum + l.usd, 0),
      lines,
    };
  });

  // --- Agents dans des conteneurs ---------------------------------------------

  /**
   * Image d'agent demandée par le dashboard, vérifiée contre les images autorisées du .env.
   * @param requested Image demandée (vide ou absente : image par défaut).
   * @returns Le nom de l'image à utiliser.
   * @throws BadRequestError Si l'image n'est pas autorisée (répondu en 400).
   */
  const checkedImage = (requested: unknown): string => {
    try {
      return imageFor(deps.config.agentRuntime, typeof requested === "string" ? requested : "");
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  };

  /** Où tournent les agents (sur la machine ou en conteneur), avec quels plafonds et quelles images. Aucun secret. */
  app.get("/api/agent-runtime", async () => {
    const r = deps.config.agentRuntime;
    return { mode: r.mode, image: r.image, images: allowedImages(r), memory: r.memory, cpus: r.cpus, pids: r.pids, network: r.network, containerUser: r.containerUser };
  });

  /** Diagnostics en cours, par dossier de données et image : un clic répété pendant l'essai partage le même diagnostic au lieu de lancer d'autres conteneurs. */
  const runtimeChecks = new Map<string, Promise<RuntimeDiagnostic>>();

  /** Vérifie que les agents tournent en conteneur sur cette machine : lance un conteneur d'essai avec les options d'une vraie tâche, pour l'image demandée (défaut : l'image par défaut). */
  app.post<{ Body: { image?: unknown } | null }>("/api/agent-runtime/check", async (req, reply) => {
    try {
      const image = checkedImage(req.body?.image);
      const settings = await deps.settings.get();
      const key = `${deps.config.dataDir}|${image}`;
      let running = runtimeChecks.get(key);
      if (!running) {
        running = diagnoseAgentRuntime({ ...deps.config.agentRuntime, image }, {
          dataDir: deps.config.dataDir,
          agentAuth: settings.agentAuth,
          apiKeyConfigured: deps.config.anthropicApiKey !== null,
        }).finally(() => runtimeChecks.delete(key));
        runtimeChecks.set(key, running);
      }
      return await running;
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Secrets : jamais renvoyés, seulement leur présence et leur origine -------

  /**
   * Après un changement de jeton de forge, reconstruit les connexions de la personne si l'exécution le permet.
   * @param result Résultat de l'enregistrement ou de la suppression du secret.
   * @returns Le même résultat, avec `restartRequired` à faux si les connexions ont été reconstruites.
   */
  const rebuildForges = async <T extends { restartRequired: boolean }>(result: T): Promise<T> => {
    if (!result.restartRequired || !deps.reload) return result;
    await deps.reload();
    return { ...result, restartRequired: false };
  };

  app.get("/api/secrets", async () => ({ secrets: await describeSecrets(deps.vault) }));

  app.post<{ Params: { name: string }; Body: unknown }>("/api/secrets/:name", async (req, reply) => {
    try {
      const name = managedName(req.params.name);
      const value = (req.body as { value?: unknown } | null)?.value;
      if (typeof value !== "string") throw new BadRequestError("Valeur manquante");
      return await rebuildForges(await saveManagedSecret(deps.config, deps.vault, name, value));
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.post<{ Params: { name: string } }>("/api/secrets/:name/delete", async (req, reply) => {
    try {
      return await rebuildForges(await deleteManagedSecret(deps.config, deps.vault, managedName(req.params.name)));
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  // --- Terminal Claude et forge (jeu) -----------------------------------------

  if (base.terminal) {
    registerTerminal(app, { feature: base.terminal, authEnabled: Boolean(base.auth), whoIs: (req) => req.session ?? base.local, ownerUserId: base.local.userId, fail });
  }

  /** La forge : héros, quêtes et hauts faits déduits de l'état réel de l'outil. */
  app.get<{ Querystring: { tz?: string } }>("/api/hero", async (req) => {
    const who = req.session ?? base.local;
    const [projects, reviews, tasks, recentReviews] = await Promise.all([deps.settings.listProjects(), deps.reviews.countByStatus(), deps.tasks.list(500), deps.reviews.list(undefined, 500)]);
    const taskCounts: Record<string, number> = {};
    for (const task of tasks) taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
    // La connexion Claude est celle de la machine : elle ne compte que pour son propriétaire. Une CLI lente ne bloque pas la page (4 s au plus).
    let claudeConnected = false;
    if (base.terminal && who.userId === base.local.userId) {
      const slow = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000).unref());
      claudeConnected = (await Promise.race([base.terminal.status.get(), slow]))?.connected ?? false;
    }
    // Atelier animé : les agents actifs (ou terminés depuis peu) et ce qu'ils disent, d'après leur dernière étape connue
    const activeTasks = tasks.filter((t) => t.status === "running").slice(0, MAX_WORKERS);
    const steps: Record<number, string> = {};
    for (const task of activeTasks) {
      const events = await deps.tasks.events(task.id, 0);
      const last = [...events].reverse().find((e) => e.kind === "step") ?? [...events].reverse().find((e) => e.kind === "tool");
      if (last) steps[task.id] = last.text;
    }
    const activeReviews = [...(await deps.reviews.list("running", MAX_WORKERS)), ...(await deps.reviews.list("queued", MAX_WORKERS))];
    const workers = pickWorkers({ tasks, reviews: activeReviews, steps, now: Date.now() });
    const forgeKinds = deps.forges.all().map((f) => f.connector.kind);
    // Progression qui donne envie de revenir : série, missions, maîtrises (le fuseau vient du navigateur, à défaut celui du serveur)
    const tz = Number(req.query.tz);
    const armory = computeArmory({ projects, tasks, reviews: recentReviews });
    const progress = computeProgress({
      now: Date.now(),
      tzOffsetMin: req.query.tz !== undefined && Number.isFinite(tz) && Math.abs(tz) <= 840 ? Math.round(tz) : new Date().getTimezoneOffset(),
      tasks,
      reviews: recentReviews,
      totals: { forged: TASK_FORGED.reduce((n, s) => n + (taskCounts[s] ?? 0), 0), reviews: REVIEW_DONE.reduce((n, s) => n + (reviews[s] ?? 0), 0) },
      pieceGrades: armory.loot.map((i) => i.grade),
      weaponLevels: armory.weapons.map((w) => w.level),
    });
    const hero = computeHero({
      forges: forgeKinds,
      claudeConnected,
      projects: projects.length,
      devProjects: projects.filter((p) => p.devEnabled).length,
      reviews,
      tasks: taskCounts,
      bonusXp: progress.bonusXp,
    });
    return { forges: forgeKinds, ...hero, progress, prestige: computePrestige(hero.level, hero.xp), workers };
  });

  /** L'armurerie : un projet = une arme (niveau et qualité d'après le travail réel), une demande de fusion ouverte = une pièce à vendre. */
  app.get("/api/forge/armory", async () => {
    const [projects, tasks, reviews] = await Promise.all([deps.settings.listProjects(), deps.tasks.list(500), deps.reviews.list(undefined, 500)]);
    return computeArmory({ projects, tasks, reviews });
  });

  /** Le butin : le catalogue d'objets et ceux que l'activité réelle (pièces forgées, reviews, fusions) a fait tomber, de façon déterministe. */
  app.get("/api/forge/loot", async () => {
    const [tasks, reviews, mergedTaskIds] = await Promise.all([deps.tasks.list(500), deps.reviews.list(undefined, 500), deps.tasks.listMergedTaskIds()]);
    return { catalog: LOOT_CATALOG, drops: computeDrops({ tasks, reviews, mergedTaskIds }) };
  });

  // --- Paramètres ------------------------------------------------------------

  app.get("/api/settings", async () => ({
    settings: await deps.settings.get(),
    defaults: DEFAULT_SETTINGS,
    options: { models: ALLOWED_MODELS, efforts: ALLOWED_EFFORTS },
    /** Prompts de base livrés avec l'outil, pour "repartir du prompt par défaut" dans le dashboard. */
    defaultSystemPrompts: { review: await readDefaultSystemPrompt("review"), dev: await readDefaultSystemPrompt("dev") },
  }));

  app.post<{ Body: unknown }>("/api/settings", async (req, reply) => {
    try {
      return { settings: await deps.settings.save(req.body) };
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.get("/api/projects", async () => await deps.settings.listProjects());

  app.post<{ Body: unknown }>("/api/projects", async (req, reply) => {
    try {
      checkedImage((req.body as { agentImage?: unknown } | null)?.agentImage);
      return await deps.settings.saveProject(req.body);
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.post<IdParams & { Querystring: { source?: string } }>("/api/projects/:id/delete", async (req, reply) => {
    try {
      await deps.settings.deleteProject(forgeOf(req.query.source), Number(req.params.id));
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Projets de la forge (GitLab par défaut, `?source=github` pour GitHub). Le chemin garde « gitlab » pour le dashboard existant. */
  app.get<{ Querystring: { search?: string; source?: string } }>("/api/gitlab/projects", async (req, reply) => {
    try {
      const projects = await deps.forges.get(forgeOf(req.query.source)).connector.searchProjects(req.query.search ?? "");
      return projects.map((p) => ({ id: p.id, path: p.path, name: p.name, url: p.url }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<IdParams & { Querystring: { search?: string; source?: string } }>("/api/gitlab/projects/:id/branches", async (req, reply) => {
    try {
      const branches = await deps.forges.get(forgeOf(req.query.source)).connector.listBranches(Number(req.params.id), req.query.search ?? "");
      return branches.map((b) => ({ name: b.name, default: b.isDefault, protected: b.isProtected }));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Tickets ---------------------------------------------------------------

  app.get("/api/issues", async (_req, reply) => {
    try {
      const settings = await deps.settings.get();
      const projects = new Map((await deps.settings.listProjects()).map((p) => [`${p.source}#${p.projectId}`, p]));
      const latest = await deps.tasks.latestByIssue();

      // Une forge en panne n'empêche pas d'afficher les tickets des autres
      const results = await Promise.allSettled(deps.forges.all().map(async (f) => ({ source: f.connector.kind, tickets: await f.connector.listAssignedTickets() })));
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (results.length > 0 && failed.length === results.length) throw failed[0]!.reason;
      for (const r of failed) log.warn("issues.forge_error", { error: errorMessage(r.reason) });
      const issues = results.flatMap((r) => (r.status === "fulfilled" ? r.value.tickets.map((ticket) => ({ source: r.value.source, ticket })) : []));

      const pieces = await summarizePieces(deps, issues.flatMap(({ source, ticket }) => latest.get(`${source}#${ticket.projectId}#${ticket.iid}`) ?? []));
      return issues.map(({ source, ticket: i }) => {
        const project = projects.get(`${source}#${i.projectId}`);
        const task = latest.get(`${source}#${i.projectId}#${i.iid}`);
        return {
          source,
          projectId: i.projectId,
          projectPath: i.projectPath ?? String(i.projectId),
          iid: i.iid,
          title: i.title,
          labels: i.labels,
          url: i.url,
          updatedAt: i.updatedAt,
          milestone: i.milestone,
          column: classifyIssue(i.labels, settings.workflow),
          devReady: Boolean(project?.devEnabled),
          branchPreview: project?.devEnabled ? renderTemplate(settings.templates.branch, { iid: i.iid, title: i.title, slug: slugify(i.title) }) : null,
          baseBranch: project?.baseBranch ?? null,
          targetBranch: project?.targetBranch ?? null,
          task: task ? { id: task.id, status: task.status, mrUrl: task.mr_url, mrIid: task.mr_iid, error: task.error ? task.error.slice(0, 300) : null, piece: pieces.get(task.id) ?? null } : null,
        };
      });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Salles du monde de la forge (données validées, lecture seule) -------------------------------
  registerRooms(app);

  // --- Scribe : tickets d'un projet, brouillons, création de tickets et de projets ------------------
  registerScribe(app, { deps, whoIs: (req) => req.session ?? base.local, fail, forgeOf, classify: classifyIssue, runner: base.scribeRunner });

  // --- Agent dev -------------------------------------------------------------

  app.get("/api/tasks", async () => (await deps.tasks.list()).map(({ result_json: _r, ...t }) => t));

  app.get<IdParams>("/api/tasks/:id", async (req, reply) => {
    const task = await deps.tasks.get(Number(req.params.id));
    if (!task) return reply.code(404).send({ error: "Tâche introuvable" });
    return { ...task, result: task.result_json ? JSON.parse(task.result_json) : null };
  });

  app.get<IdParams & { Querystring: { after?: string } }>("/api/tasks/:id/events", async (req) => {
    return await deps.tasks.events(Number(req.params.id), Number(req.query.after ?? 0));
  });

  app.post<{ Body: { source?: string; projectId: number; issueIid: number; extraInstructions?: string; attachments?: string[]; retryOf?: number } }>("/api/tasks", async (req, reply) => {
    try {
      const { projectId, issueIid } = req.body;
      const source = forgeOf(req.body.source);
      const project = await deps.settings.getProject(source, Number(projectId));
      if (!project?.devEnabled) return reply.code(400).send({ error: "Projet non configuré pour l'agent dev (Paramètres > Projets)" });
      if (await deps.tasks.findActive(source, Number(projectId), Number(issueIid))) {
        return reply.code(409).send({ error: "Un agent travaille déjà sur ce ticket" });
      }
      const issue = await deps.forges.get(source).connector.getTicket(Number(projectId), Number(issueIid));
      if (!issue) return reply.code(404).send({ error: "Ticket introuvable" });

      // Pièces jointes (captures, maquettes, données) : celles envoyées maintenant, plus celles du ticket (créées avec le Scribe) ou, pour une
      // relance, celles de l'essai précédent. Tout est vérifié avant de créer la tâche : un refus ne crée rien.
      const ids = attachmentIds(req.body.attachments);
      const retryOf = typeof req.body.retryOf === "number" && Number.isInteger(req.body.retryOf) && req.body.retryOf > 0 ? req.body.retryOf : null;
      const copyFrom: AttachmentOwner[] = retryOf ? [{ task: retryOf }] : [{ ticket: { source, projectId: project.projectId, iid: issue.iid } }];
      await planAttachments(deps, copyFrom, ids);

      const id = await deps.tasks.insert({
        source,
        projectId: project.projectId,
        projectPath: project.path,
        issueIid: issue.iid,
        issueTitle: issue.title,
        issueUrl: issue.url,
        extraInstructions: req.body.extraInstructions?.trim() || null,
      });
      const files = await giveAttachments(deps, id, { copyFrom, ids });
      await deps.tasks.addEvent(id, "step", "Tâche créée, en attente de l'agent");
      if (files.length > 0) await deps.tasks.addEvent(id, "step", `Pièces jointes : ${files.join(", ")}`);
      deps.enqueueDev(id);
      return { id };
    } catch (err) {
      return failAttachment(reply, err, fail);
    }
  });

  /** Reprise : relance l'agent sur la branche de la MR créée par cette tâche, avec des consignes. */
  app.post<IdParams & { Body: { instructions?: string; attachments?: string[] } }>("/api/tasks/:id/followup", async (req, reply) => {
    try {
      const origin = await deps.tasks.get(Number(req.params.id));
      if (!origin) return reply.code(404).send({ error: "Tâche introuvable" });
      const instructions = req.body?.instructions?.trim();
      if (!instructions) return reply.code(400).send({ error: "Les consignes de reprise sont obligatoires" });
      if (!origin.branch || !origin.mr_iid || !origin.mr_url || origin.status === "running" || origin.status === "queued") {
        return reply.code(400).send({ error: "Seule une tâche terminée liée à une MR peut être reprise" });
      }
      const project = await deps.settings.getProject(origin.source, origin.project_id);
      if (!project?.devEnabled) return reply.code(400).send({ error: "Projet non configuré pour l'agent dev (Paramètres > Projets)" });
      if (await deps.tasks.findActive(origin.source, origin.project_id, origin.issue_iid)) {
        return reply.code(409).send({ error: "Un agent travaille déjà sur ce ticket" });
      }

      // La reprise garde les pièces jointes de la tâche reprise (captures, maquettes) et peut en recevoir de nouvelles
      const ids = attachmentIds(req.body?.attachments);
      const copyFrom: AttachmentOwner[] = [{ task: origin.id }];
      await planAttachments(deps, copyFrom, ids);

      const id = await deps.tasks.insert({
        source: origin.source,
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
      const files = await giveAttachments(deps, id, { copyFrom, ids });
      await deps.tasks.addEvent(id, "step", `Reprise de la MR !${origin.mr_iid} (tâche #${origin.id}), en attente de l'agent`);
      if (files.length > 0) await deps.tasks.addEvent(id, "step", `Pièces jointes : ${files.join(", ")}`);
      deps.enqueueDev(id);
      return { id };
    } catch (err) {
      return failAttachment(reply, err, fail);
    }
  });

  app.post<IdParams>("/api/tasks/:id/cancel", async (req) => {
    const id = Number(req.params.id);
    const task = await deps.tasks.get(id);
    if (!cancelDevTask(id) && task?.status === "queued") {
      await deps.tasks.update(id, { status: "cancelled" });
      await deps.tasks.addEvent(id, "step", "Tâche annulée avant démarrage");
    }
    return { ok: true };
  });

  /** Supprime le dossier de travail local d'une tâche terminée (la branche poussée n'est pas touchée). */
  app.post<IdParams>("/api/tasks/:id/cleanup", async (req, reply) => {
    try {
      const task = await deps.tasks.get(Number(req.params.id));
      if (!task?.worktree_path) return { ok: true };
      if (task.status === "running" || task.status === "queued") return reply.code(409).send({ error: "Tâche en cours" });
      const { connector, workspace } = deps.forges.get(task.source);
      const project = await connector.getProject(task.project_id);
      await workspace.removeDevWorktree(task.project_id, project.cloneUrl, task.worktree_path);
      await deps.tasks.update(task.id, { worktree_path: null });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /**
   * Supprime une tâche terminée (échec, annulation, question, MR créée) avec son journal et son dossier de travail local. Rien n'est touché
   * chez la forge : la branche ou la MR éventuelles restent. Une tâche en attente ou en cours doit d'abord être arrêtée.
   */
  app.post<IdParams>("/api/tasks/:id/delete", async (req, reply) => {
    try {
      const id = Number(req.params.id);
      const task = await deps.tasks.get(id);
      if (!task) return reply.code(404).send({ error: "Tâche introuvable" });
      if (task.status === "running" || task.status === "queued") return reply.code(409).send({ error: "L'agent travaille encore sur cette tâche : arrête-le d'abord" });
      // Le dossier de travail est partagé par toutes les tâches d'une même branche : on ne le supprime que si aucune autre tâche en cours ne s'en sert
      if (task.worktree_path) {
        const shared = (await deps.tasks.list(500)).some((t) => t.id !== id && t.worktree_path === task.worktree_path && (t.status === "running" || t.status === "queued"));
        if (!shared) {
          try {
            const { connector, workspace } = deps.forges.get(task.source);
            const project = await connector.getProject(task.project_id);
            await workspace.removeDevWorktree(task.project_id, project.cloneUrl, task.worktree_path);
          } catch (err) {
            // Un dossier déjà disparu ou une forge injoignable n'empêche pas de supprimer la tâche
            log.warn("task.delete_worktree_failed", { taskId: id, error: errorMessage(err) });
          }
        }
      }
      const outcome = await deps.tasks.delete(id);
      if (outcome === "active") return reply.code(409).send({ error: "L'agent travaille encore sur cette tâche : arrête-le d'abord" });
      await deps.attachments?.remove({ task: id }).catch((err: unknown) => log.warn("task.delete_attachments_failed", { taskId: id, error: errorMessage(err) }));
      log.info("task.deleted", { taskId: id, status: task.status });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // --- Pièces jointes (captures, maquettes, données) envoyées à l'agent dev --------------------------
  registerAttachments(app, { deps, fail });

  // --- La pièce : relecture par le Gardien, puis fusion --------------------------------------------
  registerPiece(app, { deps, fail });

  // --- Reviews ---------------------------------------------------------------

  /** Liste allégée : le résultat complet est remplacé par un décompte des points par sévérité. */
  app.get<{ Querystring: { status?: ReviewStatus } }>("/api/reviews", async (req) => {
    return (await deps.reviews.list(req.query.status)).map(({ result_json, ...row }) => {
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
    const row = await deps.reviews.get(Number(req.params.id));
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
      const row = await deps.reviews.get(id);
      if (row?.status !== "published") await publishComment(id, deps, false);
      await approve(id, deps, false);
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<IdParams>("/api/reviews/:id/dismiss", async (req) => {
    const id = Number(req.params.id);
    await deps.reviews.setStatus(id, "dismissed");
    await deps.reviews.logAction(id, "dismiss", false);
    return { ok: true };
  });

  /** Lance une review détectée mais pas encore analysée (déclenchement manuel). */
  app.post<IdParams>("/api/reviews/:id/start", async (req, reply) => {
    const id = Number(req.params.id);
    const row = await deps.reviews.get(id);
    if (!row) return reply.code(404).send({ error: "Review introuvable" });
    if (row.status !== "detected") return reply.code(409).send({ error: "Cette review n'est pas en attente de lancement" });
    await deps.reviews.setStatus(id, "queued");
    await deps.reviews.logAction(id, "start", false);
    deps.enqueueReview(id);
    return { ok: true };
  });

  app.post<IdParams>("/api/reviews/:id/retry", async (req) => {
    const id = Number(req.params.id);
    await deps.reviews.setStatus(id, "queued");
    await deps.reviews.logAction(id, "retry", false);
    deps.enqueueReview(id);
    return { ok: true };
  });

  /** Mode ombre : tu notes si tu es d'accord avec la décision de l'agent. */
  app.post<IdParams & { Body: { agree: boolean; note?: string } }>("/api/reviews/:id/feedback", async (req) => {
    await deps.reviews.saveFeedback(Number(req.params.id), Boolean(req.body.agree), req.body.note?.trim() || null);
    return { ok: true };
  });

  return app;
}
