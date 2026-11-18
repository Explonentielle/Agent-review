import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { AccountError, type AccountRepo } from "../db/accounts.js";
import type { CredentialRepo } from "../db/credentials.js";
import type { EmailTokenRepo } from "../db/emailTokens.js";
import type { InvitationRepo } from "../db/invitations.js";
import { errorMessage, log } from "../logger.js";
import type { Mailer } from "../mail/mailer.js";
import { SESSION_COOKIE, parseCookies, sameText, setCookie } from "./cookies.js";
import { LoginRefusedError, signIn, type SignInPolicy } from "./login.js";
import { OAuthError, createPkce, type AuthProviderKind, type OAuthProvider } from "./oauth.js";
import { FORM_SCRIPT, invitePage, loginPage } from "./pages.js";
import { inviteViewer, registerPasswordAuth } from "./passwordRoutes.js";
import { createRateLimiter } from "./rateLimit.js";
import type { SessionContext, SessionStore } from "./sessions.js";

export { SESSION_COOKIE, parseCookies } from "./cookies.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Session de connexion de la requête, ou null (toujours null hors mode connexion). */
    session: SessionContext | null;
  }
}

/** Connexion par email et mot de passe : active seulement quand l'envoi d'emails est configuré (c'est lui qui confirme les adresses). */
export interface PasswordRuntime {
  mailer: Mailer;
  credentials: CredentialRepo;
  /** Liens envoyés par email (inscription, mot de passe oublié). */
  tokens: EmailTokenRepo;
}

/** Ce dont le serveur a besoin pour gérer la connexion. */
export interface AuthRuntime {
  providers: Map<AuthProviderKind, OAuthProvider>;
  sessions: SessionStore;
  accounts: AccountRepo;
  /** Invitations à rejoindre un espace d'équipe (liens `/invite/<jeton>`). */
  invitations: InvitationRepo;
  policy: SignInPolicy;
  /** Connexion par email et mot de passe, ou absente (connexion par les forges seulement). */
  password?: PasswordRuntime;
  /** Adresse publique de l'outil, sans barre finale. */
  publicUrl: string;
  sessionDays: number;
  /** Tentatives de connexion et d'invitation permises par adresse IP et par fenêtre (par défaut 30 par 10 minutes). */
  rateLimit?: { limit: number; windowMs: number };
}

/** Cookie qui lie le retour OAuth au navigateur qui l'a demandé (sans lui, on pourrait connecter la victime au compte de l'attaquant). */
const STATE_COOKIE = "ra_oauth";
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;

/** Organisations d'équipe qu'une personne peut créer au plus : un compte ne doit pas pouvoir en fabriquer sans fin. */
export const MAX_CREATED_WORKSPACES = 10;

interface PendingLogin {
  provider: AuthProviderKind;
  verifier: string;
  expires: number;
  /** Jeton de l'invitation si la connexion vient d'un lien d'invitation. */
  invite?: string;
}

/** Limite par défaut : 30 tentatives par adresse IP et par 10 minutes, pour la connexion, son retour et les invitations. */
const DEFAULT_RATE = { limit: 30, windowMs: 10 * 60_000 };

/**
 * Branche la connexion sur le serveur : contrôle d'accès de toutes les routes, page de connexion, aller-retour OAuth, connexion par email, déconnexion.
 * Sans session valide, les routes `/api` répondent 401 et les pages renvoient vers `/login`.
 * @param app Serveur Fastify.
 * @param auth Fournisseurs, sessions et règles d'accès.
 * @returns Rien.
 */
