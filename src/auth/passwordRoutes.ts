import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccountError } from "../db/accounts.js";
import type { InvitationLookup } from "../db/invitations.js";
import { errorMessage, log } from "../logger.js";
import { alreadyRegisteredMail, resetMail, signupMail } from "../mail/templates.js";
import { SESSION_COOKIE, parseCookies, setCookie } from "./cookies.js";
import { LoginRefusedError, joinWithInvitation } from "./login.js";
import { PasswordError, checkPassword, hashPassword } from "./password.js";
import { createPasswordAccount, readEmail, signInWithPassword } from "./passwordLogin.js";
import { forgotPage, resetPage, signupCompletePage, signupPage, type InviteViewer } from "./pages.js";
import { createRateLimiter } from "./rateLimit.js";
import type { AuthRuntime, PasswordRuntime } from "./routes.js";
import type { SessionContext } from "./sessions.js";

/* Connexion par email et mot de passe : inscription confirmée par un lien reçu par email, connexion, mot de passe oublié, et acceptation d'une invitation par email.
   Le serveur ne crée jamais de compte sans que la personne ait ouvert un lien reçu à son adresse : pas de compte « en attente » à pirater, pas d'adresse non vérifiée. */

type PasswordAuth = AuthRuntime & { password: PasswordRuntime };

/** Validité des liens d'inscription et de nouveau mot de passe, en minutes. */
const LINK_MINUTES = 60;
const HOUR_MS = 3_600_000;

/**
 * Lit un champ texte du corps d'une requête (qui n'est pas fiable : n'importe quel type peut arriver).
 * @param body Corps de la requête.
 * @param name Nom du champ.
 * @param max Longueur maximale gardée.
 * @returns Le texte sans espaces autour, ou une chaîne vide.
 */
