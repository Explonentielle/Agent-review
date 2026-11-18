import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../auth/routes.js";
import { createAuthRuntime } from "../auth/runtime.js";
import { buildServer } from "../server/app.js";
import { createHarness, type Harness } from "../testing/harness.js";
import type { TenantContext } from "../tenants/manager.js";

const WRITE = { "x-review-agent": "1" };
const AUTH = { publicUrl: "https://review.example", gitlab: { baseUrl: "https://gitlab.example", clientId: "c", clientSecret: "s" }, github: null, owner: "gitlab:alex", allowedUsers: [] as string[], sessionDays: 7 };

type Team = {
  workspace: { id: number; name: string; kind: string };
  loginEnabled: boolean;
  canInvite: boolean;
  agentAuth: string;
  defaults: { perUserMonthlyUsd: number; perUserDailyRuns: number };
  members: Array<{ userId: number; name: string; role: string; you: boolean; identities: Array<{ provider: string; login: string }>; quota: { budgetUsd: number | null; dailyRuns: number | null }; usage: { monthUsd: number; runsToday: number } }>;
  invitations: Array<{ id: number; role: string; note: string; forgeLogin: string | null; createdBy: string; expiresAt: string }>;
};

describe("API de l'équipe", () => {
  let h: Harness;
  let team: number;
  let admin: number, member: number, viewer: number;
  let app: FastifyInstance;
  let removed: TenantContext[];
  const apps: FastifyInstance[] = [];
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    h = await createHarness();
    removed = [];
    admin = h.local.userId;
    team = await h.accounts.createWorkspace({ name: "Équipe Alpha", kind: "team", adminUserId: admin });
    member = await h.accounts.createUser({ name: "Membre" });
    viewer = await h.accounts.createUser({ name: "Lecteur" });
    await h.accounts.addMember(team, member, "member");
    await h.accounts.addMember(team, viewer, "viewer");
    await h.accounts.linkIdentity(member, "github", "42", "membre-dev");

    const auth = createAuthRuntime(AUTH, h.db, h.accounts);
    const tenantDeps = { config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0 };
    app = buildServer({ ...tenantDeps, accounts: h.accounts, local: h.local, auth, tenants: async () => tenantDeps, onMemberRemoved: async (who) => void removed.push(who) });
    apps.push(app);
    for (const [name, id] of [["admin", admin], ["member", member], ["viewer", viewer]] as const) cookies[name] = `${SESSION_COOKIE}=${await auth.sessions.create(id, team)}`;
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    h.cleanup();
  });

  const call = (who: "admin" | "member" | "viewer", method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: method === "POST" ? { cookie: cookies[who]!, ...WRITE } : { cookie: cookies[who]! }, payload: method === "POST" ? (payload ?? {}) : undefined });
  const teamOf = async () => (await call("admin", "GET", "/api/team")).json<Team>();

  it("l'état de l'équipe : membres avec rôle, comptes de forge, limites et consommation, invitations en attente, réglages par défaut", async () => {
    await h.settings.save({ ...(await h.settings.get()), quotas: { perUserMonthlyUsd: 20, perUserDailyRuns: 5 } });
    await h.accounts.setMemberQuota(team, member, { budgetUsd: 7, dailyRuns: null });
    const res = await call("admin", "POST", "/api/team/invitations", { role: "member", note: "Pour Dan", forgeLogin: "github:dan" });
    expect(res.statusCode).toBe(200);

    const state = await teamOf();
    expect(state).toMatchObject({ workspace: { id: team, name: "Équipe Alpha", kind: "team" }, loginEnabled: true, canInvite: true, defaults: { perUserMonthlyUsd: 20, perUserDailyRuns: 5 } });
    expect(state.members.map((m) => [m.name, m.role, m.you])).toEqual([["Utilisateur local", "admin", true], ["Membre", "member", false], ["Lecteur", "viewer", false]]);
    const bob = state.members.find((m) => m.userId === member)!;
    expect(bob.identities).toEqual([{ provider: "github", login: "membre-dev" }]);
    expect(bob.quota).toEqual({ budgetUsd: 7, dailyRuns: null });
    expect(bob.usage).toEqual({ monthUsd: 0, runsToday: 0 });
    expect(state.invitations).toHaveLength(1);
    expect(state.invitations[0]).toMatchObject({ role: "member", note: "Pour Dan", forgeLogin: "github:dan", createdBy: "Utilisateur local" });
    expect(JSON.stringify(state)).not.toMatch(/token|invite\//i); // jamais le jeton ni le lien dans la liste
  });

  it("toute l'équipe est réservée aux administrateurs : un membre et un lecteur reçoivent 403 sur chaque route", async () => {
    const routes: Array<["GET" | "POST", string, object?]> = [
      ["GET", "/api/team"], ["POST", "/api/team/invitations", { role: "member" }], ["POST", "/api/team/invitations/1/revoke"], ["POST", `/api/team/members/${member}/role`, { role: "admin" }],
      ["POST", `/api/team/members/${member}/remove`], ["POST", `/api/team/members/${member}/quota`, { dailyRuns: 1 }], ["POST", "/api/team/convert"], ["POST", "/api/team/rename", { name: "x" }],
    ];
    for (const who of ["member", "viewer"] as const) {
      for (const [method, url, payload] of routes) expect((await call(who, method, url, payload)).statusCode, `${who} ${method} ${url}`).toBe(403);
    }
    const state = await teamOf();
    expect(state.members.find((m) => m.userId === member)!.role).toBe("member"); // rien n'a bougé
    expect(removed).toEqual([]);
  });

  it("créer une invitation : le lien contient le jeton, la page marche, la liste ne le montre plus, et on peut la révoquer", async () => {
    const res = await call("admin", "POST", "/api/team/invitations", { role: "viewer", days: 3 });
    const { id, link, expiresAt } = res.json<{ id: number; link: string; expiresAt: string }>();
    expect(link).toMatch(/^https:\/\/review\.example\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(expiresAt > new Date().toISOString().slice(0, 19).replace("T", " ")).toBe(true);
    const page = await app.inject({ method: "GET", url: new URL(link).pathname });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("lecteur");

    expect((await teamOf()).invitations.map((i) => i.id)).toEqual([id]);
    expect((await call("admin", "POST", `/api/team/invitations/${id}/revoke`)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: new URL(link).pathname })).statusCode).toBe(404);
    expect((await teamOf()).invitations).toEqual([]);
    const again = await call("admin", "POST", `/api/team/invitations/${id}/revoke`);
    expect(again.statusCode).toBe(400);
    expect(again.json<{ error: string }>().error).toMatch(/introuvable ou déjà utilisée/);
  });

  it("les invitations invalides sont refusées avec une raison, sans rien créer", async () => {
    for (const bad of [{ role: "root" }, {}, { role: "member", forgeLogin: "pas-une-forge" }, { role: "member", days: 0 }, { role: "member", days: 99 }, { role: "member", days: "beaucoup" }, { role: "member", note: "x".repeat(201) }]) {
      const res = await call("admin", "POST", "/api/team/invitations", bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json<{ error: string }>().error.length).toBeGreaterThan(5);
    }
    expect((await call("admin", "POST", "/api/team/invitations/abc/revoke")).statusCode).toBe(400);
    expect((await teamOf()).invitations).toEqual([]);
  });

  it("changer un rôle prend effet tout de suite ; l'espace garde toujours un administrateur", async () => {
    expect((await call("member", "POST", "/api/settings", {})).statusCode).toBe(403); // membre : pas de réglages
    expect((await call("admin", "POST", `/api/team/members/${member}/role`, { role: "admin" })).statusCode).toBe(200);
    expect((await call("member", "POST", "/api/settings", { x: 1 })).statusCode).toBe(400); // plus refusé par les droits : la validation des réglages répond
    expect((await call("admin", "POST", `/api/team/members/${member}/role`, { role: "viewer" })).statusCode).toBe(200);
    expect((await call("member", "POST", "/api/tasks", { projectId: 1, issueIid: 1 })).statusCode).toBe(403);

    for (const bad of [{ role: "root" }, {}, { role: 5 }]) expect((await call("admin", "POST", `/api/team/members/${viewer}/role`, bad)).statusCode, JSON.stringify(bad)).toBe(400);
    for (const id of ["abc", "0", "-3", "1.5"]) expect((await call("admin", "POST", `/api/team/members/${id}/role`, { role: "member" })).statusCode, id).toBe(400);
    const last = await call("admin", "POST", `/api/team/members/${admin}/role`, { role: "member" });
    expect(last.statusCode).toBe(400);
    expect(last.json<{ error: string }>().error).toContain("dernier administrateur");
    expect((await teamOf()).members.find((m) => m.userId === admin)!.role).toBe("admin");
  });

  it("retirer un membre : ses sessions de cet espace se ferment, ses détecteurs et jetons sont nettoyés, et le dernier administrateur reste", async () => {
    expect((await call("member", "GET", "/api/tasks")).statusCode).toBe(200);
    expect((await call("admin", "POST", `/api/team/members/${member}/remove`)).statusCode).toBe(200);
    expect(removed).toEqual([{ userId: member, workspaceId: team }]);
    expect((await call("member", "GET", "/api/tasks")).statusCode).toBe(401); // sa session ne vaut plus
    expect(await h.db.all("SELECT 1 FROM sessions WHERE user_id = ? AND workspace_id = ?", [member, team])).toHaveLength(0);
    expect((await teamOf()).members.map((m) => m.userId)).toEqual([admin, viewer]);

    const last = await call("admin", "POST", `/api/team/members/${admin}/remove`);
    expect(last.statusCode).toBe(400);
    expect(last.json<{ error: string }>().error).toContain("dernier administrateur");
    expect((await call("admin", "POST", `/api/team/members/${member}/remove`)).statusCode).toBe(400); // déjà retiré
    expect(removed).toHaveLength(1); // les refus ne nettoient rien
  });

  it("retirer quelqu'un ne ferme pas ses sessions dans un AUTRE espace", async () => {
    const other = await h.accounts.createWorkspace({ name: "Autre", kind: "team", adminUserId: member });
    const auth = createAuthRuntime(AUTH, h.db, h.accounts);
    const elsewhere = await auth.sessions.create(member, other);
    await call("admin", "POST", `/api/team/members/${member}/remove`);
    expect(await auth.sessions.resolve(elsewhere.valueOf())).toMatchObject({ userId: member, workspaceId: other });
  });

  it("l'administrateur d'un espace ne touche que SES membres : un identifiant d'un autre espace est refusé", async () => {
    const stranger = await h.accounts.createUser({ name: "Étranger" });
    await h.accounts.createWorkspace({ name: "Ailleurs", kind: "team", adminUserId: stranger });
    for (const [url, payload] of [[`/api/team/members/${stranger}/role`, { role: "viewer" }], [`/api/team/members/${stranger}/remove`, {}], [`/api/team/members/${stranger}/quota`, { dailyRuns: 1 }]] as const) {
      expect((await call("admin", "POST", url, payload)).statusCode, url).toBe(400);
    }
    expect(removed).toEqual([]);
    expect((await h.accounts.listWorkspacesOf(stranger)).map((w) => w.role)).toEqual(["admin"]); // il est toujours administrateur chez lui
  });

  it("les limites d'un membre : fixées, reprises par défaut (null ou vide), sans limite (0), validées", async () => {
    const quota = (payload: object) => call("admin", "POST", `/api/team/members/${member}/quota`, payload);
    expect((await quota({ budgetUsd: 12.5, dailyRuns: 4 })).statusCode).toBe(200);
    expect((await teamOf()).members.find((m) => m.userId === member)!.quota).toEqual({ budgetUsd: 12.5, dailyRuns: 4 });
    expect((await quota({ budgetUsd: 0, dailyRuns: "" })).statusCode).toBe(200); // 0 : sans limite ; vide : la valeur de l'espace
    expect((await teamOf()).members.find((m) => m.userId === member)!.quota).toEqual({ budgetUsd: 0, dailyRuns: null });
    expect((await quota({})).statusCode).toBe(200);
    expect((await teamOf()).members.find((m) => m.userId === member)!.quota).toEqual({ budgetUsd: null, dailyRuns: null });
    for (const bad of [{ budgetUsd: -5 }, { dailyRuns: 2.5 }, { budgetUsd: "beaucoup" }, { dailyRuns: 5000 }]) expect((await quota(bad)).statusCode, JSON.stringify(bad)).toBe(400);
  });

  it("transformer un espace personnel en équipe, puis le renommer", async () => {
    const personal = await h.accounts.createWorkspace({ name: "Chez Zoé", kind: "personal", adminUserId: member });
    const auth = createAuthRuntime(AUTH, h.db, h.accounts);
    cookies.zoe = `${SESSION_COOKIE}=${await auth.sessions.create(member, personal)}`;
    const asZoe = (url: string, payload: object = {}) => app.inject({ method: "POST", url, headers: { cookie: cookies.zoe!, ...WRITE }, payload });
    const stateOf = async () => (await app.inject({ method: "GET", url: "/api/team", headers: { cookie: cookies.zoe! } })).json<Team>();

    expect(await stateOf()).toMatchObject({ workspace: { kind: "personal" }, canInvite: false }); // on n'invite pas dans un espace personnel
    expect((await asZoe("/api/team/invitations", { role: "member" })).statusCode).toBe(400);
    expect((await asZoe("/api/team/convert", { name: "Équipe de Zoé" })).statusCode).toBe(200);
    expect(await stateOf()).toMatchObject({ workspace: { kind: "team", name: "Équipe de Zoé" }, canInvite: true });
    expect((await asZoe("/api/team/invitations", { role: "member" })).statusCode).toBe(200);
    expect((await asZoe("/api/team/convert")).statusCode).toBe(400); // déjà une équipe
    expect((await asZoe("/api/team/rename", { name: "  Nouveau nom " })).statusCode).toBe(200);
    expect((await stateOf()).workspace.name).toBe("Nouveau nom");
    for (const name of ["", "   ", "x".repeat(101), 42]) expect((await asZoe("/api/team/rename", { name })).statusCode, String(name)).toBe(400);
  });

  it("sans connexion par compte : l'équipe se consulte, mais personne ne peut être invité (le message dit pourquoi)", async () => {
    const local = buildServer({ config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0 });
    apps.push(local);
    const state = (await local.inject({ method: "GET", url: "/api/team" })).json<Team>();
    expect(state).toMatchObject({ loginEnabled: false, canInvite: false });
    const res = await local.inject({ method: "POST", url: "/api/team/invitations", headers: WRITE, payload: { role: "member" } });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain("AUTH_");
  });
});
