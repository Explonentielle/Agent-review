import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { ForgeRegistry, type Forge } from "../connectors/registry.js";
import type { ForgeKind } from "../connectors/types.js";
import { createAuthRuntime } from "../auth/runtime.js";
import { SESSION_COOKIE } from "../auth/routes.js";
import { buildServer } from "../server/app.js";
import { Keyring } from "../secrets/crypto.js";
import { createSecretStore, type SecretStore } from "../secrets/store.js";
import { saveManagedSecret } from "../secrets/vault.js";
import { FakeConnector } from "../testing/fakeConnector.js";
import { createHarness, type Harness } from "../testing/harness.js";
import type { RepoWorkspace } from "../review/workspace.js";
import { ConcurrencyLimiter } from "./limiter.js";
import { TenantManager, type TenantContext, type TenantHooks } from "./manager.js";

const WRITE = { "x-review-agent": "1" };
const MR = { projectId: 1, projectPath: "g/p", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: "a".repeat(40) };

describe("limite de tâches simultanées", () => {
  it("jamais plus de tâches que la limite, dans l'ordre d'arrivée, et la place est rendue même après une erreur", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const job = (n: number, fail = false) => async () => {
      order.push(n);
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (fail) throw new Error(`échec ${n}`);
      return n;
    };

    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => limiter.run(job(n, n === 2))));
    expect(maxActive).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    expect(limiter.load).toEqual({ active: 0, waiting: 0 });
    await expect(limiter.run(async () => "encore possible")).resolves.toBe("encore possible");
  });

  it("une limite invalide est refusée", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => new ConcurrencyLimiter(bad)).toThrow(/au moins 1/);
  });
});

