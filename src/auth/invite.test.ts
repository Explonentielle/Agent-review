import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server/app.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { SESSION_COOKIE } from "./routes.js";
import { createAuthRuntime } from "./runtime.js";

const WRITE = { "x-review-agent": "1" };
const AUTH = { publicUrl: "https://review.example", gitlab: { baseUrl: "https://gitlab.example", clientId: "cg", clientSecret: "sg" }, github: { clientId: "ch", clientSecret: "sh" }, owner: "gitlab:alex", allowedUsers: [] as string[], sessionDays: 7 };

type Profile = { id: number; username?: string; login?: string; name: string; email: string | null };

/** Fausse forge : le profil renvoyé est celui de la personne qui se connecte, choisie par le test. */
function fakeForge(current: () => Profile): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth/token") || url.endsWith("/login/oauth/access_token")) return Response.json({ access_token: "jeton-factice", token_type: "Bearer" });
    if (url.endsWith("/api/v4/user") || url === "https://api.github.com/user") return Response.json(current());
    return new Response("introuvable", { status: 404 });
  }) as typeof fetch;
}

describe("invitations : de l'administrateur à la personne invitée", () => {
  let h: Harness;
  let app: FastifyInstance;
  let team: number;
  let admin: number;
  let who: Profile;
  const apps: FastifyInstance[] = [];

  /** Serveur avec connexion par compte ; chaque personne est servie avec ses dépôts (ici, ceux du harnais). */
  async function server(rate?: { limit: number; windowMs: number }, trustProxy = false): Promise<FastifyInstance> {
    const auth = createAuthRuntime(AUTH, h.db, h.accounts, fakeForge(() => who));
    if (rate) auth.rateLimit = rate;
    const tenantDeps = { config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0 };
    const built = buildServer({ ...tenantDeps, config: { ...h.config, server: { ...h.config.server, trustProxy } }, accounts: h.accounts, local: h.local, auth, tenants: async () => tenantDeps });
    apps.push(built);
    await built.ready();
    return built;
  }

  /** Crée une invitation chez l'administrateur et rend son jeton. */
  async function invite(input: { role?: string; note?: string; forgeLogin?: string } = {}): Promise<string> {
    return (await createInvitation(input)).token;
  }
  const createInvitation = async (input: { role?: string; note?: string; forgeLogin?: string } = {}) => {
    const repo = (await import("../db/invitations.js")).createInvitationRepo(h.db);
    return repo.create({ workspaceId: team, role: input.role ?? "member", note: input.note ?? "", forgeLogin: input.forgeLogin ?? null, createdBy: admin });
  };

  const cookieOf = (res: { headers: Record<string, unknown> }, name: string): string => {
    const raw = ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? []);
    return raw.find((c) => c.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1) ?? "";
  };

  /** Joue le chemin complet : le lien d'invitation, la forge, le retour. Rend la réponse finale et le cookie de session (vide si la connexion est refusée). */
  async function accept(token: string, provider: "gitlab" | "github" = "gitlab", server: FastifyInstance = app, remoteAddress = "10.0.0.1") {
    const start = await server.inject({ method: "GET", url: `/invite/${token}/login/${provider}`, remoteAddress });
    if (start.statusCode !== 302 || !String(start.headers.location).includes("state=")) return { start, callback: start, session: "" };
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const callback = await server.inject({ method: "GET", url: `/auth/${provider}/callback?code=le-code&state=${state}`, headers: { cookie: `ra_oauth=${cookieOf(start, "ra_oauth")}` }, remoteAddress });
    return { start, callback, session: cookieOf(callback, SESSION_COOKIE) };
  }
  const api = (session: string, url: string, method: "GET" | "POST" = "GET", payload: object = {}) =>
    app.inject({ method, url, headers: method === "POST" ? { cookie: `${SESSION_COOKIE}=${session}`, ...WRITE } : { cookie: `${SESSION_COOKIE}=${session}` }, payload: method === "POST" ? payload : undefined });

  beforeEach(async () => {
    h = await createHarness();
    admin = h.local.userId;
    team = await h.accounts.createWorkspace({ name: "Équipe Alpha", kind: "team", adminUserId: admin });
    who = { id: 501, username: "bob", name: "Bob Martin", email: "bob@example.com" };
    app = await server();
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    h.cleanup();
  });

  it("une personne inconnue entre avec le lien : membre de l'espace avec le rôle prévu, sans espace personnel, espace actif = l'équipe", async () => {
    const token = await invite({ role: "member" });
    const { callback, session } = await accept(token);
    expect(callback.headers.location).toBe("/");
    expect(session.length).toBeGreaterThan(20);

    const me = (await api(session, "/api/me")).json<{ user: { name: string }; workspace: { id: number; name: string; kind: string }; role: string }>();
    expect(me).toMatchObject({ user: { name: "Bob Martin" }, workspace: { id: team, name: "Équipe Alpha", kind: "team" }, role: "member" });
    const user = (await h.accounts.findUserByIdentity("gitlab", "501"))!;
    expect((await h.accounts.listWorkspacesOf(user.id)).map((w) => [w.id, w.kind, w.role])).toEqual([[team, "team", "member"]]); // pas d'espace personnel créé
    expect((await h.accounts.listIdentities(user.id))).toEqual([{ provider: "gitlab", login: "bob" }]);
  });

  it("le lien ne sert qu'une fois : un autre compte qui le réutilise est refusé et la première personne garde sa place", async () => {
    const token = await invite({ role: "viewer" });
    const first = await accept(token);
    expect(first.session).not.toBe("");

    who = { id: 502, username: "carol", name: "Carol", email: null };
    const second = await accept(token);
    expect(second.session).toBe("");
    expect(second.start.headers.location).toBe("/login?error=invite"); // la page de départ elle-même refuse : l'invitation n'est plus valable
    expect(await h.accounts.findUserByIdentity("gitlab", "502")).toBeUndefined(); // aucun compte créé pour elle
    expect((await h.accounts.listMembers(team)).map((m) => m.name).sort()).toEqual(["Bob Martin", "Utilisateur local"].sort());
  });

  it("de deux personnes qui reviennent de la forge en même temps avec le même lien, une seule entre", async () => {
    const token = await invite({ role: "member" });
    const profiles: Profile[] = [{ id: 601, username: "dan", name: "Dan", email: null }, { id: 602, username: "eve", name: "Eve", email: null }];
    const starts = await Promise.all(profiles.map(async () => app.inject({ method: "GET", url: `/invite/${token}/login/gitlab` })));
    expect(starts.every((s) => s.statusCode === 302 && String(s.headers.location).includes("state="))).toBe(true); // les deux sont parties avant que l'une entre
    const results = [];
    for (const [i, start] of starts.entries()) {
      who = profiles[i]!;
      const state = new URL(String(start.headers.location)).searchParams.get("state")!;
      results.push(await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${state}`, headers: { cookie: `ra_oauth=${cookieOf(start, "ra_oauth")}` } }));
    }
    expect(results.map((r) => r.headers.location).sort()).toEqual(["/", "/login?error=invite"]);
    expect((await h.accounts.listMembers(team)).filter((m) => m.name === "Dan" || m.name === "Eve")).toHaveLength(1);
  });

  it("une personne déjà connue (espace personnel) rejoint l'équipe : elle garde son compte, l'équipe devient son espace actif", async () => {
    const user = await h.accounts.createUser({ name: "Bob" });
    await h.accounts.linkIdentity(user, "gitlab", "501", "bob");
    const personal = await h.accounts.createWorkspace({ name: "Chez Bob", kind: "personal", adminUserId: user });
    const { session } = await accept(await invite({ role: "member" }));

    expect((await api(session, "/api/me")).json<{ workspace: { id: number }; role: string }>()).toMatchObject({ workspace: { id: team }, role: "member" });
    expect((await h.accounts.listWorkspacesOf(user)).map((w) => w.id).sort()).toEqual([personal, team].sort());
    expect((await h.accounts.findUserByIdentity("gitlab", "501"))!.id).toBe(user); // pas de doublon

    // Il retrouve son espace personnel quand il le demande
    const list = (await api(session, "/api/workspaces")).json<{ active: number; workspaces: Array<{ id: number; role: string }> }>();
    expect(list.active).toBe(team);
    expect(list.workspaces.map((w) => [w.id, w.role]).sort()).toEqual([[personal, "admin"], [team, "member"]].sort());
    expect((await api(session, "/api/workspaces/active", "POST", { id: personal })).statusCode).toBe(200);
    expect((await api(session, "/api/me")).json<{ workspace: { id: number }; role: string }>()).toMatchObject({ workspace: { id: personal }, role: "admin" });
  });

  it("déjà membre, la personne n'use pas l'invitation : elle reste valable pour quelqu'un d'autre", async () => {
    const user = await h.accounts.createUser({ name: "Bob" });
    await h.accounts.linkIdentity(user, "gitlab", "501", "bob");
    await h.accounts.addMember(team, user, "member");
    const made = await createInvitation({ role: "admin" });
    const { session } = await accept(made.token);
    expect((await api(session, "/api/me")).json<{ role: string }>().role).toBe("member"); // le rôle déjà donné ne change pas (pas de promotion par un vieux lien)
    expect(await (await import("../db/invitations.js")).createInvitationRepo(h.db).lookup(made.token)).not.toBeNull();
  });

  it("le rôle de l'invitation s'applique : un lecteur lit, ne peut pas agir", async () => {
    const { session } = await accept(await invite({ role: "viewer" }));
    expect((await api(session, "/api/tasks")).statusCode).toBe(200);
    expect((await api(session, "/api/tasks", "POST", { projectId: 1, issueIid: 1 })).statusCode).toBe(403);
    expect((await api(session, "/api/team")).statusCode).toBe(403); // l'équipe est réservée aux administrateurs
  });

  it("réservée à un compte de forge : un autre compte est refusé (et l'invitation reste intacte), le bon entre", async () => {
    const token = await invite({ role: "member", forgeLogin: "gitlab:bob" });
    who = { id: 777, username: "mallory", name: "Mallory", email: null };
    const wrong = await accept(token);
    expect(wrong.session).toBe("");
    expect(wrong.callback.headers.location).toBe("/login?error=invite");
    expect(await h.accounts.findUserByIdentity("gitlab", "777")).toBeUndefined();

    who = { id: 501, username: "BOB", name: "Bob", email: null }; // la casse du login ne compte pas
    expect((await accept(token)).session).not.toBe("");
  });

  it("réservée à une forge : le départ par l'autre forge est refusé tout de suite", async () => {
    const token = await invite({ forgeLogin: "github:bob" });
    const wrongForge = await app.inject({ method: "GET", url: `/invite/${token}/login/gitlab` });
    expect(wrongForge.headers.location).toBe("/login?error=invite");
    const page = (await app.inject({ method: "GET", url: `/invite/${token}` })).body;
    expect(page).toContain("github:bob");
    expect(page).toContain(`/invite/${token}/login/github`);
    expect(page).not.toContain(`/invite/${token}/login/gitlab`); // seul le bouton qui correspond est proposé
  });

  it("révoquée ou expirée : même page générique, aucun détail, aucune connexion possible", async () => {
    const repo = (await import("../db/invitations.js")).createInvitationRepo(h.db);
    const revoked = await createInvitation(), expired = await createInvitation();
    await repo.revoke(team, revoked.id);
    await h.db.run("UPDATE invitations SET expires_at = '2000-01-01 00:00:00' WHERE id = ?", [expired.id]);
    const pages = [];
    const overlong = await app.inject({ method: "GET", url: `/invite/${"x".repeat(150)}` }); // plus long que ce que le routeur accepte : 404 du serveur, rien de plus
    expect(overlong.statusCode).toBe(404);
    expect(overlong.body).not.toContain("Équipe Alpha");
    for (const token of [revoked.token, expired.token, "inventé", "x".repeat(90)]) {
      const page = await app.inject({ method: "GET", url: `/invite/${token}` });
      expect(page.statusCode).toBe(404);
      expect(page.body).toContain("n'est plus valable");
      expect(page.body).not.toContain("Équipe Alpha");
      pages.push(page.body);
      expect((await accept(token)).session).toBe("");
    }
    expect(new Set(pages).size).toBe(1); // exactement la même page dans tous les cas : on ne dit pas pourquoi
  });

  it("la page d'invitation échappe ce que d'autres ont écrit (espace, invité par, mot) et ne se met pas en cache ni ne divulgue le lien", async () => {
    await h.accounts.renameWorkspace(team, `<script>alert("espace")</script>`);
    await h.accounts.renameUser(admin, `<img src=x onerror=alert(1)>`);
    const token = await invite({ note: `"><script>alert('mot')</script>` });
    const res = await app.inject({ method: "GET", url: `/invite/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("<script>");
    expect(res.body).not.toContain("<img");
    expect(res.body).toContain("&lt;script&gt;alert(&quot;espace&quot;)");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.body).toContain('<meta name="referrer" content="no-referrer">');
    expect(res.body).toContain("membre");
    expect((await app.inject({ method: "GET", url: "/login" })).body).not.toContain(token);
  });

  it("sans invitation, une personne inconnue reste refusée comme avant ; le propriétaire se connecte comme avant", async () => {
    who = { id: 900, username: "intrus", name: "Intrus", email: null };
    const start = await app.inject({ method: "GET", url: "/auth/gitlab/login" });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const callback = await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${state}`, headers: { cookie: `ra_oauth=${cookieOf(start, "ra_oauth")}` } });
    expect(callback.headers.location).toBe("/login?error=refused");
    expect(await h.accounts.findUserByIdentity("gitlab", "900")).toBeUndefined();
  });

  it("la page de connexion explique l'échec d'une invitation sans rien dire du compte", async () => {
    const page = (await app.inject({ method: "GET", url: "/login?error=invite" })).body;
    expect(page).toContain("Cette invitation n'est pas valable");
    expect(page).toContain("Demande un nouveau lien");
  });

  it("changer d'espace : seulement vers un espace dont on est membre, et jamais pour un autre", async () => {
    const { session } = await accept(await invite({ role: "member" }));
    const other = await h.accounts.createWorkspace({ name: "Secret", kind: "team", adminUserId: admin });
    for (const id of [other, 999_999, 0, -1, "x", null]) {
      const res = await api(session, "/api/workspaces/active", "POST", { id });
      expect([400, 403], String(id)).toContain(res.statusCode);
    }
    expect((await api(session, "/api/me")).json<{ workspace: { id: number } }>().workspace.id).toBe(team); // rien n'a changé
    expect((await api(session, "/api/workspaces")).json<{ workspaces: Array<{ id: number }> }>().workspaces.map((w) => w.id)).toEqual([team]); // il ne voit pas l'espace des autres
    expect((await app.inject({ method: "POST", url: "/api/workspaces/active", headers: WRITE, payload: { id: team } })).statusCode).toBe(401); // sans session
  });
});

describe("limitation des tentatives de connexion", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    h.cleanup();
  });

  async function server(limit: number, trustProxy: boolean): Promise<FastifyInstance> {
    const auth = createAuthRuntime(AUTH, h.db, h.accounts, fakeForge(() => ({ id: 1, username: "x", name: "X", email: null })));
    auth.rateLimit = { limit, windowMs: 60_000 };
    const app = buildServer({ config: { ...h.config, server: { ...h.config.server, trustProxy } }, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local, auth, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0 });
    apps.push(app);
    await app.ready();
    return app;
  }

  it("au-delà de la limite, la connexion, son retour et les invitations répondent 429 avec le délai ; une autre adresse n'est pas touchée", async () => {
    const app = await server(3, false);
    const hit = (url: string, remoteAddress = "10.0.0.1") => app.inject({ method: "GET", url, remoteAddress });
    for (let i = 0; i < 3; i++) expect((await hit("/auth/gitlab/login")).statusCode).toBe(302);
    const blocked = await hit("/auth/gitlab/login");
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(blocked.body).toContain("Trop de tentatives");
    expect((await hit("/invite/n-importe-quoi")).statusCode).toBe(429); // le compteur est commun à la connexion, à son retour et aux invitations
    expect((await hit("/auth/gitlab/callback?code=x&state=y")).statusCode).toBe(429);
    expect((await hit("/auth/gitlab/login", "10.0.0.2")).statusCode).toBe(302); // une autre adresse a sa propre limite
  });

  it("la déconnexion, la page de connexion et l'API ne sont pas limitées", async () => {
    const app = await server(1, false);
    expect((await app.inject({ method: "GET", url: "/auth/gitlab/login", remoteAddress: "10.0.0.3" })).statusCode).toBe(302);
    expect((await app.inject({ method: "GET", url: "/auth/gitlab/login", remoteAddress: "10.0.0.3" })).statusCode).toBe(429);
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "POST", url: "/auth/logout", headers: WRITE, remoteAddress: "10.0.0.3" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/login", remoteAddress: "10.0.0.3" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/me", remoteAddress: "10.0.0.3" })).statusCode).toBe(401); // refusé par la connexion, pas par la limite
    }
  });

  it("sans proxy déclaré, X-Forwarded-For est ignoré (on ne peut pas changer d'adresse à volonté) ; avec TRUST_PROXY, il désigne le visiteur", async () => {
    const direct = await server(2, false);
    const spoof = (n: number) => direct.inject({ method: "GET", url: "/auth/gitlab/login", remoteAddress: "10.0.0.9", headers: { "x-forwarded-for": `203.0.113.${n}` } });
    expect([(await spoof(1)).statusCode, (await spoof(2)).statusCode, (await spoof(3)).statusCode]).toEqual([302, 302, 429]);

    const behind = await server(2, true);
    const visitor = (ip: string) => behind.inject({ method: "GET", url: "/auth/gitlab/login", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": ip } });
    expect([(await visitor("203.0.113.1")).statusCode, (await visitor("203.0.113.1")).statusCode, (await visitor("203.0.113.1")).statusCode]).toEqual([302, 302, 429]);
    expect((await visitor("203.0.113.2")).statusCode).toBe(302); // un autre visiteur derrière le même proxy
  });
});
