import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { AccountError } from "../db/accounts.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "../server/app.js";
import { LoginRefusedError, signIn, type SignInPolicy } from "./login.js";
import { OAuthError, createGithubProvider, createGitlabProvider, createPkce } from "./oauth.js";
import { createAuthRuntime } from "./runtime.js";
import { SESSION_COOKIE } from "./routes.js";
import { createSessionStore } from "./sessions.js";

const WRITE = { "x-review-agent": "1" };
const GITLAB_LOGIN = { baseUrl: "https://gitlab.example", clientId: "client-gitlab", clientSecret: "secret-gitlab-a-ne-jamais-montrer" };
const AUTH = { publicUrl: "https://review.example", gitlab: GITLAB_LOGIN, github: { clientId: "client-github", clientSecret: "secret-github-a-ne-jamais-montrer" }, owner: "gitlab:alex", allowedUsers: [] as string[], sessionDays: 7 };

type Call = { url: string; init?: RequestInit };

/** Fausse forge : répond aux appels d'échange de code et de profil, et garde la trace des appels. */
function fakeForge(profile: () => Record<string, unknown>, calls: Call[] = [], token: () => Record<string, unknown> = () => ({ access_token: "jeton-d-acces-factice", token_type: "Bearer" })): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/oauth/token") || url.endsWith("/login/oauth/access_token")) return Response.json(token());
    if (url.endsWith("/api/v4/user") || url === "https://api.github.com/user") return Response.json(profile());
    return new Response("introuvable", { status: 404 });
  }) as typeof fetch;
}

describe("fournisseurs OAuth", () => {
  it("PKCE : l'empreinte est le SHA-256 du vérificateur", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(createPkce().verifier).not.toBe(verifier);
  });

  it("GitLab : adresse d'autorisation, échange du code avec le vérificateur, profil", async () => {
    const calls: Call[] = [];
    const provider = createGitlabProvider("https://gitlab.example", { clientId: "cid", clientSecret: "csecret", fetchImpl: fakeForge(() => ({ id: 42, username: "alex", name: "Alex D", email: "alex@example.com" }), calls) });

    const url = new URL(provider.authorizeUrl({ redirectUri: "https://review.example/auth/gitlab/callback", state: "etat", codeChallenge: "empreinte" }));
    expect(url.origin + url.pathname).toBe("https://gitlab.example/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: "https://review.example/auth/gitlab/callback",
      response_type: "code",
      scope: "read_user",
      state: "etat",
      code_challenge: "empreinte",
      code_challenge_method: "S256",
    });

    const token = await provider.exchangeCode({ code: "le-code", redirectUri: "https://review.example/auth/gitlab/callback", codeVerifier: "le-verificateur" });
    expect(token).toBe("jeton-d-acces-factice");
    const form = new URLSearchParams(String(calls[0]!.init!.body));
    expect(Object.fromEntries(form)).toMatchObject({ client_id: "cid", client_secret: "csecret", code: "le-code", grant_type: "authorization_code", code_verifier: "le-verificateur" });

    expect(await provider.fetchProfile(token)).toEqual({ id: "42", login: "alex", name: "Alex D", email: "alex@example.com" });
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer jeton-d-acces-factice");
  });

  it("GitHub : une réponse 200 qui contient une erreur est refusée, le profil sans nom prend le login", async () => {
    const refused = createGithubProvider({ clientId: "cid", clientSecret: "csecret", fetchImpl: fakeForge(() => ({}), [], () => ({ error: "bad_verification_code" })) });
    await expect(refused.exchangeCode({ code: "x", redirectUri: "https://r/cb", codeVerifier: "v" })).rejects.toThrow(OAuthError);

    const provider = createGithubProvider({ clientId: "cid", clientSecret: "csecret", fetchImpl: fakeForge(() => ({ id: 7, login: "carol", name: null, email: null })) });
    expect(await provider.fetchProfile("jeton")).toEqual({ id: "7", login: "carol", name: "carol", email: null });
    expect(new URL(provider.authorizeUrl({ redirectUri: "https://r/cb", state: "s", codeChallenge: "c" })).origin).toBe("https://github.com");
  });

  it("un jeton n'est accepté que d'une réponse réussie et non vide", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const exchange = (fetchImpl: typeof fetch) => createGitlabProvider("https://gitlab.example", { clientId: "c", clientSecret: "s", fetchImpl }).exchangeCode({ code: "x", redirectUri: "https://r/cb", codeVerifier: "v" });
    await expect(exchange(answer(500, { access_token: "jeton-dans-une-erreur" }))).rejects.toThrow(OAuthError);
    await expect(exchange(answer(200, { access_token: "" }))).rejects.toThrow(OAuthError);
    await expect(exchange(answer(200, { access_token: 12 }))).rejects.toThrow(OAuthError);
    await expect(exchange(answer(200, { access_token: "valide" }))).resolves.toBe("valide");
  });

  it("forge injoignable ou profil inutilisable : erreur claire, sans secret", async () => {
    const down = createGitlabProvider("https://gitlab.example", {
      clientId: "cid",
      clientSecret: "csecret-a-ne-pas-fuiter",
      fetchImpl: (async () => {
        throw new Error("connexion refusée csecret-a-ne-pas-fuiter");
      }) as typeof fetch,
    });
    const err = await down.exchangeCode({ code: "x", redirectUri: "https://r/cb", codeVerifier: "v" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as Error).message).not.toContain("csecret");

    const broken = createGitlabProvider("https://gitlab.example", { clientId: "c", clientSecret: "s", fetchImpl: fakeForge(() => ({ username: "sans-id" })) });
    await expect(broken.fetchProfile("jeton")).rejects.toThrow(/profil utilisable/);
  });
});

