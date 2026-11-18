import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FORGE_KINDS } from "../connectors/forges.js";
import { registerRooms } from "../rooms/routes.js";
import type { TenantDeps } from "../tenants/manager.js";
import type { TerminalFeature } from "../terminal/routes.js";
import { WEAPON_TYPE_IDS, computeArmory } from "./armory.js";
import { computeHero, REVIEW_DONE, TASK_FORGED } from "./hero.js";
import { LOOT_CATALOG, computeDrops } from "./loot.js";
import { WeaponLockedError, chooseWeaponType, readGamePrefs, setGameEnabled, withWeaponTypes } from "./prefs.js";
import { computePrestige, computeProgress } from "./progress.js";
import { MAX_WORKERS, pickWorkers } from "./workers.js";

/**
 * Routes du jeu (la forge) : tout ce que le serveur sert au monde 2D, en un seul endroit. Le jeu est une couche en lecture sur l'activité réelle de
 * l'outil : il n'écrit rien chez une forge. Il peut être éteint (drapeau `enabled`, voir `prefs.ts`) : ses routes répondent alors 404, et seul le
 * drapeau lui-même reste joignable pour le rallumer.
 */
export interface GameContext {
  /** Dépôts et connexions de la personne servie (résolus à chaque requête). */
  deps: Pick<TenantDeps, "settings" | "reviews" | "tasks" | "forges" | "audit">;
  /** Qui fait la requête (sa session, ou l'utilisateur local sans connexion). */
  whoIs: (req: FastifyRequest) => { workspaceId: number; userId: number };
  /** Utilisateur propriétaire de l'installation : seul à compter la connexion Claude de la machine. */
  ownerUserId: number;
  /** Terminal Claude et état de la connexion (absent : la quête « connecter Claude » ne se valide pas). */
  terminal?: TerminalFeature;
  /** Convertit une erreur en réponse. */
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
}

/**
 * Monte les routes du jeu.
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 * @returns Rien.
 */
export function registerGame(app: FastifyInstance, ctx: GameContext): void {
  const { deps, fail } = ctx;

  /** Le drapeau du jeu : lisible et modifiable même quand le jeu est éteint (c'est ainsi qu'on le rallume). */
  app.get("/api/game", async () => ({ enabled: (await readGamePrefs(deps.settings)).enabled }));

  app.post<{ Body: { enabled?: unknown } | null }>("/api/game", async (req, reply) => {
    if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "« enabled » doit être vrai ou faux" });
    return { enabled: (await setGameEnabled(deps.settings, req.body.enabled)).enabled };
  });

  // Tout le reste vit dans un plugin isolé : son garde ne touche aucune autre route de l'outil
  void app.register(async (game) => {
    game.addHook("onRequest", async (_req, reply) => {
      if (!(await readGamePrefs(deps.settings)).enabled) return reply.code(404).send({ error: "La forge (jeu) est éteinte : rallume-la dans Paramètres." });
    });

    /** La forge : héros, quêtes et hauts faits déduits de l'état réel de l'outil. */
    game.get<{ Querystring: { tz?: string } }>("/api/hero", async (req) => {
      const who = ctx.whoIs(req);
      const [projects, reviews, tasks, recentReviews] = await Promise.all([deps.settings.listProjects(), deps.reviews.countByStatus(), deps.tasks.list(500), deps.reviews.list(undefined, 500)]);
      const taskCounts: Record<string, number> = {};
      for (const task of tasks) taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
      // La connexion Claude est celle de la machine : elle ne compte que pour son propriétaire. Une CLI lente ne bloque pas la page (4 s au plus).
      let claudeConnected = false;
      if (ctx.terminal && who.userId === ctx.ownerUserId) {
        const slow = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000).unref());
        claudeConnected = (await Promise.race([ctx.terminal.status.get(), slow]))?.connected ?? false;
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

    /**
     * L'armurerie : un projet = une arme (niveau et qualité d'après le travail réel), une demande de fusion ouverte = une pièce à vendre.
     * `chosen` liste les projets dont le type d'arme a été choisi (les autres ont un type par défaut, encore modifiable une fois).
     */
    game.get("/api/forge/armory", async () => {
      const [projects, tasks, reviews, prefs] = await Promise.all([deps.settings.listProjects(), deps.tasks.list(500), deps.reviews.list(undefined, 500), readGamePrefs(deps.settings)]);
      return { ...computeArmory({ projects: withWeaponTypes(projects, prefs), tasks, reviews }), chosen: Object.keys(prefs.weaponTypes) };
    });

    /** Choisit, une seule fois, le type d'arme d'un projet configuré. */
    game.post<{ Body: { source?: unknown; projectId?: unknown; weaponType?: unknown } | null }>("/api/forge/weapon-type", async (req, reply) => {
      const source = FORGE_KINDS.find((k) => k === req.body?.source);
      const projectId = req.body?.projectId;
      const type = WEAPON_TYPE_IDS.find((t) => t === req.body?.weaponType);
      if (!source || typeof projectId !== "number" || !Number.isInteger(projectId) || !type) return reply.code(400).send({ error: "Forge, projet et type d'arme valides obligatoires" });
      try {
        if (!(await deps.settings.getProject(source, projectId))) return reply.code(404).send({ error: "Ce projet n'est pas configuré dans l'outil" });
        await chooseWeaponType(deps.settings, source, projectId, type);
        return { weaponType: type };
      } catch (err) {
        if (err instanceof WeaponLockedError) return reply.code(409).send({ error: err.message });
        return fail(reply, err);
      }
    });

    /** Le butin : le catalogue d'objets et ceux que l'activité réelle (pièces forgées, reviews, fusions) a fait tomber, de façon déterministe. */
    game.get("/api/forge/loot", async () => {
      const [tasks, reviews, mergedTaskIds, journal, projects, prefs] = await Promise.all([deps.tasks.list(500), deps.reviews.list(undefined, 500), deps.tasks.listMergedTaskIds(), deps.audit.list(500), deps.settings.listProjects(), readGamePrefs(deps.settings)]);
      const created = journal.filter((entry) => entry.action === "project_create" && entry.outcome === "ok").map((entry) => ({ id: entry.id, created_at: entry.created_at, source: entry.source, path: entry.target }));
      // Une arme qui tombe est toujours du type d'arme du projet concerné
      return { catalog: LOOT_CATALOG, drops: computeDrops({ tasks, reviews, mergedTaskIds, projects: created, weaponProjects: withWeaponTypes(projects, prefs) }) };
    });

    // Salles du monde de la forge (données validées, lecture seule)
    registerRooms(game);
  });
}
