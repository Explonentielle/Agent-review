import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UserQuotaError, assertQuotaAvailable } from "./budget.js";
import { currentMonth } from "./db/costs.js";
import { createDevTaskRepo } from "./db/devTasks.js";
import { createReviewRepo } from "./db/reviews.js";
import { runDevTask } from "./dev/pipeline.js";
import { runReview } from "./review/pipeline.js";
import { buildServer } from "./server/app.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings/schema.js";
import { createHarness, type Harness } from "./testing/harness.js";

/* Limites par personne : budget du mois (mode clé API) et nombre d'agents par jour (dans les deux modes), valeur de l'espace ou propre au membre. */
const ISSUE = { projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null };
const WRITE = { "x-review-agent": "1" };

describe("limites par personne", () => {
  let h: Harness;
  let team: number;
  let alice: number, bob: number;
  const apps: FastifyInstance[] = [];

  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });
  const quotas = (perUserMonthlyUsd: number, perUserDailyRuns: number) => ({ quotas: { perUserMonthlyUsd, perUserDailyRuns } });
  const tasksOf = (userId: number | null) => createDevTaskRepo(h.db, team, userId);
  const reviewsOf = (userId: number | null) => createReviewRepo(h.db, team, userId);
  const refusal = async (fn: Promise<void>) => fn.then(() => null, (e: unknown) => e as Error);

  beforeEach(async () => {
    h = await createHarness();
    team = h.local.workspaceId; // l'espace du harnais ; alice est son administratrice, bob y entre
    alice = h.local.userId;
    bob = await h.accounts.createUser({ name: "Bob" });
    await h.db.run("UPDATE workspaces SET kind = 'team' WHERE id = ?", [team]);
    await h.accounts.addMember(team, bob, "member");
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  describe("nombre d'agents par jour", () => {
    it("sans limite par défaut ; avec une limite, l'agent à lancer compte (contrôle avant création), ceux d'hier non", async () => {
      for (let i = 0; i < 10; i++) await tasksOf(alice).insert({ ...ISSUE, issueIid: i });
      await assertQuotaAvailable(settings(), h.costs, alice, { pending: true }); // 0 : aucune limite

      const limited = settings(quotas(0, 3));
      await expect(assertQuotaAvailable(limited, h.costs, alice, { pending: true })).rejects.toBeInstanceOf(UserQuotaError); // déjà 10 aujourd'hui
      await h.db.run("UPDATE dev_tasks SET created_at = '2020-01-01 10:00:00'");
      await assertQuotaAvailable(limited, h.costs, alice, { pending: true }); // tout est ancien : ça passe
      for (let i = 0; i < 2; i++) await tasksOf(alice).insert({ ...ISSUE, issueIid: 100 + i });
      await assertQuotaAvailable(limited, h.costs, alice, { pending: true }); // 2 + celui qu'on crée = 3, permis
      await tasksOf(alice).insert({ ...ISSUE, issueIid: 200 });
      const refused = await refusal(assertQuotaAvailable(limited, h.costs, alice, { pending: true })); // 3 + 1 = 4 > 3
      expect(refused).toBeInstanceOf(UserQuotaError);
      expect((refused as UserQuotaError).kind).toBe("runs");
      expect(refused!.message).toContain("3 agents par jour");
      expect(refused!.message).toContain("Paramètres > Équipe");
    });

    it("au démarrage de la file l'agent est déjà compté : la limite de 3 laisse démarrer le troisième, pas le quatrième", async () => {
      const limited = settings(quotas(0, 3));
      for (let i = 0; i < 3; i++) await tasksOf(alice).insert({ ...ISSUE, issueIid: i });
      await assertQuotaAvailable(limited, h.costs, alice); // 3 créés, le troisième démarre
      await tasksOf(alice).insert({ ...ISSUE, issueIid: 9 });
      expect(await refusal(assertQuotaAvailable(limited, h.costs, alice))).toBeInstanceOf(UserQuotaError);
    });

    it("reviews et tâches comptent ensemble, chaque personne a son compte, le singulier est respecté", async () => {
      const limited = settings(quotas(0, 1));
      await reviewsOf(alice).insertIfNew({ projectId: 1, projectPath: "g/p", mrIid: 1, mrTitle: "t", mrUrl: "u", author: "a", headSha: "a".repeat(40) });
      const refused = await refusal(assertQuotaAvailable(limited, h.costs, alice));
      await assertQuotaAvailable(limited, h.costs, alice); // une review du jour : la limite de 1 laisse démarrer celle-là
      expect(refused).toBeNull();
      expect(await refusal(assertQuotaAvailable(limited, h.costs, alice, { pending: true }))).toMatchObject({ message: expect.stringContaining("1 agent par jour") });
      await assertQuotaAvailable(limited, h.costs, bob, { pending: true }); // Bob n'a rien lancé
      await assertQuotaAvailable(limited, h.costs, null, { pending: true }); // review d'avant les quotas : aucune limite personnelle
    });

    it("la limite propre au membre prime : plus haute, sans limite (0), ou reprise de l'espace (null)", async () => {
      const limited = settings(quotas(0, 1));
      await tasksOf(bob).insert(ISSUE);
      expect(await refusal(assertQuotaAvailable(limited, h.costs, bob, { pending: true }))).toBeInstanceOf(UserQuotaError); // limite de l'espace : 1
      await h.accounts.setMemberQuota(team, bob, { budgetUsd: null, dailyRuns: 3 });
      await assertQuotaAvailable(limited, h.costs, bob, { pending: true }); // sa propre limite est plus haute
      await h.accounts.setMemberQuota(team, bob, { budgetUsd: null, dailyRuns: 0 });
      for (let i = 0; i < 20; i++) await tasksOf(bob).insert({ ...ISSUE, issueIid: i });
      await assertQuotaAvailable(limited, h.costs, bob, { pending: true }); // 0 : sans limite, même sous une limite d'espace
      await h.accounts.setMemberQuota(team, bob, { budgetUsd: null, dailyRuns: null });
      expect(await refusal(assertQuotaAvailable(limited, h.costs, bob, { pending: true }))).toBeInstanceOf(UserQuotaError); // retour à la valeur de l'espace
      await h.accounts.setMemberQuota(team, alice, { budgetUsd: null, dailyRuns: 1 }); // une limite plus stricte pour une personne dont l'espace n'en a pas
      await tasksOf(alice).insert(ISSUE);
      expect(await refusal(assertQuotaAvailable(settings(), h.costs, alice, { pending: true }))).toBeInstanceOf(UserQuotaError);
    });
  });

  describe("budget du mois", () => {
    const spend = async (userId: number, usd: number, month = currentMonth()) => {
      const id = await tasksOf(userId).insert({ ...ISSUE, issueIid: Math.floor(Math.random() * 1e6) });
      await h.db.run("UPDATE dev_tasks SET cost_usd = ?, updated_at = ? WHERE id = ?", [usd, `${month}-10 10:00:00`, id]);
    };

    it("en mode clé API : atteint = refusé, au-dessous = permis, les autres personnes et les autres mois ne comptent pas", async () => {
      const api = settings({ agentAuth: "api", ...quotas(10, 0) });
      await spend(alice, 9.99);
      await spend(bob, 500); // Bob a dépensé, pas Alice
      await spend(alice, 500, "2020-01"); // un autre mois
      await assertQuotaAvailable(api, h.costs, alice);
      await spend(alice, 0.01);
      const refused = await refusal(assertQuotaAvailable(api, h.costs, alice));
      expect(refused).toBeInstanceOf(UserQuotaError);
      expect((refused as UserQuotaError).kind).toBe("budget");
      expect(refused!.message).toContain("10.00 $");
      expect(refused!.message).toContain("Paramètres > Équipe");
    });

    it("sur l'abonnement, le budget en dollars ne s'applique pas (l'équivalent API n'est pas une facture)", async () => {
      await spend(alice, 1000);
      await assertQuotaAvailable(settings({ agentAuth: "subscription", ...quotas(10, 0) }), h.costs, alice);
    });

    it("le budget propre au membre prime, 0 le libère, null reprend celui de l'espace", async () => {
      const api = settings({ agentAuth: "api", ...quotas(10, 0) });
      await spend(bob, 15);
      expect(await refusal(assertQuotaAvailable(api, h.costs, bob))).toBeInstanceOf(UserQuotaError);
      await h.accounts.setMemberQuota(team, bob, { budgetUsd: 50, dailyRuns: null });
      await assertQuotaAvailable(api, h.costs, bob);
      await h.accounts.setMemberQuota(team, bob, { budgetUsd: 5, dailyRuns: null });
      expect(await refusal(assertQuotaAvailable(settings({ agentAuth: "api", ...quotas(0, 0) }), h.costs, bob))).toBeInstanceOf(UserQuotaError); // limite propre, espace sans limite
      await h.accounts.setMemberQuota(team, bob, { budgetUsd: 0, dailyRuns: null });
      await assertQuotaAvailable(api, h.costs, bob);
    });
  });

  describe("à l'usage : l'API refuse tout de suite, la file refuse au démarrage", () => {
    const server = () => {
      const app = buildServer({ config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local, enqueueReview: () => undefined, enqueueDev: (id) => void queued.push(id), queueSize: () => 0 });
      apps.push(app);
      return app;
    };
    let queued: number[];
    beforeEach(() => {
      queued = [];
      h.connector.tickets.set(609, h.ticket()); // le ticket que l'agent va traiter
    });
    const setLimit = async (perUserDailyRuns: number) => void (await h.settings.save({ ...(await h.settings.get()), quotas: { perUserMonthlyUsd: 0, perUserDailyRuns } }));
    const launch = (app: FastifyInstance) => app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: { source: "gitlab", projectId: 1, issueIid: 609 } });

    it("lancer l'agent : 200 sous la limite, puis 429 avec le message, sans rien créer ni mettre en file", async () => {
      await setLimit(1);
      const app = server();
      const first = await launch(app);
      expect(first.statusCode).toBe(200);
      const tasks = (await h.tasks.list()).length;
      await h.tasks.update(first.json<{ id: number }>().id, { status: "mr_created" }); // terminée : on peut relancer sur ce ticket
      const second = await launch(app);
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: string }>().error).toContain("1 agent par jour");
      expect((await h.tasks.list()).length).toBe(tasks); // rien n'a été créé
      expect(queued).toHaveLength(1);
      await setLimit(2); // l'administrateur relève la limite : ça repart
      expect((await launch(app)).statusCode).toBe(200);
    });

    it("la reprise et « corriger avec la relecture » sont limitées de la même façon", async () => {
      await setLimit(1);
      const app = server();
      const origin = await h.tasks.insert(ISSUE); // une tâche du jour, déjà terminée : la limite de 1 est atteinte
      await h.tasks.update(origin, { status: "mr_created", branch: "feature/609-import", base_branch: "develop", target_branch: "develop", mr_iid: 12, mr_url: "u" });
      const res = await app.inject({ method: "POST", url: `/api/tasks/${origin}/followup`, headers: WRITE, payload: { instructions: "Ajoute les docblocks" } });
      expect(res.statusCode).toBe(429);
      expect(queued).toEqual([]);
      await setLimit(0);
      expect((await app.inject({ method: "POST", url: `/api/tasks/${origin}/followup`, headers: WRITE, payload: { instructions: "Ajoute les docblocks" } })).statusCode).toBe(200);
    });

    it("la file refuse au démarrage une tâche et une review dont la personne a atteint sa limite, avec le message, sans appeler la forge", async () => {
      await h.settings.save({ ...(await h.settings.get()), quotas: { perUserMonthlyUsd: 0, perUserDailyRuns: 1 } });
      await tasksOf(bob).insert({ ...ISSUE, issueIid: 1 }); // la première du jour
      const second = await tasksOf(bob).insert({ ...ISSUE, issueIid: 2 });
      await runDevTask(second, { config: h.config, forges: h.forges, costs: h.costs, settings: h.settings, tasks: tasksOf(null) });
      const task = (await tasksOf(null).get(second))!;
      expect(task.status).toBe("error");
      expect(task.error).toContain("1 agent par jour");

      const reviews = reviewsOf(bob);
      const reviewId = (await reviews.insertIfNew({ projectId: 1, projectPath: "g/p", mrIid: 5, mrTitle: "t", mrUrl: "u", author: "a", headSha: "e".repeat(40) }))!; // la 3e agent du jour de Bob
      await runReview(reviewId, { config: h.config, forges: h.forges, costs: h.costs, reviews: reviewsOf(null), settings: h.settings, tasks: tasksOf(null) });
      const review = (await reviewsOf(null).get(reviewId))!;
      expect(review.status).toBe("error");
      expect(review.error).toContain("1 agent par jour");
    });
  });
});
