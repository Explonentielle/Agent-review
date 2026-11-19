import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInvitationRepo } from "../db/invitations.js";
import { MailError, createResendMailer, type Mail, type Mailer } from "../mail/mailer.js";
import { invitationMail } from "../mail/templates.js";
import { buildServer } from "../server/app.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { signIn } from "./login.js";
import { SESSION_COOKIE } from "./routes.js";
import { createAuthRuntime } from "./runtime.js";
import { hashPassword } from "./password.js";

const WRITE = { "x-review-agent": "1" };
const STRONG = "une phrase de passe longue";
const AUTH = { publicUrl: "https://review.example", gitlab: null, github: null, owner: "alex@example.com", allowedUsers: [] as string[], sessionDays: 7, mail: { apiKey: "cle-resend", from: "Review <no-reply@review.example>" }, signup: "invite" as "invite" | "open" };

describe("connexion par email et mot de passe", () => {
  let h: Harness;
  let app: FastifyInstance;
  let admin: number;
  let team: number;
  let sent: Mail[];
  let mailDown: boolean;
  const apps: FastifyInstance[] = [];

  /** Faux envoi d'emails : garde ce qui part, ou échoue à la demande. */
  const mailer: Mailer = {
    async send(mail) {
      if (mailDown) throw new MailError("Resend est injoignable");
      sent.push(mail);
    },
  };

  /** Serveur avec connexion par email (ou sans, si `withMail` est faux). */
  async function server(options: { signup?: "open" | "invite"; withMail?: boolean; rate?: { limit: number; windowMs: number } } = {}): Promise<FastifyInstance> {
    const config = { ...AUTH, signup: options.signup ?? "invite", ...(options.withMail === false ? { mail: null } : {}) };
    const auth = createAuthRuntime(config, h.db, h.accounts, undefined, options.withMail === false ? undefined : mailer);
    if (options.rate) auth.rateLimit = options.rate;
    const tenantDeps = { config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0 };
    const built = buildServer({ ...tenantDeps, accounts: h.accounts, local: h.local, auth, tenants: async () => tenantDeps });
    apps.push(built);
    await built.ready();
    return built;
  }

  const post = (url: string, payload: object = {}, cookie = "") => app.inject({ method: "POST", url, headers: { ...WRITE, ...(cookie ? { cookie } : {}) }, payload });
  const get = (url: string, cookie = "") => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  const cookieOf = (res: { headers: Record<string, unknown> }): string => {
    const raw = ([] as string[]).concat((res.headers["set-cookie"] as string | string[] | undefined) ?? []);
    const value = raw.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(";")[0]!.slice(SESSION_COOKIE.length + 1) ?? "";
    return value ? `${SESSION_COOKIE}=${value}` : "";
  };
  /** Chemin du lien contenu dans un email. */
  const linkOf = (mail: Mail | undefined): string => /https:\/\/review\.example(\/\S+)/.exec(mail?.text ?? "")?.[1] ?? "";
  const meOf = async (cookie: string) => (await get("/api/me", cookie)).json<{ user: { id: number; name: string }; workspace: { id: number; name: string; kind: string }; role: string }>();

  /** Crée un compte avec mot de passe, sans passer par l'inscription. */
  async function account(name: string, email: string, password = STRONG): Promise<number> {
    const id = await h.accounts.createUser({ name, email });
    await (await import("../db/credentials.js")).createCredentialRepo(h.db).set(id, await hashPassword(password));
    await h.accounts.createWorkspace({ name: `Espace de ${name}`, kind: "personal", adminUserId: id });
    return id;
  }

  /** Inscription complète d'une adresse : demande, lien reçu, nom et mot de passe. Rend le cookie de session. */
  async function signUp(email: string, name = "Nouveau", password = STRONG): Promise<string> {
    expect((await post("/auth/signup", { email })).statusCode).toBe(200);
    const link = linkOf(sent.at(-1));
    expect(link).toMatch(/^\/auth\/signup\//);
    const done = await post(link, { name, password });
    expect(done.statusCode, done.body).toBe(200);
    return cookieOf(done);
  }

  beforeEach(async () => {
    h = await createHarness();
    sent = [];
    mailDown = false;
    admin = h.local.userId;
    team = await h.accounts.createWorkspace({ name: "Équipe Alpha", kind: "team", adminUserId: admin });
    app = await server({ signup: "open" });
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    h.cleanup();
  });

  describe("inscription", () => {
    it("un lien reçu par email, puis nom et mot de passe : compte, espace personnel dont on est l'administrateur, session ouverte", async () => {
      const cookie = await signUp("Bob@Example.com", "Bob Martin");
      const me = await meOf(cookie);
      expect(me).toMatchObject({ user: { name: "Bob Martin" }, workspace: { kind: "personal" }, role: "admin" });
      const user = (await h.accounts.getUserByEmail("bob@example.com"))!;
      expect((await h.accounts.listWorkspacesOf(user.id)).map((w) => [w.kind, w.role])).toEqual([["personal", "admin"]]);
      const hash = await (await import("../db/credentials.js")).createCredentialRepo(h.db).get(user.id);
      expect(hash).toMatch(/^scrypt\$/);
      expect(hash).not.toContain(STRONG);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("bob@example.com");
    });

    it("le lien ne sert qu'une fois, et un mot de passe refusé ne le brûle pas", async () => {
      await post("/auth/signup", { email: "bob@example.com" });
      const link = linkOf(sent[0]);
      expect((await post(link, { name: "Bob", password: "court" })).statusCode).toBe(400);
      expect((await get(link)).statusCode).toBe(200); // le lien est toujours valable
      expect((await post(link, { name: "", password: STRONG })).statusCode).toBe(400);
      expect((await post(link, { name: "Bob", password: STRONG })).statusCode).toBe(200);
      expect((await post(link, { name: "Bob", password: STRONG })).statusCode).toBe(400);
      expect((await get(link)).statusCode).toBe(404);
      expect(await h.accounts.getUserByEmail("bob@example.com")).toBeDefined();
    });

    it("la page du lien montre l'adresse en lecture seule, échappée, sans style en ligne ; un lien inconnu donne la même page d'erreur", async () => {
      await post("/auth/signup", { email: "bob@example.com" });
      const page = (await get(linkOf(sent[0]))).body;
      expect(page).toContain('value="bob@example.com" readonly');
      expect(page).toContain('<script src="/auth/form.js" defer></script>');
      expect(page).not.toMatch(/style="/);
      const missing = await get("/auth/signup/inconnu");
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain("Ce lien n'est plus valable");
      expect((await get("/auth/signup/inconnu")).headers["cache-control"]).toBe("no-store");
    });

    it("sur invitation seulement : une adresse quelconque est refusée sans email, le propriétaire peut s'inscrire", async () => {
      app = await server({ signup: "invite" });
      expect((await post("/auth/signup", { email: "inconnu@example.com" })).statusCode).toBe(403);
      expect(sent).toEqual([]);
      expect((await post("/auth/signup", { email: "alex@example.com" })).statusCode).toBe(200);
      expect(sent).toHaveLength(1);
    });

    it("le propriétaire reprend le compte local et ses données en s'inscrivant avec son adresse ; un autre ne reprend rien", async () => {
      app = await server({ signup: "open" });
      const other = await signUp("autre@example.com", "Autre");
      expect((await meOf(other)).user.id).not.toBe(h.local.userId);
      const cookie = await signUp("alex@example.com", "Alex");
      const me = await meOf(cookie);
      expect(me.user).toEqual({ id: h.local.userId, name: "Alex" });
      expect(me.workspace.id).toBe(h.local.workspaceId);
    });

    it("une adresse qui a déjà un compte reçoit un autre email, la réponse est la même, et aucun lien d'inscription n'est créé", async () => {
      await account("Carol", "carol@example.com");
      const known = await post("/auth/signup", { email: "carol@example.com" });
      const fresh = await post("/auth/signup", { email: "nouveau@example.com" });
      expect(known.statusCode).toBe(200);
      expect(known.json()).toEqual(fresh.json());
      expect(sent[0]!.subject).toMatch(/déjà un compte/);
      expect(linkOf(sent[0])).toBe("/login");
      expect(Number((await h.db.get<{ n: number }>("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM email_tokens WHERE email = 'carol@example.com'"))!.n)).toBe(0);
    });

    it("des demandes répétées pour la même adresse sont limitées (3 par heure), sans inonder la boîte", async () => {
      for (let i = 0; i < 3; i++) expect((await post("/auth/signup", { email: "cible@example.com" })).statusCode).toBe(200);
      const fourth = await post("/auth/signup", { email: "cible@example.com" });
      expect(fourth.statusCode).toBe(429);
      expect(fourth.headers["retry-after"]).toBeDefined();
      expect(sent).toHaveLength(3);
    });

    it("si l'email ne part pas, la personne le sait ; une adresse invalide est refusée avant tout envoi", async () => {
      mailDown = true;
      expect((await post("/auth/signup", { email: "bob@example.com" })).statusCode).toBe(502);
      mailDown = false;
      expect((await post("/auth/signup", { email: "pas-une-adresse" })).statusCode).toBe(400);
      expect((await post("/auth/signup", { email: 12 })).statusCode).toBe(400);
      expect((await post("/auth/signup", {})).statusCode).toBe(400);
      expect(sent).toEqual([]);
    });
  });

  describe("connexion", () => {
    it("le bon mot de passe ouvre une session dans l'espace personnel ; la page de connexion propose le formulaire", async () => {
      await account("Carol", "carol@example.com");
      const res = await post("/auth/login", { email: " Carol@Example.com ", password: STRONG });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, redirect: "/" });
      expect(res.headers["set-cookie"]).toMatch(/HttpOnly/);
      expect((await meOf(cookieOf(res))).user.name).toBe("Carol");
      const page = (await get("/login")).body;
      expect(page).toContain('action="/auth/login"');
      expect(page).toContain('href="/forgot"');
      expect(page).toContain('href="/signup"'); // inscription ouverte
    });

    it("adresse inconnue, compte de forge sans mot de passe et mauvais mot de passe : la même réponse", async () => {
      await account("Carol", "carol@example.com");
      const forgeOnly = await h.accounts.createUser({ name: "Dan", email: "dan@example.com" });
      await h.accounts.linkIdentity(forgeOnly, "github", "9", "dan");
      const bodies = [] as string[];
      for (const [email, password] of [["carol@example.com", "mauvais mot de passe"], ["inconnu@example.com", STRONG], ["dan@example.com", STRONG], ["carol@example.com", ""], ["carol@example.com", 42]] as const) {
        const res = await post("/auth/login", { email, password });
        expect(res.statusCode, `${email} ${String(password)}`).toBe(401);
        bodies.push(res.body);
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).not.toContain("inconnu");
    });

    it("10 essais ratés sur une adresse la bloquent un moment, même avec le bon mot de passe ; une réussite remet le compteur à zéro", async () => {
      app = await server({ signup: "open", rate: { limit: 1000, windowMs: 600_000 } }); // la limite par adresse IP ne doit pas masquer celle par compte
      await account("Carol", "carol@example.com");
      for (let i = 0; i < 9; i++) await post("/auth/login", { email: "carol@example.com", password: "faux faux faux" });
      expect((await post("/auth/login", { email: "carol@example.com", password: STRONG })).statusCode).toBe(200); // le 10e essai passe et remet à zéro
      for (let i = 0; i < 9; i++) await post("/auth/login", { email: "carol@example.com", password: "faux faux faux" });
      expect((await post("/auth/login", { email: "carol@example.com", password: STRONG })).statusCode).toBe(200); // sans remise à zéro, ce 19e essai serait bloqué
      for (let i = 0; i < 10; i++) await post("/auth/login", { email: "carol@example.com", password: "faux faux faux" });
      const blocked = await post("/auth/login", { email: "carol@example.com", password: STRONG });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect((await post("/auth/login", { email: "autre@example.com", password: "faux" })).statusCode).toBe(401); // une autre adresse n'est pas touchée
    }, 30_000); // une trentaine de hachages scrypt : le délai par défaut (5 s) ne tient pas quand la machine est chargée

    it("toute écriture sans l'en-tête anti-CSRF est refusée, y compris la connexion", async () => {
      await account("Carol", "carol@example.com");
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "carol@example.com", password: STRONG } });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("mot de passe oublié", () => {
    it("un lien par email, un nouveau mot de passe, l'ancien refusé, les sessions ouvertes fermées, le lien à usage unique", async () => {
      await account("Carol", "carol@example.com");
      const session = cookieOf(await post("/auth/login", { email: "carol@example.com", password: STRONG }));
      expect((await get("/api/me", session)).statusCode).toBe(200);

      expect((await post("/auth/forgot", { email: "carol@example.com" })).statusCode).toBe(200);
      const link = linkOf(sent.at(-1));
      expect(link).toMatch(/^\/auth\/reset\//);
      expect((await post(link, { password: "court" })).statusCode).toBe(400);
      expect((await get(link)).statusCode).toBe(200); // un mot de passe refusé ne brûle pas le lien
      const done = await post(link, { password: "un autre mot de passe tout neuf" });
      expect(done.json()).toEqual({ ok: true, redirect: "/login?notice=reset" });
      expect((await post(link, { password: "encore un autre mot de passe" })).statusCode).toBe(400);

      expect((await get("/api/me", session)).statusCode).toBe(401); // la session d'avant est fermée
      expect((await post("/auth/login", { email: "carol@example.com", password: STRONG })).statusCode).toBe(401);
      expect((await post("/auth/login", { email: "carol@example.com", password: "un autre mot de passe tout neuf" })).statusCode).toBe(200);
    });

    it("même réponse pour une adresse inconnue ; un compte de forge, qui n'a pas de mot de passe, ne reçoit rien", async () => {
      const forgeOnly = await h.accounts.createUser({ name: "Dan", email: "dan@example.com" });
      await h.accounts.linkIdentity(forgeOnly, "github", "9", "dan");
      await account("Carol", "carol@example.com");
      const known = await post("/auth/forgot", { email: "carol@example.com" });
      const unknown = await post("/auth/forgot", { email: "inconnu@example.com" });
      const forge = await post("/auth/forgot", { email: "dan@example.com" });
      expect(known.json()).toEqual(unknown.json());
      expect(forge.json()).toEqual(unknown.json());
      expect(sent.map((m) => m.to)).toEqual(["carol@example.com"]);
    });

    it("si l'email ne part pas, la réponse ne le dit pas (elle révélerait que le compte existe)", async () => {
      await account("Carol", "carol@example.com");
      mailDown = true;
      const res = await post("/auth/forgot", { email: "carol@example.com" });
      expect(res.statusCode).toBe(200);
      expect(sent).toEqual([]);
    });
  });

  describe("invitation par email", () => {
    /** L'administrateur invite par email ; rend le chemin du lien reçu par l'invité. */
    async function inviteByEmail(email: string, extra: object = {}): Promise<{ status: number; path: string; body: Record<string, unknown> }> {
      const adminCookie = `${SESSION_COOKIE}=${await (await import("./sessions.js")).createSessionStore(h.db, 7).create(admin, team)}`;
      const res = await post("/api/team/invitations", { role: "member", email, ...extra }, adminCookie);
      return { status: res.statusCode, path: linkOf(sent.at(-1)), body: res.json<Record<string, unknown>>() };
    }

    it("le lien part à l'adresse seulement : l'administrateur ne le voit jamais", async () => {
      const made = await inviteByEmail("Dan@Example.com", { note: "Pour <b>Dan</b>" });
      expect(made.status).toBe(200);
      expect(made.body).toMatchObject({ emailed: true, email: "dan@example.com" });
      expect(JSON.stringify(made.body)).not.toContain("/invite/");
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe("dan@example.com");
      expect(sent[0]!.subject).toContain("Utilisateur local");
      expect(sent[0]!.text).toContain("Équipe Alpha");
      expect(sent[0]!.html).toContain("Pour &lt;b&gt;Dan&lt;/b&gt;"); // le mot d'accompagnement est échappé
      expect(sent[0]!.html).not.toContain("<b>Dan</b>");
      expect(sent[0]!.html).not.toMatch(/style="/);
      expect(made.path).toMatch(/^\/invite\/[A-Za-z0-9_-]{40,}$/);
    });

    it("une personne sans compte crée le sien depuis le lien : adresse imposée, espace personnel, entre dans l'équipe avec le rôle prévu", async () => {
      const { path } = await inviteByEmail("dan@example.com");
      const page = (await get(path)).body;
      expect(page).toContain('value="dan@example.com" readonly');
      expect(page).toContain(`action="${path}/signup"`);
      expect(page).not.toContain("Accepter avec GitHub");

      expect((await post(`${path}/signup`, { name: "Dan", password: "court" })).statusCode).toBe(400);
      const res = await post(`${path}/signup`, { name: "Dan", password: STRONG });
      expect(res.statusCode, res.body).toBe(200);
      const cookie = cookieOf(res);
      expect(await meOf(cookie)).toMatchObject({ user: { name: "Dan" }, workspace: { id: team, kind: "team" }, role: "member" });
      const dan = (await h.accounts.getUserByEmail("dan@example.com"))!;
      expect((await h.accounts.listWorkspacesOf(dan.id)).map((w) => [w.kind, w.role]).sort()).toEqual([["personal", "admin"], ["team", "member"]]);
      expect((await post(`${path}/signup`, { name: "Dan", password: STRONG })).statusCode).toBe(400); // le lien est consommé
      expect((await get(path)).statusCode).toBe(404);
    });

    it("une personne qui a déjà un compte se connecte depuis le lien et entre dans l'équipe ; elle garde son espace personnel", async () => {
      const dan = await account("Dan", "dan@example.com");
      const { path } = await inviteByEmail("dan@example.com", { role: "viewer" });
      expect((await get(path)).body).toContain(`action="${path}/login"`);
      expect((await post(`${path}/login`, { password: "mauvais mot de passe" })).statusCode).toBe(401);
      expect((await post(`${path}/signup`, { name: "Dan", password: STRONG })).statusCode).toBe(409); // le compte existe déjà
      const res = await post(`${path}/login`, { password: STRONG });
      expect(res.statusCode).toBe(200);
      expect(await meOf(cookieOf(res))).toMatchObject({ user: { id: dan }, workspace: { id: team }, role: "viewer" });
      expect((await h.accounts.listWorkspacesOf(dan)).map((w) => w.kind).sort()).toEqual(["personal", "team"]);
    });

    it("une personne déjà connectée accepte d'un clic, seulement si l'invitation est pour son adresse", async () => {
      const dan = await account("Dan", "dan@example.com");
      await account("Eve", "eve@example.com");
      const { path } = await inviteByEmail("dan@example.com");
      const eve = cookieOf(await post("/auth/login", { email: "eve@example.com", password: STRONG }));
      expect((await post(`${path}/accept`, {}, eve)).statusCode).toBe(403);
      expect((await get(path, eve)).body).toContain("Tu es connecté(e) avec un autre compte");
      expect((await post(`${path}/accept`, {})).statusCode).toBe(401); // sans session

      const danCookie = cookieOf(await post("/auth/login", { email: "dan@example.com", password: STRONG }));
      expect((await get(path, danCookie)).body).toContain(`action="${path}/accept"`);
      expect((await post(`${path}/accept`, {}, danCookie)).statusCode).toBe(200);
      expect((await meOf(danCookie)).workspace.id).toBe(team);
      expect(await h.accounts.membershipRole(team, dan)).toBe("member");
    });

    it("ne passe pas par une forge : la connexion d'un compte de forge est refusée pour une invitation par email", async () => {
      const { path } = await inviteByEmail("dan@example.com");
      const token = path.split("/").pop()!;
      const profile = { id: "501", login: "dan", name: "Dan", email: "dan@example.com" };
      await expect(signIn(h.accounts, { owner: "alex@example.com", allowedUsers: [], multiUser: true, signup: "open" }, "github", profile, { repo: createInvitationRepo(h.db), token })).rejects.toThrow(/envoyée par email/);
      expect(await h.accounts.findUserByIdentity("github", "501")).toBeUndefined(); // aucun compte créé
      const start = await get(`${path}/login/gitlab`);
      expect(start.headers.location).toBe("/login?error=invite");
      const forgeUser = await h.accounts.createUser({ name: "Forge", email: "dan2@example.com" });
      await h.accounts.linkIdentity(forgeUser, "github", "77", "forge");
      const forgeCookie = `${SESSION_COOKIE}=${await (await import("./sessions.js")).createSessionStore(h.db, 7).create(forgeUser, (await h.accounts.listWorkspacesOf(forgeUser))[0]?.id ?? (await h.accounts.createWorkspace({ name: "P", kind: "personal", adminUserId: forgeUser })))}`;
      expect((await post(`${path}/accept`, {}, forgeCookie)).statusCode).toBe(403);
    });

    it("si l'email ne part pas, l'invitation n'est pas créée ; sans envoi d'emails configuré, l'invitation par email est refusée", async () => {
      mailDown = true;
      const failed = await inviteByEmail("dan@example.com");
      expect(failed.status).toBe(502);
      expect(await createInvitationRepo(h.db).listPending(team)).toEqual([]);

      mailDown = false;
      app = await server({ withMail: false });
      const refused = await inviteByEmail("dan@example.com");
      expect(refused.status).toBe(409);
      expect(sent).toEqual([]);
    });

    it("refuse une adresse invalide, une personne déjà membre, et une adresse donnée avec un compte de forge", async () => {
      expect((await inviteByEmail("pas-une-adresse")).status).toBe(400);
      expect((await inviteByEmail("dan@example.com", { forgeLogin: "github:dan" })).status).toBe(400);
      const dan = await account("Dan", "dan@example.com");
      await h.accounts.addMember(team, dan, "member");
      const already = await inviteByEmail("dan@example.com");
      expect(already.status).toBe(400);
      expect(String(already.body.error)).toMatch(/déjà membre/);
      expect(sent).toEqual([]);
    });

    it("l'administrateur est limité à 3 invitations par adresse et par jour", async () => {
      for (let i = 0; i < 3; i++) expect((await inviteByEmail("dan@example.com")).status).toBe(200);
      expect((await inviteByEmail("dan@example.com")).status).toBe(429);
      expect(sent).toHaveLength(3);
    });
  });

  describe("créer une organisation", () => {
    it("toute personne connectée en crée une, en devient l'administratrice et elle devient son espace actif ; le nom est contrôlé", async () => {
      const cookie = await signUp("bob@example.com", "Bob");
      expect((await post("/api/workspaces", { name: "  " }, cookie)).statusCode).toBe(400);
      const res = await post("/api/workspaces", { name: " Studio Bob " }, cookie);
      expect(res.statusCode).toBe(200);
      const id = res.json<{ id: number }>().id;
      expect(await meOf(cookie)).toMatchObject({ workspace: { id, name: "Studio Bob", kind: "team" }, role: "admin" });
      expect((await post("/api/workspaces", { name: "X" })).statusCode).toBe(401); // sans session
    });

    it("même un lecteur ailleurs peut créer la sienne, sans rien changer à l'espace où il est lecteur", async () => {
      const dan = await account("Dan", "dan@example.com");
      await h.accounts.addMember(team, dan, "viewer");
      const sessions = (await import("./sessions.js")).createSessionStore(h.db, 7);
      const cookie = `${SESSION_COOKIE}=${await sessions.create(dan, team)}`;
      expect((await post("/api/settings", {}, cookie)).statusCode).toBe(403); // lecteur : pas de réglages
      expect((await post("/api/workspaces", { name: "Mon équipe" }, cookie)).statusCode).toBe(200);
      expect(await h.accounts.membershipRole(team, dan)).toBe("viewer");
    });

    it("le nombre d'organisations créées est limité", async () => {
      const cookie = await signUp("bob@example.com", "Bob");
      for (let i = 0; i < 10; i++) expect((await post("/api/workspaces", { name: `Orga ${i}` }, cookie)).statusCode).toBe(200);
      const res = await post("/api/workspaces", { name: "Une de trop" }, cookie);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/limite/);
    });
  });

  describe("sans envoi d'emails", () => {
    it("pas de formulaire de mot de passe, pas de pages d'inscription : l'installation reste sur les forges", async () => {
      app = await server({ withMail: false });
      expect((await get("/login")).body).not.toContain("/auth/login");
      expect((await get("/signup")).statusCode).toBe(302); // page inconnue : renvoyée vers la connexion
      expect((await post("/auth/signup", { email: "bob@example.com" })).statusCode).toBe(404);
      expect((await post("/auth/login", { email: "bob@example.com", password: STRONG })).statusCode).toBe(404);
    });
  });
});

describe("envoi par Resend", () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (status: number, body: unknown = { id: "e1" }): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  const mail = { to: "dan@example.com", subject: "Sujet\r\nBcc: x@evil.test", text: "t", html: "<p>h</p>" };

  beforeEach(() => void (calls.length = 0));

  it("un appel HTTPS à l'API Resend avec la clé en en-tête, jamais dans le corps ; un saut de ligne dans le sujet est neutralisé", async () => {
    await createResendMailer({ apiKey: "cle-secrete", from: "Review <no-reply@review.example>", fetchImpl: fakeFetch(200) }).send(mail);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cle-secrete");
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ from: "Review <no-reply@review.example>", to: ["dan@example.com"], text: "t", html: "<p>h</p>" });
    expect(body.subject).toBe("Sujet Bcc: x@evil.test");
    expect(JSON.stringify(body)).not.toContain("cle-secrete");
  });

  it("un refus de Resend donne une erreur lisible sans la clé ; un service injoignable aussi", async () => {
    const refused = createResendMailer({ apiKey: "cle-secrete", from: "a@b.fr", fetchImpl: fakeFetch(403, { name: "validation_error", message: "Le domaine n'est pas vérifié" }) });
    await expect(refused.send(mail)).rejects.toThrow(/HTTP 403.*domaine n'est pas vérifié/);
    const down = createResendMailer({ apiKey: "cle-secrete", from: "a@b.fr", fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    const err = await down.send(mail).catch((e: Error) => e);
    expect(err).toBeInstanceOf(MailError);
    expect((err as Error).message).not.toContain("cle-secrete");
  });

  it("le modèle d'invitation échappe les noms saisis par d'autres et met le lien en bouton", () => {
    const body = invitationMail({ invitedBy: "<img src=x>", workspaceName: "A & B", role: "viewer", note: "", link: "https://review.example/invite/abc", days: 7 });
    expect(body.html).not.toContain("<img");
    expect(body.html).toContain("A &amp; B");
    expect(body.html).toContain('href="https://review.example/invite/abc"');
    expect(body.text).toContain("lecteur");
  });
});