function field(body: unknown, name: string, max: number): string {
  const value = (body as Record<string, unknown> | null | undefined)?.[name];
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Ce que la page d'une invitation sait de la personne qui l'ouvre.
 * @param auth Connexion du serveur.
 * @param session Session de la requête, ou null.
 * @param invitation Invitation retrouvée, ou null.
 * @returns La personne connectée (nom et adresse) et si un compte avec mot de passe existe pour l'adresse de l'invitation.
 */
export async function inviteViewer(auth: AuthRuntime, session: SessionContext | null, invitation: InvitationLookup | null): Promise<InviteViewer> {
  const user = session ? await auth.accounts.getUser(session.userId) : undefined;
  let accountExists = false;
  if (auth.password && invitation?.email) {
    const existing = await auth.accounts.getUserByEmail(invitation.email);
    accountExists = existing !== undefined && (await auth.password.credentials.get(existing.id)) !== null;
  }
  return { signedIn: user ? { name: user.name, email: user.email } : null, accountExists };
}

/**
 * Monte les routes de la connexion par email et mot de passe.
 * @param app Serveur Fastify.
 * @param auth Connexion du serveur, avec l'envoi d'emails.
 * @param secure Vrai quand l'adresse publique est en https (cookie Secure).
 * @returns Rien.
 */
export function registerPasswordAuth(app: FastifyInstance, auth: PasswordAuth, secure: boolean): void {
  const { accounts, invitations, sessions, policy } = auth;
  const { mailer, credentials, tokens } = auth.password;
  // Courriels envoyés : au plus 10 demandes par adresse IP et par heure, 3 par adresse email (sinon on s'en servirait pour inonder la boîte de quelqu'un)
  const mailByIp = createRateLimiter(10, HOUR_MS);
  const mailByEmail = createRateLimiter(3, HOUR_MS);
  // Essais de mot de passe : 10 par adresse et par 15 minutes (la limite par IP de `routes.ts` s'ajoute)
  const loginByEmail = createRateLimiter(10, 15 * 60_000);

  const page = (reply: FastifyReply, html: string, code = 200) => reply.code(code).header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").type("text/html; charset=utf-8").send(html);
  const tooMany = (reply: FastifyReply, retryAfterSeconds: number, what: string) =>
    reply.code(429).header("Retry-After", String(retryAfterSeconds)).send({ error: `Trop de ${what} : réessaie dans ${Math.ceil(retryAfterSeconds / 60)} minute(s)` });

  /** Ouvre une session et pose le cookie. */
  const openSession = async (reply: FastifyReply, userId: number, workspaceId: number): Promise<void> => {
    const token = await sessions.create(userId, workspaceId);
    reply.header("Set-Cookie", setCookie(SESSION_COOKIE, token, auth.sessionDays * 86_400, secure));
  };

  /** Convertit une erreur de la personne (mot de passe, adresse, nom, invitation) en réponse 4xx ; les autres remontent en 500 sans détail. */
  const refuse = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PasswordError || err instanceof AccountError) return reply.code(400).send({ error: err.message });
    if (err instanceof LoginRefusedError) return reply.code(err.message.startsWith("Adresse email ou mot de passe") ? 401 : 409).send({ error: err.message });
    log.warn("auth.password_failed", { error: errorMessage(err) });
    return reply.code(500).send({ error: "La demande a échoué : réessaie dans un moment" });
  };

  // --- Pages ---------------------------------------------------------------------------------------------------------------------------------------------

  app.get("/signup", async (req, reply) => (req.session ? reply.redirect("/") : page(reply, signupPage(policy.signup === "open"))));
  app.get("/forgot", async (req, reply) => (req.session ? reply.redirect("/") : page(reply, forgotPage())));

  app.get<{ Params: { token: string } }>("/auth/signup/:token", async (req, reply) => {
    const target = await tokens.peek("signup", req.params.token);
    return page(reply, signupCompletePage(req.params.token, target?.email ?? null), target ? 200 : 404);
  });

  app.get<{ Params: { token: string } }>("/auth/reset/:token", async (req, reply) => {
    const target = await tokens.peek("reset", req.params.token);
    return page(reply, resetPage(req.params.token, target !== null), target ? 200 : 404);
  });

  // --- Inscription ---------------------------------------------------------------------------------------------------------------------------------------

  /**
   * Demande d'inscription : un lien part vers l'adresse, et la réponse est la même que l'adresse ait déjà un compte ou non (dans ce cas, c'est un autre email qui part).
   * Le compte n'est créé que quand la personne ouvre le lien.
   */
  app.post("/auth/signup", async (req, reply) => {
    const email = readEmail((req.body as Record<string, unknown> | null)?.email);
    if (!email) return reply.code(400).send({ error: "Adresse email invalide" });
    if (policy.signup !== "open" && email !== policy.owner) return reply.code(403).send({ error: "L'inscription se fait sur invitation d'un administrateur : ouvre le lien de ton invitation." });
    const byIp = mailByIp.take(req.ip);
    if (!byIp.ok) return tooMany(reply, byIp.retryAfterSeconds, "demandes");
    const byEmail = mailByEmail.take(email);
    if (!byEmail.ok) return tooMany(reply, byEmail.retryAfterSeconds, "demandes pour cette adresse");
    try {
      if (await accounts.getUserByEmail(email)) {
        await mailer.send({ to: email, ...alreadyRegisteredMail(`${auth.publicUrl}/login`, `${auth.publicUrl}/forgot`) });
      } else {
        const token = await tokens.create({ purpose: "signup", email, minutes: LINK_MINUTES });
        await mailer.send({ to: email, ...signupMail(`${auth.publicUrl}/auth/signup/${token}`, LINK_MINUTES) });
      }
    } catch (err) {
      log.warn("auth.mail_failed", { kind: "signup", error: errorMessage(err) });
      return reply.code(502).send({ error: "L'email n'a pas pu partir : réessaie dans un moment" });
    }
    return { ok: true, message: "Si cette adresse peut s'inscrire, un email vient de partir : il contient le lien pour choisir ton mot de passe." };
  });

  /** Fin de l'inscription : le lien reçu par email prouve l'adresse, la personne choisit son nom et son mot de passe. Le compte et son espace personnel sont créés. */
  app.post<{ Params: { token: string } }>("/auth/signup/:token", async (req, reply) => {
    try {
      const target = await tokens.peek("signup", req.params.token);
      if (!target) return reply.code(400).send({ error: "Ce lien n'est plus valable : refais la demande d'inscription" });
      const name = field(req.body, "name", 100);
      const password = (req.body as Record<string, unknown> | null)?.password;
      if (name === "") return reply.code(400).send({ error: "Indique ton nom" });
      if (typeof password !== "string") return reply.code(400).send({ error: "Choisis un mot de passe" });
      checkPassword(password, target.email); // avant de consommer le lien : un mot de passe refusé ne doit pas le brûler
      if (!(await tokens.consume("signup", req.params.token))) return reply.code(400).send({ error: "Ce lien vient d'être utilisé" });
      const signed = await createPasswordAccount(accounts, credentials, policy, { email: target.email, name, password }, true);
      await openSession(reply, signed.userId, signed.workspaceId);
      log.info("auth.signed_up", { userId: signed.userId });
      return { ok: true, redirect: "/" };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // --- Connexion et mot de passe oublié -------------------------------------------------------------------------------------------------------------------

  app.post("/auth/login", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    const key = readEmail(body?.email) ?? `ip:${req.ip}`;
    const tries = loginByEmail.take(key);
    if (!tries.ok) return tooMany(reply, tries.retryAfterSeconds, "essais pour ce compte");
    try {
      const signed = await signInWithPassword(accounts, credentials, body?.email, body?.password);
      loginByEmail.forget(key);
      await openSession(reply, signed.userId, signed.workspaceId);
      log.info("auth.signed_in", { provider: "password", userId: signed.userId });
      return { ok: true, redirect: "/" };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Mot de passe oublié : même réponse que l'adresse ait un compte ou non. Seuls les comptes qui ont un mot de passe reçoivent un lien (un compte de forge n'en a pas). */
  app.post("/auth/forgot", async (req, reply) => {
    const email = readEmail((req.body as Record<string, unknown> | null)?.email);
    if (!email) return reply.code(400).send({ error: "Adresse email invalide" });
    const byIp = mailByIp.take(req.ip);
    if (!byIp.ok) return tooMany(reply, byIp.retryAfterSeconds, "demandes");
    const byEmail = mailByEmail.take(email);
    if (!byEmail.ok) return tooMany(reply, byEmail.retryAfterSeconds, "demandes pour cette adresse");
    try {
      const user = await accounts.getUserByEmail(email);
      if (user && (await credentials.get(user.id)) !== null) {
        const token = await tokens.create({ purpose: "reset", email, userId: user.id, minutes: LINK_MINUTES });
        await mailer.send({ to: email, ...resetMail(`${auth.publicUrl}/auth/reset/${token}`, LINK_MINUTES) });
      }
    } catch (err) {
      log.warn("auth.mail_failed", { kind: "reset", error: errorMessage(err) }); // pas d'erreur visible : elle dirait que le compte existe
    }
    return { ok: true, message: "Si un compte existe avec cette adresse, un email vient de partir : il contient le lien pour choisir un nouveau mot de passe." };
  });

  /** Nouveau mot de passe : toutes les sessions du compte sont fermées (si quelqu'un d'autre y était connecté, il ne l'est plus). */
  app.post<{ Params: { token: string } }>("/auth/reset/:token", async (req, reply) => {
    try {
      const target = await tokens.peek("reset", req.params.token);
      if (!target || target.userId === null) return reply.code(400).send({ error: "Ce lien n'est plus valable : refais la demande" });
      const password = (req.body as Record<string, unknown> | null)?.password;
      if (typeof password !== "string") return reply.code(400).send({ error: "Choisis un mot de passe" });
      checkPassword(password, target.email);
      const hash = await hashPassword(password);
      const used = await tokens.consume("reset", req.params.token);
      if (!used || used.userId === null) return reply.code(400).send({ error: "Ce lien vient d'être utilisé" });
      await credentials.set(used.userId, hash);
      await sessions.deleteForUser(used.userId);
      log.info("auth.password_reset", { userId: used.userId });
      return { ok: true, redirect: "/login?notice=reset" };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  // --- Invitation par email -----------------------------------------------------------------------------------------------------------------------------

  /** Retrouve l'invitation d'une route, ou répond à sa place. Une route d'invitation par email ne sert que les invitations qui visent une adresse. */
  const emailInvitation = async (token: string, reply: FastifyReply): Promise<(InvitationLookup & { email: string }) | null> => {
    const found = await invitations.lookup(token);
    if (!found || found.email === null) {
      void reply.code(400).send({ error: "Cette invitation n'est plus valable (utilisée, révoquée ou expirée)" });
      return null;
    }
    return found as InvitationLookup & { email: string };
  };

  /**
   * Création du compte d'une personne invitée par email : elle a reçu le lien à son adresse, qui est donc confirmée. Elle reçoit son espace personnel et entre dans
   * l'organisation, qui devient son espace actif.
   */
  app.post<{ Params: { token: string } }>("/invite/:token/signup", async (req, reply) => {
    try {
      const found = await emailInvitation(req.params.token, reply);
      if (!found) return reply;
      if (await accounts.getUserByEmail(found.email)) return reply.code(409).send({ error: "Un compte existe déjà avec cette adresse : connecte-toi" });
      const name = field(req.body, "name", 100);
      const password = (req.body as Record<string, unknown> | null)?.password;
      if (name === "") return reply.code(400).send({ error: "Indique ton nom" });
      if (typeof password !== "string") return reply.code(400).send({ error: "Choisis un mot de passe" });
      checkPassword(password, found.email);
      const signed = await createPasswordAccount(accounts, credentials, policy, { email: found.email, name, password }, false);
      const workspaceId = await joinWithInvitation(accounts, { repo: invitations, token: req.params.token }, found, signed.userId);
      await openSession(reply, signed.userId, workspaceId);
      log.info("auth.signed_up", { userId: signed.userId, invited: true });
      return { ok: true, redirect: "/" };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /** Connexion d'une personne qui a déjà un compte avec l'adresse invitée : le mot de passe vérifié, elle entre dans l'organisation. */
  app.post<{ Params: { token: string } }>("/invite/:token/login", async (req, reply) => {
    try {
      const found = await emailInvitation(req.params.token, reply);
      if (!found) return reply;
      const tries = loginByEmail.take(found.email);
      if (!tries.ok) return tooMany(reply, tries.retryAfterSeconds, "essais pour ce compte");
      const signed = await signInWithPassword(accounts, credentials, found.email, (req.body as Record<string, unknown> | null)?.password);
      loginByEmail.forget(found.email);
      const workspaceId = await joinWithInvitation(accounts, { repo: invitations, token: req.params.token }, found, signed.userId);
      await openSession(reply, signed.userId, workspaceId);
      log.info("auth.signed_in", { provider: "password", userId: signed.userId, invited: true });
      return { ok: true, redirect: "/" };
    } catch (err) {
      return refuse(reply, err);
    }
  });

  /**
   * Acceptation d'une invitation par une personne déjà connectée. Une invitation par email ne vaut que pour le compte qui a cette adresse et un mot de passe (l'adresse
   * d'un compte de forge n'est pas confirmée) ; une invitation réservée à un compte de forge, que pour ce compte.
   */
  app.post<{ Params: { token: string } }>("/invite/:token/accept", async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    if (!req.session) return reply.code(401).send({ error: "Connexion requise" });
    try {
      const found = await invitations.lookup(req.params.token);
      if (!found) return reply.code(400).send({ error: "Cette invitation n'est plus valable (utilisée, révoquée ou expirée)" });
      const user = await accounts.getUser(req.session.userId);
      if (!user) return reply.code(401).send({ error: "Connexion requise" });
      if (found.email !== null) {
        if (user.email !== found.email || (await credentials.get(user.id)) === null) return reply.code(403).send({ error: "Cette invitation est pour un autre compte" });
      } else if (found.forgeLogin !== null) {
        const mine = (await accounts.listIdentities(user.id)).map((i) => `${i.provider}:${i.login.toLowerCase()}`);
        if (!mine.includes(found.forgeLogin)) return reply.code(403).send({ error: `Cette invitation est réservée au compte ${found.forgeLogin}` });
      }
      const workspaceId = await joinWithInvitation(accounts, { repo: invitations, token: req.params.token }, found, user.id);
      await sessions.switchWorkspace(parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? "", workspaceId);
      return { ok: true, redirect: "/" };
    } catch (err) {
      return refuse(reply, err);
    }
  });
}