export function registerAuth(app: FastifyInstance, auth: AuthRuntime): void {
  const secure = auth.publicUrl.startsWith("https://");
  const pending = new Map<string, PendingLogin>();
  const redirectUri = (provider: AuthProviderKind) => `${auth.publicUrl}/auth/${provider}/callback`;
  const limiter = createRateLimiter((auth.rateLimit ?? DEFAULT_RATE).limit, (auth.rateLimit ?? DEFAULT_RATE).windowMs);
  /** Pages publiques hors `/auth/` et `/invite/` : la connexion par email en ajoute deux. */
  const publicPages = new Set(auth.password ? ["/login", "/signup", "/forgot"] : ["/login"]);

  app.decorateRequest("session", null);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    // Essais en masse : la connexion, son retour et les liens d'invitation sont limités par adresse IP (la déconnexion et le script des formulaires ne le sont pas)
    if (((path.startsWith("/auth/") && path !== "/auth/logout" && path !== "/auth/form.js") || path.startsWith("/invite/"))) {
      const verdict = limiter.take(req.ip);
      if (!verdict.ok) {
        log.warn("auth.rate_limited", { path: path.startsWith("/invite/") ? "/invite/..." : path.startsWith("/auth/signup/") || path.startsWith("/auth/reset/") ? "/auth/.../..." : path, ip: req.ip });
        return reply.code(429).header("Retry-After", String(verdict.retryAfterSeconds)).type("text/plain; charset=utf-8").send("Trop de tentatives de connexion : réessaie un peu plus tard.");
      }
    }
    req.session = await auth.sessions.resolve(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "");
    if (req.session || publicPages.has(path) || path.startsWith("/auth/") || path.startsWith("/invite/")) return;
    if (path.startsWith("/api/")) return reply.code(401).send({ error: "Connexion requise" });
    return reply.redirect("/login");
  });

  /** Script commun des formulaires des pages publiques (envoi en JSON avec l'en-tête exigé de toute écriture). */
  app.get("/auth/form.js", async (_req, reply) => reply.header("Cache-Control", "public, max-age=300").type("text/javascript; charset=utf-8").send(FORM_SCRIPT));

  /** Page d'une invitation : aucun détail n'est donné sur une invitation qui n'est pas valable (utilisée, révoquée, expirée ou inconnue : même page). */
  app.get<{ Params: { token: string } }>("/invite/:token", async (req, reply) => {
    const invitation = await auth.invitations.lookup(req.params.token);
    const viewer = await inviteViewer(auth, req.session, invitation);
    return reply.code(invitation ? 200 : 404).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").type("text/html; charset=utf-8").send(invitePage(invitation, req.params.token, [...auth.providers.keys()], Boolean(auth.password), viewer));
  });

  /** Départ de la connexion d'une personne invitée : comme la connexion normale, mais le retour de la forge sait de quelle invitation il s'agit. */
  app.get<{ Params: { token: string; provider: string } }>("/invite/:token/login/:provider", async (req, reply) => {
    const provider = auth.providers.get(req.params.provider as AuthProviderKind);
    const invitation = await auth.invitations.lookup(req.params.token);
    if (!provider || !invitation || invitation.email !== null) return reply.redirect("/login?error=invite");
    if (invitation.forgeLogin !== null && !invitation.forgeLogin.startsWith(`${provider.kind}:`)) return reply.redirect("/login?error=invite");
    return startLogin(reply, provider, req.params.token);
  });

  app.get<{ Querystring: { error?: string; notice?: string } }>("/login", async (req, reply) => {
    if (req.session) return reply.redirect("/");
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(loginPage({ providers: [...auth.providers.keys()], password: Boolean(auth.password), signupOpen: auth.policy.signup === "open", error: req.query.error, notice: req.query.notice }));
  });

  if (auth.password) registerPasswordAuth(app, auth as AuthRuntime & { password: PasswordRuntime }, secure);

  /**
   * Démarre la connexion chez une forge : état à usage unique, cookie qui lie le retour à ce navigateur, vérificateur PKCE.
   * @param reply Réponse à rediriger vers la forge.
   * @param provider Forge choisie.
   * @param invite Jeton de l'invitation, si la connexion vient d'un lien d'invitation.
   * @returns La redirection vers la forge.
   */
  const startLogin = (reply: FastifyReply, provider: OAuthProvider, invite?: string) => {
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!); // jamais de croissance sans limite
    const state = randomBytes(24).toString("base64url");
    const pkce = createPkce();
    pending.set(state, { provider: provider.kind, verifier: pkce.verifier, expires: Date.now() + PENDING_TTL_MS, ...(invite ? { invite } : {}) });
    reply.header("Set-Cookie", setCookie(STATE_COOKIE, state, PENDING_TTL_MS / 1000, secure));
    return reply.redirect(provider.authorizeUrl({ redirectUri: redirectUri(provider.kind), state, codeChallenge: pkce.challenge }));
  };

  app.get<{ Params: { provider: string } }>("/auth/:provider/login", async (req, reply) => {
    const provider = auth.providers.get(req.params.provider as AuthProviderKind);
    if (!provider) return reply.code(404).send({ error: "Forge de connexion inconnue" });
    return startLogin(reply, provider);
  });

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>("/auth/:provider/callback", async (req, reply) => {
    const clearState = setCookie(STATE_COOKIE, "", 0, secure);
    const failed = (code: "failed" | "refused" | "invite") => reply.header("Set-Cookie", clearState).redirect(`/login?error=${code}`);

    const { code, state } = req.query;
    const provider = auth.providers.get(req.params.provider as AuthProviderKind);
    const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "";
    const login = state ? pending.get(state) : undefined;
    if (state) pending.delete(state); // un état ne sert qu'une fois
    if (!provider || req.query.error || !code || !state || !login || login.expires < Date.now() || login.provider !== provider.kind || !sameText(cookieState, state)) return failed("failed");

    try {
      const token = await provider.exchangeCode({ code, redirectUri: redirectUri(provider.kind), codeVerifier: login.verifier });
      const profile = await provider.fetchProfile(token);
      const target = await signIn(auth.accounts, auth.policy, provider.kind, profile, login.invite ? { repo: auth.invitations, token: login.invite } : undefined);
      const session = await auth.sessions.create(target.userId, target.workspaceId);
      log.info("auth.signed_in", { provider: provider.kind, login: profile.login, userId: target.userId, invited: Boolean(login.invite) });
      return reply.header("Set-Cookie", [clearState, setCookie(SESSION_COOKIE, session, auth.sessionDays * 86_400, secure)]).redirect("/");
    } catch (err) {
      if (err instanceof LoginRefusedError) {
        log.warn("auth.refused", { provider: provider.kind, reason: err.message });
        return failed(login.invite ? "invite" : "refused");
      }
      log.warn("auth.failed", { provider: provider.kind, error: err instanceof OAuthError ? err.message : errorMessage(err) });
      return failed("failed");
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    await auth.sessions.delete(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "");
    return reply.header("Set-Cookie", setCookie(SESSION_COOKIE, "", 0, secure)).send({ ok: true });
  });

  /** Les espaces de la personne connectée (et l'actif), pour passer de l'un à l'autre. */
  app.get("/api/workspaces", async (req) => {
    if (!req.session) return { active: null, workspaces: [] };
    const workspaces = await auth.accounts.listWorkspacesOf(req.session.userId);
    return { active: req.session.workspaceId, workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, kind: w.kind, role: w.role })) };
  });

  /**
   * Crée une organisation (espace d'équipe) dont la personne connectée est l'administratrice, et la rend active. Toute personne connectée peut en créer, quel que soit
   * son rôle ailleurs : l'organisation est à elle, elle n'agit sur aucune donnée d'un autre espace. Le nombre d'organisations créées est borné.
   */
  app.post<{ Body: { name?: unknown } | null }>("/api/workspaces", async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: "Connexion requise" });
    try {
      const mine = (await auth.accounts.listWorkspacesOf(req.session.userId)).filter((w) => w.kind === "team" && w.role === "admin").length;
      if (mine >= MAX_CREATED_WORKSPACES) throw new AccountError(`Tu administres déjà ${MAX_CREATED_WORKSPACES} organisations : c'est la limite`);
      const id = await auth.accounts.createWorkspace({ name: typeof req.body?.name === "string" ? req.body.name : "", kind: "team", adminUserId: req.session.userId });
      await auth.sessions.switchWorkspace(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "", id);
      return { ok: true, id };
    } catch (err) {
      if (err instanceof AccountError) return reply.code(400).send({ error: err.message });
      log.warn("auth.workspace_create_failed", { error: errorMessage(err) });
      return reply.code(500).send({ error: "La création a échoué" });
    }
  });

  /** Change l'espace actif de la session. La personne doit être membre de l'espace demandé : sinon refus, et la session ne change pas. */
  app.post<{ Body: { id?: unknown } | null }>("/api/workspaces/active", async (req, reply) => {
    const id = Number(req.body?.id);
    if (!req.session || !Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "Espace invalide" });
    const switched = await auth.sessions.switchWorkspace(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "", id);
    if (!switched) return reply.code(403).send({ error: "Tu n'es pas membre de cet espace" });
    return { ok: true };
  });
}
