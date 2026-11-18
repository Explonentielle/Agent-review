import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Role } from "../db/accounts.js";
import { buildServer } from "../server/app.js";
import { TerminalHub } from "../terminal/session.js";
import { createClaudeStatusProbe } from "../claude/status.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { ROUTE_LEVELS, allows, levelOf, refusalMessage } from "./permissions.js";
import { createAuthRuntime } from "./runtime.js";
import { SESSION_COOKIE } from "./routes.js";

const WRITE = { "x-review-agent": "1" };
const AUTH = { publicUrl: "https://review.example", gitlab: { baseUrl: "https://gitlab.example", clientId: "c", clientSecret: "s" }, github: null, owner: "gitlab:alex", allowedUsers: [] as string[], sessionDays: 7 };

describe("droits par rôle : la table", () => {
  it("chaque niveau n'est accessible qu'aux rôles qui le méritent", () => {
    const grid: Record<Role, [boolean, boolean, boolean]> = { viewer: [true, false, false], member: [true, true, false], admin: [true, true, true] };
    for (const [role, [read, act, admin]] of Object.entries(grid) as Array<[Role, [boolean, boolean, boolean]]>) {
      expect([allows(role, "read"), allows(role, "act"), allows(role, "admin")], role).toEqual([read, act, admin]);
    }
  });

  it("le niveau se lit par méthode et motif de route ; HEAD compte comme GET ; une route inconnue n'a pas de niveau", () => {
    expect(levelOf("GET", "/api/tasks/:id")).toBe("read");
    expect(levelOf("HEAD", "/api/tasks/:id")).toBe("read");
    expect(levelOf("POST", "/api/tasks")).toBe("act");
    expect(levelOf("POST", "/api/settings")).toBe("admin");
    expect(levelOf("GET", "/api/settings")).toBe("read"); // lire les réglages n'est pas les changer
    expect(levelOf("DELETE", "/api/tasks/:id")).toBeUndefined();
    expect(levelOf("GET", "/api/inconnue")).toBeUndefined();
  });

  it("le message de refus dit le rôle de la personne et ce qu'il faut", () => {
    expect(refusalMessage("viewer", "act")).toContain("lecteur");
    expect(refusalMessage("viewer", "act")).toContain("un membre de l'espace");
    expect(refusalMessage("member", "admin")).toContain("membre");
    expect(refusalMessage("member", "admin")).toContain("un administrateur de l'espace");
  });

  it("toute écriture (POST) demande au moins « agir » : aucune n'est ouverte au lecteur, et rien n'est classé « lire » par erreur", () => {
    for (const [route, level] of Object.entries(ROUTE_LEVELS)) {
      if (route.startsWith("POST ")) expect(level, route).not.toBe("read");
    }
  });
});

