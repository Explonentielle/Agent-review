import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AccountRepo, Role } from "../db/accounts.js";
import type { InvitationLookup, InvitationRepo } from "../db/invitations.js";
import { errorMessage, log } from "../logger.js";
import { LoginRefusedError, signIn, type SignInPolicy } from "./login.js";
import { OAuthError, createPkce, type AuthProviderKind, type OAuthProvider } from "./oauth.js";
import { createRateLimiter } from "./rateLimit.js";
import type { SessionContext, SessionStore } from "./sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Session de connexion de la requête, ou null (toujours null hors mode connexion). */
    session: SessionContext | null;
  }
}

/** Ce dont le serveur a besoin pour gérer la connexion. */
export interface AuthRuntime {
  providers: Map<AuthProviderKind, OAuthProvider>;
  sessions: SessionStore;
  accounts: AccountRepo;
  /** Invitations à rejoindre un espace d'équipe (liens `/invite/<jeton>`). */
  invitations: InvitationRepo;
  policy: SignInPolicy;
  /** Adresse publique de l'outil, sans barre finale. */
  publicUrl: string;
  sessionDays: number;
  /** Tentatives de connexion et d'invitation permises par adresse IP et par fenêtre (par défaut 30 par 10 minutes). */
  rateLimit?: { limit: number; windowMs: number };
}

/** Cookie de session (HttpOnly : illisible par le JavaScript de la page). */
export const SESSION_COOKIE = "ra_session";
/** Cookie qui lie le retour OAuth au navigateur qui l'a demandé (sans lui, on pourrait connecter la victime au compte de l'attaquant). */
const STATE_COOKIE = "ra_oauth";
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;

const PROVIDER_NAMES: Record<AuthProviderKind, string> = { gitlab: "GitLab", github: "GitHub" };

interface PendingLogin {
  provider: AuthProviderKind;
  verifier: string;
  expires: number;
  /** Jeton de l'invitation si la connexion vient d'un lien d'invitation. */
  invite?: string;
}

const ROLE_NAMES: Record<Role, string> = { admin: "administrateur", member: "membre", viewer: "lecteur" };

/** Limite par défaut : 30 tentatives par adresse IP et par 10 minutes, pour la connexion, son retour et les invitations. */
const DEFAULT_RATE = { limit: 30, windowMs: 10 * 60_000 };

/**
 * Échappe un texte avant de l'écrire dans une page HTML (nom d'espace, mot d'accompagnement : saisis par d'autres personnes).
 * @param text Texte à écrire.
 * @returns Le texte, sans caractère qui puisse ouvrir une balise ou un attribut.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Lit les cookies d'une requête.
 * @param header En-tête `Cookie` brut, ou undefined.
 * @returns Les cookies par nom.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

/**
 * Construit un en-tête `Set-Cookie` sûr : HttpOnly, SameSite=Lax, limité au site, `Secure` quand l'adresse publique est en https.
 * @param name Nom du cookie.
 * @param value Valeur (caractères d'URL sûrs : les jetons sont en base64url).
 * @param maxAgeSeconds Durée de vie en secondes (0 pour l'effacer).
 * @param secure Vrai pour ajouter l'attribut Secure.
 * @returns La valeur de l'en-tête.
 */
function setCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/**
 * Compare deux textes en temps constant.
 * @param a Premier texte.
 * @param b Second texte.
 * @returns true s'ils sont identiques.
 */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Page de connexion : un bouton par forge configurée. Les styles passent par des classes.
 * @param providers Forges configurées.
 * @param error Code d'erreur éventuel (`refused` ou `failed`), jamais un texte libre.
 * @returns La page HTML.
 */
function loginPage(providers: AuthProviderKind[], error: string | undefined): string {
  const message = error === "refused" ? "Ce compte n'est pas autorisé sur cette installation."
    : error === "invite" ? "Cette invitation n'est pas valable pour ce compte (déjà utilisée, révoquée, expirée ou réservée à un autre compte). Demande un nouveau lien à l'administrateur."
      : error ? "La connexion a échoué. Réessaie." : "";
  return shell("Connexion", `<h1>Review agent</h1>
  <p>Connecte-toi avec ton compte de forge.</p>
  ${message ? `<div class="error" role="alert">${message}</div>` : ""}
  ${providers.map((p) => `<a class="btn" href="/auth/${p}/login">Se connecter avec ${PROVIDER_NAMES[p]}</a>`).join("\n  ")}`);
}

/**
 * Page d'accueil d'une invitation : qui invite, dans quel espace, avec quel rôle, et un bouton par forge. Tout texte saisi par une autre personne est échappé.
 * @param invitation L'invitation retrouvée par son jeton, ou null si elle n'est pas valable (même page pour tous les cas : on ne dit pas pourquoi).
 * @param token Jeton lu dans le lien (caractères d'URL sûrs).
 * @param providers Forges de connexion configurées.
 * @returns La page HTML.
 */