describe("sessions", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.cleanup());

  it("le jeton n'est jamais stocké, la session suit l'expiration et l'appartenance à l'espace", async () => {
    const sessions = createSessionStore(h.db, 7);
    const token = await sessions.create(h.local.userId, h.local.workspaceId);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(await h.db.all("SELECT * FROM sessions"))).not.toContain(token);
    expect(await sessions.resolve(token)).toEqual({ userId: h.local.userId, workspaceId: h.local.workspaceId, role: "admin" });
    expect(await sessions.resolve("jeton-inconnu")).toBeNull();
    expect(await sessions.resolve("")).toBeNull();

    await h.db.run("UPDATE sessions SET expires_at = '2000-01-01 00:00:00'");
    expect(await sessions.resolve(token)).toBeNull(); // expirée
    expect(await sessions.purgeExpired()).toBe(1);
    expect(await h.db.all("SELECT 1 FROM sessions")).toHaveLength(0);
  });

  it("une session cesse de valoir quand l'utilisateur quitte l'espace ; déconnexion et fermeture de toutes les sessions", async () => {
    const bob = await h.accounts.createUser({ name: "Bob" });
    const team = await h.accounts.createWorkspace({ name: "Équipe", kind: "team", adminUserId: h.local.userId });
    await h.accounts.addMember(team, bob, "member");
    const sessions = createSessionStore(h.db, 7);
    const a = await sessions.create(bob, team);
    const b = await sessions.create(bob, team);
    expect((await sessions.resolve(a))?.role).toBe("member");

    await h.accounts.removeMember(team, bob);
    expect(await sessions.resolve(a)).toBeNull();

    await h.accounts.addMember(team, bob, "viewer");
    expect((await sessions.resolve(b))?.role).toBe("viewer"); // le rôle suit l'appartenance actuelle
    await sessions.delete(b);
    expect(await sessions.resolve(b)).toBeNull();
    expect(await sessions.deleteForUser(bob)).toBe(1);
  });
});