describe("droits par rôle : le serveur", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];

  /** Serveur sans connexion : l'utilisateur local a le rôle voulu. */
  async function localServer(role: Role, terminal = false): Promise<FastifyInstance> {
    const app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: { ...h.local, role },
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
      ...(terminal ? { terminal: { hub: new TerminalHub(), launch: () => ({ file: process.execPath, args: ["-e", ""], env: {}, cwd: process.cwd() }), status: createClaudeStatusProbe("claude", () => ({}), async () => ({ code: 0, stdout: "ok", stderr: "", missing: false }), 0) } } : {}),
    });
    apps.push(app);
    return app;
  }
  const get = (app: FastifyInstance, url: string) => app.inject({ method: "GET", url });
  const post = (app: FastifyInstance, url: string, payload: object = {}) => app.inject({ method: "POST", url, payload, headers: WRITE });

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("aucune route du serveur n'échappe à la table, et la table ne garde aucune route qui n'existe plus", async () => {
    const app = await localServer("admin", true);
    await app.ready();
    const api = [...new Set(app.registeredRoutes.map((r) => r.replace(/^HEAD /, "GET ")))].filter((r) => r.split(" ")[1]!.startsWith("/api/") && !r.startsWith("OPTIONS "));
    expect(api.length).toBeGreaterThan(55); // le serveur complet, terminal compris : la liste ne doit jamais se vider sans qu'on le voie
    const unclassified = api.filter((r) => ROUTE_LEVELS[r] === undefined);
    expect(unclassified, `routes à classer dans src/auth/permissions.ts : ${unclassified.join(", ")}`).toEqual([]);
    const stale = Object.keys(ROUTE_LEVELS).filter((r) => !api.includes(r));
    expect(stale, `entrées de la table sans route : ${stale.join(", ")}`).toEqual([]);
  });

  it("lecteur : il lit tout, ne peut ni agir ni régler", async () => {
    const app = await localServer("viewer");
    for (const url of ["/api/stats", "/api/tasks", "/api/reviews", "/api/settings", "/api/projects", "/api/costs", "/api/issues", "/api/game", "/api/hero"]) {
      expect((await get(app, url)).statusCode, url).toBe(200);
    }
    for (const [url, body] of [["/api/tasks", { projectId: 1, issueIid: 1 }], ["/api/tasks/1/merge", {}], ["/api/reviews/1/approve", {}], ["/api/scribe/draft", {}], ["/api/secrets/github.token", { value: "x" }], ["/api/attachments", {}]] as const) {
      const res = await post(app, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ error: string }>().error).toContain("lecteur");
    }
    for (const [url, body] of [["/api/settings", {}], ["/api/projects", {}], ["/api/game", { enabled: false }]] as const) expect((await post(app, url, body)).statusCode, url).toBe(403);
    expect((await get(app, "/api/audit")).statusCode).toBe(403);
    expect((await get(app, "/api/secrets")).statusCode).toBe(403); // la liste de ses jetons demande d'agir
  });

  it("membre : il agit, mais ne règle pas l'espace et ne lit pas le journal", async () => {
    const app = await localServer("member");
    expect((await post(app, "/api/tasks", { source: "gitlab", projectId: 1, issueIid: 609 })).statusCode).not.toBe(403); // le garde laisse passer (la suite dépend du ticket)
    expect((await get(app, "/api/secrets")).statusCode).toBe(200);
    for (const [url, body] of [["/api/settings", {}], ["/api/projects", {}], ["/api/projects/1/delete", {}], ["/api/game", { enabled: false }], ["/api/agent-runtime/check", {}]] as const) {
      const res = await post(app, url, body);
      expect(res.statusCode, url).toBe(403);
      expect(res.json<{ error: string }>().error).toContain("administrateur");
    }
    expect((await get(app, "/api/audit")).statusCode).toBe(403);
  });

  it("administrateur : tout passe le garde", async () => {
    const app = await localServer("admin");
    expect((await get(app, "/api/audit")).statusCode).toBe(200);
    expect((await post(app, "/api/game", { enabled: true })).statusCode).toBe(200);
    expect((await post(app, "/api/settings", { n: "importe quoi" })).statusCode).toBe(400); // refusé par la validation des réglages, pas par les droits
    expect((await post(app, "/api/tasks", { source: "gitlab", projectId: 1, issueIid: 609 })).statusCode).not.toBe(403);
  });

  it("une route non classée est refusée par précaution, même à un administrateur", async () => {
    const app = await localServer("admin");
    app.get("/api/nouvelle-route", async () => ({ ok: true })); // ajoutée sans être classée
    app.post("/api/nouvelle-ecriture", async () => ({ ok: true }));
    await app.ready();
    for (const res of [await get(app, "/api/nouvelle-route"), await post(app, "/api/nouvelle-ecriture")]) {
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: string }>().error).toContain("non classée");
    }
  });

  it("hors de l'API (page, ressources) : aucun contrôle de rôle, et une adresse inconnue reste une 404", async () => {
    const app = await localServer("viewer");
    expect((await get(app, "/")).statusCode).toBe(200);
    expect((await get(app, "/api/n-existe-pas")).statusCode).toBe(404);
  });

  it("avec la connexion : le rôle vient de la session de la personne dans SON espace", async () => {
    const team = await h.accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: h.local.userId });
    const reader = await h.accounts.createUser({ name: "Lecteur" });
    const member = await h.accounts.createUser({ name: "Membre" });
    await h.accounts.addMember(team, reader, "viewer");
    await h.accounts.addMember(team, member, "member");
    const auth = createAuthRuntime(AUTH, h.db, h.accounts);
    const tenantDeps = { config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0 };
    const app = buildServer({ ...tenantDeps, accounts: h.accounts, local: h.local, auth, tenants: async () => tenantDeps });
    apps.push(app);
    const as = async (userId: number) => ({ cookie: `${SESSION_COOKIE}=${await auth.sessions.create(userId, team)}` });

    const viewer = await as(reader), doer = await as(member), admin = await as(h.local.userId);
    const call = (headers: { cookie: string }, method: "GET" | "POST", url: string) => app.inject({ method, url, headers: method === "POST" ? { ...headers, ...WRITE } : headers, payload: method === "POST" ? {} : undefined });
    expect((await call(viewer, "GET", "/api/tasks")).statusCode).toBe(200);
    expect((await call(viewer, "POST", "/api/tasks")).statusCode).toBe(403);
    expect((await call(doer, "POST", "/api/tasks")).statusCode).not.toBe(403);
    expect((await call(doer, "POST", "/api/settings")).statusCode).toBe(403);
    expect((await call(admin, "POST", "/api/settings")).statusCode).not.toBe(403);
    expect((await call(viewer, "GET", "/api/me")).json<{ role: string }>().role).toBe("viewer");

    // Un rôle changé prend effet tout de suite, sans nouvelle connexion
    await h.accounts.setRole(team, reader, "member");
    expect((await call(viewer, "POST", "/api/tasks")).statusCode).not.toBe(403);
    await h.accounts.removeMember(team, reader);
    expect((await call(viewer, "GET", "/api/tasks")).statusCode).toBe(401); // plus membre : la session ne vaut plus
  });
});