function invitePage(invitation: InvitationLookup | null, token: string, providers: AuthProviderKind[]): string {
  if (!invitation) {
    return shell("Invitation", `<h1>Invitation</h1>
  <div class="error" role="alert">Cette invitation n'est plus valable : elle a peut-être déjà été utilisée, révoquée, ou elle a expiré. Demande un nouveau lien à la personne qui t'a invité.</div>`);
  }
  const usable = providers.filter((p) => invitation.forgeLogin === null || invitation.forgeLogin.startsWith(`${p}:`));
  return shell("Invitation", `<h1>Tu es invité(e)</h1>
  <p>${escapeHtml(invitation.invitedBy)} t'invite à rejoindre l'espace <b>${escapeHtml(invitation.workspaceName)}</b> comme ${ROLE_NAMES[invitation.role]}.</p>
  ${invitation.note ? `<p class="note">${escapeHtml(invitation.note)}</p>` : ""}
  ${invitation.forgeLogin ? `<p class="note">Cette invitation est réservée au compte ${escapeHtml(invitation.forgeLogin)}.</p>` : ""}
  ${usable.map((p) => `<a class="btn" href="/invite/${encodeURIComponent(token)}/login/${p}">Accepter avec ${PROVIDER_NAMES[p]}</a>`).join("\n  ")}
  ${usable.length === 0 ? `<div class="error" role="alert">Aucune connexion ne correspond à cette invitation sur cette installation.</div>` : ""}`);
}

/**
 * Enveloppe commune des pages publiques (connexion, invitation) : mise en page et styles, sans style en ligne.
 * @param title Titre de l'onglet.
 * @param main Contenu de la carte (HTML déjà échappé).
 * @returns La page HTML.
 */
function shell(title: string, main: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --surface: #fff; --text: #1a1d23; --muted: #626b78; --accent: #2f5fd0; --danger: #b3261e; --border: #d6dae1; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14161a; --surface: #1d2025; --text: #e8eaee; --muted: #9aa3b0; --accent: #7aa2f7; --danger: #f2b8b5; --border: #343a44; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { width: min(420px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: var(--muted); }
  .error { color: var(--danger); margin-bottom: 14px; }
  .btn { display: block; margin-top: 10px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); color: var(--text); text-decoration: none; text-align: center; font-weight: 600; }
  .btn:hover, .btn:focus-visible { border-color: var(--accent); color: var(--accent); }
</style>
</head>
<body>
<main>
  ${main}
</main>
</body>
</html>`;
}

/**
 * Branche la connexion sur le serveur : contrôle d'accès de toutes les routes, page de connexion, aller-retour OAuth, déconnexion.
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

  app.decorateRequest("session", null);

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    // Essais en masse : la connexion, son retour et les liens d'invitation sont limités par adresse IP (la déconnexion ne l'est pas)
    if ((path.startsWith("/auth/") && path !== "/auth/logout") || path.startsWith("/invite/")) {
      const verdict = limiter.take(req.ip);
      if (!verdict.ok) {
        log.warn("auth.rate_limited", { path: path.startsWith("/invite/") ? "/invite/..." : path, ip: req.ip });
        return reply.code(429).header("Retry-After", String(verdict.retryAfterSeconds)).type("text/plain; charset=utf-8").send("Trop de tentatives de connexion : réessaie un peu plus tard.");
      }
    }
    req.session = await auth.sessions.resolve(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "");
    if (req.session || path === "/login" || path.startsWith("/auth/") || path.startsWith("/invite/")) return;
    if (path.startsWith("/api/")) return reply.code(401).send({ error: "Connexion requise" });
    return reply.redirect("/login");
  });

  /** Page d'une invitation : aucun détail n'est donné sur une invitation qui n'est pas valable (utilisée, révoquée, expirée ou inconnue : même page). */
  app.get<{ Params: { token: string } }>("/invite/:token", async (req, reply) => {
    const invitation = await auth.invitations.lookup(req.params.token);
    return reply.code(invitation ? 200 : 404).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").type("text/html; charset=utf-8").send(invitePage(invitation, req.params.token, [...auth.providers.keys()]));
  });

  /** Départ de la connexion d'une personne invitée : comme la connexion normale, mais le retour de la forge sait de quelle invitation il s'agit. */
  app.get<{ Params: { token: string; provider: string } }>("/invite/:token/login/:provider", async (req, reply) => {
    const provider = auth.providers.get(req.params.provider as AuthProviderKind);
    const invitation = await auth.invitations.lookup(req.params.token);
    if (!provider || !invitation) return reply.redirect("/login?error=invite");
    if (invitation.forgeLogin !== null && !invitation.forgeLogin.startsWith(`${provider.kind}:`)) return reply.redirect("/login?error=invite");
    return startLogin(reply, provider, req.params.token);
  });

  app.get<{ Querystring: { error?: string } }>("/login", async (req, reply) => {
    if (req.session) return reply.redirect("/");
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(loginPage([...auth.providers.keys()], req.query.error));
  });

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

  /** Change l'espace actif de la session. La personne doit être membre de l'espace demandé : sinon refus, et la session ne change pas. */
  app.post<{ Body: { id?: unknown } | null }>("/api/workspaces/active", async (req, reply) => {
    const id = Number(req.body?.id);
    if (!req.session || !Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "Espace invalide" });
    const switched = await auth.sessions.switchWorkspace(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "", id);
    if (!switched) return reply.code(403).send({ error: "Tu n'es pas membre de cet espace" });
    return { ok: true };
  });
}