describe("règles de connexion", () => {
  let h: Harness;
  const policy = (overrides: Partial<SignInPolicy> = {}): SignInPolicy => ({ owner: "gitlab:alex", allowedUsers: ["gitlab:bob", "github:carol"], multiUser: false, ...overrides });
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(() => h.cleanup());

  it("le propriétaire reprend le compte local et son espace, une seule fois", async () => {
    const signed = await signIn(h.accounts, policy(), "gitlab", { id: "1", login: "Alex", name: "Alex Dupont", email: null });
    expect(signed).toEqual({ userId: h.local.userId, workspaceId: h.local.workspaceId });
    expect(await h.accounts.getUser(h.local.userId)).toMatchObject({ name: "Alex Dupont" });
    expect((await h.accounts.findUserByIdentity("gitlab", "1"))?.id).toBe(h.local.userId);

    // Reconnexion : reconnu par l'identifiant numérique, même si le login change chez la forge
    const again = await signIn(h.accounts, policy({ owner: "gitlab:nouveau-login" }), "gitlab", { id: "1", login: "nouveau-login", name: "Alex", email: null });
    expect(again.userId).toBe(h.local.userId);
    expect(await h.db.get("SELECT login FROM identities WHERE provider_user_id = '1'")).toEqual({ login: "nouveau-login" });
  });

  it("tant que l'accès à plusieurs personnes n'est pas activé, personne d'autre ne se connecte, même autorisé", async () => {
    await expect(signIn(h.accounts, policy(), "gitlab", { id: "2", login: "bob", name: "Bob", email: null })).rejects.toThrow(LoginRefusedError);
    await expect(signIn(h.accounts, policy(), "github", { id: "9", login: "inconnu", name: "X", email: null })).rejects.toThrow(/pas encore activé/);
    expect(Number((await h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n)).toBe(1); // aucun compte créé
  });

  it("si l'accès à plusieurs personnes est refermé, un compte déjà créé ne peut plus se connecter", async () => {
    const open = policy({ multiUser: true });
    await signIn(h.accounts, open, "gitlab", { id: "1", login: "alex", name: "Alex", email: null });
    await signIn(h.accounts, open, "gitlab", { id: "2", login: "bob", name: "Bob", email: null });
    await expect(signIn(h.accounts, policy(), "gitlab", { id: "2", login: "bob", name: "Bob", email: null })).rejects.toThrow(LoginRefusedError);
    await expect(signIn(h.accounts, policy(), "gitlab", { id: "1", login: "alex", name: "Alex", email: null })).resolves.toMatchObject({ userId: h.local.userId });
  });

  it("accès multi-personnes : les personnes autorisées reçoivent leur espace personnel, les autres sont refusées", async () => {
    const open = policy({ multiUser: true });
    await signIn(h.accounts, open, "gitlab", { id: "1", login: "alex", name: "Alex", email: "alex@example.com" });

    const bob = await signIn(h.accounts, open, "gitlab", { id: "2", login: "Bob", name: "B".repeat(150), email: null });
    expect(bob.userId).not.toBe(h.local.userId);
    expect(bob.workspaceId).not.toBe(h.local.workspaceId);
    expect((await h.accounts.listWorkspacesOf(bob.userId)).map((w) => [w.kind, w.role])).toEqual([["personal", "admin"]]);
    expect((await h.accounts.getUser(bob.userId))?.name).toHaveLength(100); // nom tronqué, la connexion ne casse pas
    expect(await h.accounts.membershipRole(h.local.workspaceId, bob.userId)).toBeNull(); // aucun accès à l'espace du propriétaire

    await expect(signIn(h.accounts, open, "gitlab", { id: "3", login: "intrus", name: "Intrus", email: null })).rejects.toThrow(/pas autorisé/);
    // Même login, autre forge : la liste vise une forge précise
    await expect(signIn(h.accounts, open, "github", { id: "4", login: "bob", name: "Bob", email: null })).rejects.toThrow(/pas autorisé/);
    const carol = await signIn(h.accounts, open, "github", { id: "5", login: "carol", name: "Carol", email: null });
    expect(carol.userId).not.toBe(bob.userId);
  });

  it("aucun rapprochement par adresse email : une adresse déjà prise ne donne pas accès au compte de quelqu'un d'autre", async () => {
    const open = policy({ multiUser: true });
    const existing = await h.accounts.createUser({ name: "Déjà là", email: "partagee@example.com" });
    const bob = await signIn(h.accounts, open, "gitlab", { id: "2", login: "bob", name: "Bob", email: "partagee@example.com" });
    expect(bob.userId).not.toBe(existing);
    expect((await h.accounts.getUser(bob.userId))?.email).toBeNull();
    expect((await h.accounts.getUserByEmail("partagee@example.com"))?.id).toBe(existing);
    // Une adresse libre est gardée
    const carol = await signIn(h.accounts, open, "github", { id: "5", login: "carol", name: "Carol", email: "carol@example.com" });
    expect((await h.accounts.getUser(carol.userId))?.email).toBe("carol@example.com");
  });

  it("un compte de forge ne peut être lié qu'à un utilisateur", async () => {
    await h.accounts.linkIdentity(h.local.userId, "gitlab", "77", "x");
    const bob = await h.accounts.createUser({ name: "Bob" });
    await expect(h.accounts.linkIdentity(bob, "gitlab", "77", "x")).rejects.toThrow(AccountError);
    await expect(h.db.run("INSERT INTO identities (user_id, provider, provider_user_id, login) VALUES (?, 'bitbucket', '1', 'x')", [bob])).rejects.toThrow();
  });
});

describe("connexion sur le serveur", () => {
  let h: Harness;
  let app: ReturnType<typeof buildServer>;
  let profile: Record<string, unknown>;
  let calls: Call[];

  beforeEach(async () => {
    h = await createHarness();
    profile = { id: 1, username: "alex", name: "Alex" };
    calls = [];
    const auth = createAuthRuntime(AUTH, h.db, h.accounts, fakeForge(() => profile, calls));
    app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      auth, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    h.cleanup();
  });

  /** Cookies posés par une réponse, par nom (valeur) et en version brute (attributs). */
  const cookiesOf = (res: { headers: Record<string, unknown> }) => {
    const raw = ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? []);
    return { raw, value: (name: string) => raw.find((c) => c.startsWith(`${name}=`))?.split(";")[0]!.slice(name.length + 1) ?? "" };
  };

  /** Joue l'aller-retour complet : demande de connexion, puis retour de la forge avec le bon état. */
  async function signInThroughForge(provider = "gitlab") {
    const start = await app.inject({ method: "GET", url: `/auth/${provider}/login` });
    const authorize = new URL(start.headers.location as string);
    const state = authorize.searchParams.get("state")!;
    const callback = await app.inject({ method: "GET", url: `/auth/${provider}/callback?code=le-code&state=${state}`, headers: { cookie: `ra_oauth=${cookiesOf(start).value("ra_oauth")}` } });
    return { start, authorize, state, callback };
  }

  it("sans session : les pages renvoient vers /login, l'API répond 401, la page de connexion propose les forges", async () => {
    const page = await app.inject({ method: "GET", url: "/" });
    expect([page.statusCode, page.headers.location]).toEqual([302, "/login"]);
    expect((await app.inject({ method: "GET", url: "/api/stats" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: {} })).statusCode).toBe(401);

    const login = await app.inject({ method: "GET", url: "/login" });
    expect(login.statusCode).toBe(200);
    expect(login.headers["cache-control"]).toBe("no-store");
    expect(login.body).toContain('href="/auth/gitlab/login"');
    expect(login.body).toContain('href="/auth/github/login"');
    expect(login.body).not.toContain("style=");
    expect((await app.inject({ method: "GET", url: "/login?error=refused" })).body).toContain("pas autorisé");
    expect((await app.inject({ method: "GET", url: "/login?error=<script>alert(1)</script>" })).body).not.toContain("<script>alert");
    expect((await app.inject({ method: "GET", url: "/auth/bitbucket/login" })).statusCode).toBe(404);
  });

  it("aller-retour complet : état, PKCE, cookie de session sûr, puis accès à l'API en tant que propriétaire", async () => {
    const { start, authorize, state, callback } = await signInThroughForge();

    expect(start.statusCode).toBe(302);
    expect(authorize.origin + authorize.pathname).toBe("https://gitlab.example/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://review.example/auth/gitlab/callback");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cookiesOf(start).raw[0]).toMatch(/^ra_oauth=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe("/");
    const cookies = cookiesOf(callback);
    const session = cookies.raw.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(session).toMatch(new RegExp(`; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 86_400}; Secure$`));
    expect(cookies.raw.find((c) => c.startsWith("ra_oauth="))).toContain("Max-Age=0"); // cookie d'état effacé

    // Le vérificateur PKCE envoyé à la forge correspond à l'empreinte annoncée au départ
    const exchange = new URLSearchParams(String(calls.find((c) => c.url.endsWith("/oauth/token"))!.init!.body));
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(authorize.searchParams.get("code_challenge"));
    expect(state.length).toBeGreaterThanOrEqual(20);

    const headers = { cookie: `${SESSION_COOKIE}=${cookies.value(SESSION_COOKIE)}` };
    expect((await app.inject({ method: "GET", url: "/api/me", headers })).json()).toEqual({
      mode: "login",
      user: { id: h.local.userId, name: "Alex" },
      workspace: { id: h.local.workspaceId, name: "Espace local", kind: "personal" },
      role: "admin",
    });
    expect((await app.inject({ method: "GET", url: "/api/stats", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/", headers })).statusCode).toBe(200); // le dashboard est servi
    expect((await app.inject({ method: "GET", url: "/login", headers })).headers.location).toBe("/"); // déjà connecté
  });

  it("retour de la forge falsifié : état inconnu, rejoué, cookie absent ou d'un autre navigateur, refus de l'utilisateur", async () => {
    const first = await signInThroughForge();
    expect(first.callback.headers.location).toBe("/"); // légitime

    // Rejeu du même état : refusé (usage unique)
    const replay = await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${first.state}`, headers: { cookie: `ra_oauth=${first.state}` } });
    expect(replay.headers.location).toBe("/login?error=failed");

    // Attaque par injection de code : l'état existe côté serveur mais le navigateur de la victime n'a pas le cookie
    const start = await app.inject({ method: "GET", url: "/auth/gitlab/login" });
    const state = new URL(start.headers.location as string).searchParams.get("state")!;
    const noCookie = await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${state}` });
    expect(noCookie.headers.location).toBe("/login?error=failed");
    expect(cookiesOf(noCookie).raw.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes("Max-Age=0"))).toBe(false);
    // L'état a été consommé par la tentative : même avec le bon cookie ensuite, c'est refusé
    expect((await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${state}`, headers: { cookie: `ra_oauth=${state}` } })).headers.location).toBe("/login?error=failed");

    // État inventé, mauvais fournisseur, utilisateur qui refuse chez la forge
    expect((await app.inject({ method: "GET", url: "/auth/gitlab/callback?code=x&state=invente", headers: { cookie: "ra_oauth=invente" } })).headers.location).toBe("/login?error=failed");
    const github = await app.inject({ method: "GET", url: "/auth/github/login" });
    const githubState = new URL(github.headers.location as string).searchParams.get("state")!;
    expect((await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${githubState}`, headers: { cookie: `ra_oauth=${githubState}` } })).headers.location).toBe("/login?error=failed");
    const denied = await app.inject({ method: "GET", url: "/auth/gitlab/login" });
    const deniedState = new URL(denied.headers.location as string).searchParams.get("state")!;
    expect((await app.inject({ method: "GET", url: `/auth/gitlab/callback?error=access_denied&state=${deniedState}`, headers: { cookie: `ra_oauth=${deniedState}` } })).headers.location).toBe("/login?error=failed");
  });

  it("une demande de connexion abandonnée plus de dix minutes ne peut plus être terminée", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = await app.inject({ method: "GET", url: "/auth/gitlab/login" });
      const state = new URL(start.headers.location as string).searchParams.get("state")!;
      vi.setSystemTime(Date.now() + 11 * 60_000);
      const late = await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${state}`, headers: { cookie: `ra_oauth=${state}` } });
      expect(late.headers.location).toBe("/login?error=failed");

      const fresh = await app.inject({ method: "GET", url: "/auth/gitlab/login" });
      const freshState = new URL(fresh.headers.location as string).searchParams.get("state")!;
      vi.setSystemTime(Date.now() + 9 * 60_000);
      const ok = await app.inject({ method: "GET", url: `/auth/gitlab/callback?code=x&state=${freshState}`, headers: { cookie: `ra_oauth=${freshState}` } });
      expect(ok.headers.location).toBe("/");
    } finally {
      vi.useRealTimers();
    }
  });

  it("compte non autorisé : refusé, aucun utilisateur ni session créés", async () => {
    profile = { id: 99, username: "intrus", name: "Intrus" };
    const { callback } = await signInThroughForge();
    expect(callback.headers.location).toBe("/login?error=refused");
    expect(cookiesOf(callback).raw.some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.includes("Max-Age=0"))).toBe(false);
    expect(Number((await h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users"))!.n)).toBe(1);
    expect(await h.db.all("SELECT 1 FROM sessions")).toHaveLength(0);

    // Sans AUTH_ALLOWED_USERS l'installation reste à son propriétaire seul
    profile = { id: 2, username: "bob", name: "Bob" };
    expect((await signInThroughForge()).callback.headers.location).toBe("/login?error=refused");
  });

  it("déconnexion : en-tête anti-CSRF exigé, session fermée, cookie effacé", async () => {
    const { callback } = await signInThroughForge();
    const headers = { cookie: `${SESSION_COOKIE}=${cookiesOf(callback).value(SESSION_COOKIE)}` };
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/me", headers })).statusCode).toBe(200);

    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: { ...headers, ...WRITE } });
    expect(out.statusCode).toBe(200);
    expect(cookiesOf(out).raw[0]).toContain("Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/api/me", headers })).statusCode).toBe(401); // le jeton ne vaut plus rien
  });

  it("garde-fou : une session d'un autre espace n'est jamais servie par les dépôts de l'espace local", async () => {
    const bob = await h.accounts.createUser({ name: "Bob" });
    const bobSpace = await h.accounts.createWorkspace({ name: "Espace de Bob", kind: "personal", adminUserId: bob });
    const token = await createSessionStore(h.db, 7).create(bob, bobSpace);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };

    expect((await app.inject({ method: "GET", url: "/api/stats", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/tasks", headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/me", headers })).statusCode).toBe(403);
  });

  it("les secrets de l'application OAuth ne sont renvoyés par aucune route", async () => {
    const { callback } = await signInThroughForge();
    const headers = { cookie: `${SESSION_COOKIE}=${cookiesOf(callback).value(SESSION_COOKIE)}` };
    for (const url of ["/api/me", "/api/stats", "/api/settings", "/api/secrets", "/login"]) {
      const body = (await app.inject({ method: "GET", url, headers })).body;
      expect(body).not.toContain("secret-gitlab-a-ne-jamais-montrer");
      expect(body).not.toContain("secret-github-a-ne-jamais-montrer");
    }
  });
});

describe("configuration de la connexion", () => {
  const base = { GITLAB_URL: "https://gitlab.example", GITLAB_TOKEN: "t", GITLAB_USERNAME: "alex", DATA_DIR: "/tmp/x" };

  it("sans application OAuth : pas de connexion (mode local)", () => {
    expect(loadConfig(base).auth).toBeNull();
  });

  it("configurée : adresse publique, propriétaire et liste normalisés", () => {
    const config = loadConfig({
      ...base, AUTH_GITLAB_CLIENT_ID: "cid", AUTH_GITLAB_CLIENT_SECRET: "csecret", AUTH_OWNER: "GitLab:Alex", AUTH_ALLOWED_USERS: "gitlab:Bob, github:Carol ", PUBLIC_URL: "https://review.example/", SESSION_DAYS: "3",
    });
    expect(config.auth).toEqual({
      publicUrl: "https://review.example",
      gitlab: { baseUrl: "https://gitlab.example", clientId: "cid", clientSecret: "csecret" },
      github: null,
      owner: "gitlab:alex",
      allowedUsers: ["gitlab:bob", "github:carol"],
      sessionDays: 3,
      mail: null,
      signup: "invite",
    });
    expect(loadConfig({ ...base, AUTH_GITLAB_CLIENT_ID: "cid", AUTH_GITLAB_CLIENT_SECRET: "csecret", AUTH_OWNER: "gitlab:alex" }).auth?.publicUrl).toBe("http://localhost:4321");
  });

  it("incohérences refusées au démarrage", () => {
    const gitlab = { AUTH_GITLAB_CLIENT_ID: "cid", AUTH_GITLAB_CLIENT_SECRET: "csecret" };
    expect(() => loadConfig({ ...base, AUTH_GITLAB_CLIENT_ID: "cid" })).toThrow(/vont ensemble/);
    expect(() => loadConfig({ ...base, ...gitlab })).toThrow(/AUTH_OWNER est obligatoire/);
    expect(() => loadConfig({ ...base, ...gitlab, AUTH_OWNER: "pas-une-identite" })).toThrow(/forge:identifiant/);
    expect(() => loadConfig({ ...base, ...gitlab, AUTH_OWNER: "github:alex" })).toThrow(/connexion n'est pas configurée/);
    expect(() => loadConfig({ ...base, ...gitlab, AUTH_OWNER: "gitlab:alex", AUTH_ALLOWED_USERS: "bob" })).toThrow(/forge:identifiant/);
    expect(() => loadConfig({ GITHUB_TOKEN: "t", AUTH_GITLAB_CLIENT_ID: "c", AUTH_GITLAB_CLIENT_SECRET: "s", AUTH_OWNER: "gitlab:a", DATA_DIR: "/tmp/x" })).toThrow(/demande GITLAB_URL/);
    expect(() => loadConfig({ ...base, ...gitlab, AUTH_OWNER: "gitlab:alex", SESSION_DAYS: "0" })).toThrow(/SESSION_DAYS/);
  });

  it("des comptes configurés : les agents tournent en conteneurs, le mode machine est refusé ; sans comptes (poste local), il reste permis", () => {
    const gitlab = { AUTH_GITLAB_CLIENT_ID: "cid", AUTH_GITLAB_CLIENT_SECRET: "csecret", AUTH_OWNER: "gitlab:alex" };
    const mail = { RESEND_API_KEY: "re_cle_de_test", MAIL_FROM: "Outil <outil@exemple.test>", PUBLIC_URL: "https://review.example", AUTH_OWNER: "alex@example.com" };
    expect(loadConfig({ ...base, ...gitlab }).agentRuntime.mode).toBe("docker"); // défaut : jamais sur la machine
    expect(() => loadConfig({ ...base, ...gitlab, AGENT_RUNTIME: "host" })).toThrow(/AGENT_RUNTIME=host est refusé/);
    expect(() => loadConfig({ ...base, ...mail, AGENT_RUNTIME: "host" })).toThrow(/AGENT_RUNTIME=host est refusé/);
    expect(loadConfig({ ...base, ...gitlab, AGENT_RUNTIME: "docker" }).agentRuntime.mode).toBe("docker");
    expect(loadConfig({ ...base, AGENT_RUNTIME: "host" }).agentRuntime.mode).toBe("host"); // un seul utilisateur local, aucun compte
  });

  it("jeton d'abonnement du .env : sans espace, absent par défaut", () => {
    expect(loadConfig(base).claudeOauthToken).toBeNull();
    expect(loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "  sk-ant-oat01-DU-ENV-1234567  " }).claudeOauthToken).toBe("sk-ant-oat01-DU-ENV-1234567");
    expect(loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "" }).claudeOauthToken).toBeNull();
    expect(() => loadConfig({ ...base, CLAUDE_CODE_OAUTH_TOKEN: "deux mots" })).toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});