describe("exécution par personne", () => {
  let h: Harness;
  let store: SecretStore;
  let configs: Config[];
  let started: { username: string; kind: string }[];
  let stopped: string[];
  let reviewsRun: number[];
  let manager: TenantManager;
  let hooks: TenantHooks;
  let failForges: boolean;
  let bob: TenantContext;

  /** Forges de test : un faux connecteur par jeton présent dans la configuration reçue. */
  const fakeCreateForges: NonNullable<TenantHooks["createForges"]> = async (config, options) => {
    configs.push(config);
    if (failForges && (config.gitlab || config.github)) throw new Error("forge en panne"); // une configuration sans jeton se construit toujours
    const forges: Forge[] = [];
    const add = (kind: ForgeKind, username: string) => forges.push({ connector: new FakeConnector({ cloneUrl: "file:///x" }, kind), workspace: {} as RepoWorkspace, username });
    if (config.gitlab) add("gitlab", config.gitlab.username);
    if (config.github) add("github", `gh-${config.github.token.slice(-4)}`);
    return new ForgeRegistry(forges, options);
  };

  beforeEach(async () => {
    h = await createHarness();
    store = createSecretStore(h.db, new Keyring([randomBytes(32)]));
    configs = [];
    started = [];
    stopped = [];
    reviewsRun = [];
    failForges = false;
    hooks = {
      createForges: fakeCreateForges,
      startPoller: (deps) => {
        started.push({ username: deps.username, kind: deps.connector.kind });
        return () => void stopped.push(deps.username);
      },
      runReview: async (id) => void reviewsRun.push(id),
      verifyGithubToken: async () => undefined,
      verifyGitlabToken: async () => "bob-gitlab",
    };
    manager = new TenantManager({ db: h.db, config: h.config, store, ownerUserId: h.local.userId, limits: { review: new ConcurrencyLimiter(1), dev: new ConcurrencyLimiter(1) }, hooks });
    const user = await h.accounts.createUser({ name: "Bob" });
    bob = { userId: user, workspaceId: await h.accounts.createWorkspace({ name: "Espace de Bob", kind: "personal", adminUserId: user }) };
  });
  afterEach(async () => {
    await manager.stopAll();
    h.cleanup();
  });

  it("le propriétaire utilise les jetons du .env ; une autre personne n'en reçoit aucun et a son propre dossier de données", async () => {
    const owner = await manager.get(h.local);
    const other = await manager.get(bob);

    expect(configs[0]!.gitlab?.token).toBe("token-factice");
    expect(owner.deps.forges.all().map((f) => f.username)).toEqual(["alex"]);

    expect(configs[1]!.gitlab).toBeNull();
    expect(configs[1]!.github).toBeNull();
    expect(configs[1]!.anthropicApiKey).toBeNull();
    expect(configs[1]!.dataDir).toBe(`${h.config.dataDir}/tenants/${bob.workspaceId}-${bob.userId}`);
    expect(other.deps.forges.all()).toEqual([]);
    expect(owner.deps.config.dataDir).toBe(h.config.dataDir);

    expect(started).toEqual([{ username: "alex", kind: "gitlab" }]); // pas de poller pour qui n'a aucune forge
    expect(await manager.get(h.local)).toBe(owner); // une seule exécution par personne
  });

  it("dépôts, réglages, clé API et files de chaque personne sont séparés", async () => {
    const owner = await manager.get(h.local);
    const other = await manager.get(bob);

    await owner.deps.reviews.insertIfNew(MR);
    owner.deps.config.anthropicApiKey = "cle-du-proprietaire";
    const settings = await owner.deps.settings.get();
    await owner.deps.settings.save({ ...settings, actionMode: "auto" });

    expect(await other.deps.reviews.list()).toEqual([]);
    expect(await other.deps.tasks.list()).toEqual([]);
    expect((await other.deps.settings.get()).actionMode).toBe(settings.actionMode);
    expect(other.deps.config.anthropicApiKey).toBeNull();
    expect(await owner.deps.reviews.list()).toHaveLength(1);

    other.deps.enqueueReview(await other.deps.reviews.insertIfNew(MR) ?? 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(other.deps.queueSize()).toBe(0);
    expect(owner.deps.queueSize()).toBe(0);
    expect(reviewsRun).toHaveLength(1); // seule la review de Bob a été lancée
    expect((await other.deps.reviews.list()).map((r) => r.id)).toEqual(reviewsRun);
    expect((await owner.deps.reviews.list()).map((r) => r.id)).not.toContain(reviewsRun[0]);
  });

  it("les jetons du coffre d'une personne ne servent qu'à elle", async () => {
    await store.put({ workspaceId: bob.workspaceId, userId: bob.userId }, "github.token", "github_pat_DE_BOB_5678");
    await store.put({ workspaceId: bob.workspaceId, userId: bob.userId }, "gitlab.token", "glpat-DE-BOB-1234");
    await store.put({ workspaceId: bob.workspaceId, userId: bob.userId }, "anthropic.api_key", "sk-ant-DE-BOB-1234");

    const owner = await manager.get(h.local);
    const other = await manager.get(bob);

    expect(other.deps.forges.all().map((f) => `${f.connector.kind}:${f.username}`)).toEqual(["gitlab:bob-gitlab", "github:gh-5678"]);
    expect(other.deps.config.anthropicApiKey).toBe("sk-ant-DE-BOB-1234");
    expect(owner.deps.forges.all().map((f) => f.connector.kind)).toEqual(["gitlab"]);
    expect(owner.deps.config.github).toBeNull();
    expect(owner.deps.config.anthropicApiKey).toBeNull();
    expect(started.map((s) => `${s.username}/${s.kind}`).sort()).toEqual(["alex/gitlab", "bob-gitlab/gitlab", "gh-5678/github"]);
  });

  it("changement de jeton : les connexions sont reconstruites sans redémarrer, les anciens pollers s'arrêtent", async () => {
    const other = await manager.get(bob);
    expect(started).toEqual([]);

    const result = await saveManagedSecret(other.deps.config, other.deps.vault, "github.token", "github_pat_NOUVEAU_9999");
    expect(result.restartRequired).toBe(true);
    await other.deps.reload!();

    const rebuilt = await manager.get(bob);
    expect(rebuilt).not.toBe(other);
    expect(rebuilt.deps.forges.all().map((f) => f.username)).toEqual(["gh-9999"]);
    expect(started).toEqual([{ username: "gh-9999", kind: "github" }]);

    await rebuilt.deps.reload!(); // le suivant remplace celui-ci : son poller est arrêté
    expect(stopped).toEqual(["gh-9999"]);
  });

  it("une reconstruction qui échoue laisse l'ancienne exécution en place", async () => {
    const owner = await manager.get(h.local);
    failForges = true;
    await expect(owner.deps.reload!()).rejects.toThrow(/forge en panne/);
    expect(await manager.get(h.local)).toBe(owner);
    expect(stopped).toEqual([]); // ses pollers tournent toujours
  });

  it("une personne dont les forges échouent démarre quand même, sans forge", async () => {
    await store.put({ workspaceId: bob.workspaceId, userId: bob.userId }, "github.token", "github_pat_DE_BOB_5678");
    await manager.get(h.local);
    failForges = true;
    const other = await manager.get(bob);
    expect(other.deps.forges.all()).toEqual([]);
  });

  it("reprise après un arrêt : les reviews interrompues sont relancées, une seule fois par personne", async () => {
    const queued = (await createReviewsFor(h, bob.workspaceId))!;
    await h.db.run("UPDATE reviews SET status = 'running' WHERE id = ?", [queued]);

    const other = await manager.get(bob);
    await new Promise((r) => setTimeout(r, 30));
    expect(reviewsRun).toEqual([queued]);

    await other.deps.reload!(); // une reconstruction ne relance pas ce qui tourne déjà
    await new Promise((r) => setTimeout(r, 30));
    expect(reviewsRun).toEqual([queued]);
  });

  it("une limite commune borne les agents de toutes les personnes", async () => {
    let active = 0;
    let maxActive = 0;
    hooks.runReview = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    manager = new TenantManager({ db: h.db, config: h.config, store, ownerUserId: h.local.userId, limits: { review: new ConcurrencyLimiter(1), dev: new ConcurrencyLimiter(1) }, hooks });
    const [owner, other] = [await manager.get(h.local), await manager.get(bob)];
    for (const [tenant, mrIid] of [[owner, 1], [owner, 2], [other, 3], [other, 4]] as const) tenant.deps.enqueueReview((await tenant.deps.reviews.insertIfNew({ ...MR, mrIid }))!);

    await new Promise((r) => setTimeout(r, 150));
    expect(maxActive).toBe(1);
  });

  it("au démarrage : le propriétaire, et les autres seulement si l'accès multi-personnes est ouvert", async () => {
    await store.put({ workspaceId: bob.workspaceId, userId: bob.userId }, "github.token", "github_pat_DE_BOB_5678");

    const onlyOwner = await manager.startKnown(h.local, false);
    expect(onlyOwner).toHaveLength(1);

    const everyone = await manager.startKnown(h.local, true);
    expect(everyone.map((t) => t.userId)).toEqual([h.local.userId, bob.userId]);
    expect(started.some((s) => s.kind === "github")).toBe(true);

    await manager.stopAll();
    expect(stopped.sort()).toEqual(["alex", "gh-5678"]);
  });
});

/** Crée une review en attente dans un espace, en passant par le dépôt de cet espace. */
async function createReviewsFor(h: Harness, workspaceId: number): Promise<number | null> {
  const { createReviewRepo } = await import("../db/reviews.js");
  return createReviewRepo(h.db, workspaceId).insertIfNew(MR);
}

describe("serveur pour plusieurs personnes", () => {
  let h: Harness;
  let app: ReturnType<typeof buildServer>;
  let manager: TenantManager;
  let owner: { cookie: string };
  let other: { cookie: string; ctx: TenantContext };

  const get = (user: { cookie: string }, url: string) => app.inject({ method: "GET", url, headers: { cookie: user.cookie } });
  const post = (user: { cookie: string }, url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { cookie: user.cookie, ...WRITE }, payload });

  beforeEach(async () => {
    h = await createHarness();
    const store = createSecretStore(h.db, new Keyring([randomBytes(32)]));
    manager = new TenantManager({
      db: h.db,
      config: h.config,
      store,
      ownerUserId: h.local.userId,
      limits: { review: new ConcurrencyLimiter(1), dev: new ConcurrencyLimiter(1) },
      hooks: {
        createForges: async (config, options) => {
          const forges: Forge[] = [];
          if (config.gitlab) forges.push({ connector: new FakeConnector({ cloneUrl: "file:///x" }, "gitlab"), workspace: {} as RepoWorkspace, username: config.gitlab.username });
          if (config.github) forges.push({ connector: new FakeConnector({ cloneUrl: "file:///x" }, "github"), workspace: {} as RepoWorkspace, username: "bob-github" });
          return new ForgeRegistry(forges, options);
        },
        startPoller: () => () => undefined,
        verifyGithubToken: async () => undefined,
      },
    });
    const auth = createAuthRuntime(
      { publicUrl: "https://review.example", gitlab: { baseUrl: "https://gitlab.example", clientId: "c", clientSecret: "s" }, github: null, owner: "gitlab:alex", allowedUsers: ["gitlab:bob"], sessionDays: 7 },
      h.db,
      h.accounts,
    );
    expect(auth.policy.multiUser).toBe(true);
    const [ownerTenant] = await manager.startKnown(h.local, true);
    app = buildServer({ ...ownerTenant!.deps, accounts: h.accounts, local: h.local, auth, tenants: async (session) => (await manager.get(session)).deps });
    await app.ready();

    const bobId = await h.accounts.createUser({ name: "Bob" });
    const bobSpace = await h.accounts.createWorkspace({ name: "Espace de Bob", kind: "personal", adminUserId: bobId });
    owner = { cookie: `${SESSION_COOKIE}=${await auth.sessions.create(h.local.userId, h.local.workspaceId)}` };
    other = { cookie: `${SESSION_COOKIE}=${await auth.sessions.create(bobId, bobSpace)}`, ctx: { userId: bobId, workspaceId: bobSpace } };
  });
  afterEach(async () => {
    await app.close();
    await manager.stopAll();
    h.cleanup();
  });

  it("chaque personne ne voit que ses forges, ses reviews, ses tâches et son état", async () => {
    const ownerTenant = await manager.get(h.local);
    await ownerTenant.deps.reviews.insertIfNew(MR);
    await ownerTenant.deps.tasks.insert({ projectId: 1, projectPath: "g/p", issueIid: 1, issueTitle: "t", issueUrl: "u", extraInstructions: null });

    const mine = (await get(owner, "/api/stats")).json<{ forges: { kind: string; username: string }[]; counts: Record<string, number>; username: string }>();
    expect(mine).toMatchObject({ forges: [{ kind: "gitlab", username: "alex" }], counts: { queued: 1 }, username: "alex" });
    expect((await get(owner, "/api/tasks")).json<unknown[]>()).toHaveLength(1);

    const theirs = (await get(other, "/api/stats")).json<{ forges: unknown[]; counts: Record<string, number>; username: string }>();
    expect(theirs).toMatchObject({ forges: [], counts: {}, username: "" });
    expect((await get(other, "/api/tasks")).json<unknown[]>()).toEqual([]);
    expect((await get(other, "/api/issues")).json()).toEqual([]); // aucune forge : liste vide, pas d'erreur
    expect((await get(other, "/api/me")).json()).toMatchObject({ mode: "login", user: { name: "Bob" }, workspace: { name: "Espace de Bob" } });
    expect((await get(owner, "/api/me")).json()).toMatchObject({ user: { id: h.local.userId } });
  });

  it("une personne enregistre ses jetons : ses connexions se reconstruisent sans redémarrage, celles des autres ne bougent pas", async () => {
    const before = (await get(other, "/api/secrets")).json<{ secrets: { name: string; source: string | null }[] }>().secrets.map((s) => [s.name, s.source]);
    expect(before).toEqual([["gitlab.token", null], ["github.token", null], ["anthropic.api_key", null]]); // rien venant du .env du propriétaire

    const saved = await post(other, "/api/secrets/github.token", { value: "github_pat_DE_BOB_1234" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ restartRequired: false }); // reconstruit tout de suite

    expect((await get(other, "/api/stats")).json<{ forges: { kind: string; username: string }[] }>().forges).toEqual([{ kind: "github", username: "bob-github" }]);
    expect((await get(owner, "/api/stats")).json<{ forges: { kind: string }[] }>().forges.map((f) => f.kind)).toEqual(["gitlab"]);
    expect((await get(owner, "/api/secrets")).json<{ secrets: { name: string; source: string | null }[] }>().secrets.map((s) => [s.name, s.source])).toEqual([
      ["gitlab.token", "env"],
      ["github.token", null],
      ["anthropic.api_key", null],
    ]);

    // La clé API de l'un n'est pas celle de l'autre
    expect((await post(other, "/api/secrets/anthropic.api_key", { value: "sk-ant-DE-BOB-12345" })).statusCode).toBe(200);
    expect((await get(other, "/api/stats")).json<{ apiKeyConfigured: boolean }>().apiKeyConfigured).toBe(true);
    expect((await get(owner, "/api/stats")).json<{ apiKeyConfigured: boolean }>().apiKeyConfigured).toBe(false);

    // Le propriétaire ne peut pas lui retirer son jeton, ni l'inverse : chaque coffre est personnel
    expect((await post(owner, "/api/secrets/github.token/delete")).json()).toEqual({ deleted: false, restartRequired: false });
    expect((await get(other, "/api/secrets")).json<{ secrets: { name: string; source: string | null }[] }>().secrets.find((s) => s.name === "github.token")?.source).toBe("vault");
  });

  it("une session sans cookie valide n'obtient rien, même avec l'identifiant d'une autre personne", async () => {
    expect((await app.inject({ method: "GET", url: "/api/stats" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/stats", headers: { cookie: `${SESSION_COOKIE}=${other.ctx.userId}` } })).statusCode).toBe(401);
  });
});
