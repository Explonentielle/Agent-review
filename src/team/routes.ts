import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccountError, type AccountContext, type AccountRepo, type Role } from "../db/accounts.js";
import { currentMonth } from "../db/costs.js";
import { createRateLimiter } from "../auth/rateLimit.js";
import { readEmail } from "../auth/passwordLogin.js";
import type { SessionStore } from "../auth/sessions.js";
import { INVITATION_DAYS, type InvitationRepo } from "../db/invitations.js";
import { errorMessage, log } from "../logger.js";
import type { Mailer } from "../mail/mailer.js";
import { invitationMail } from "../mail/templates.js";
import type { TenantContext, TenantDeps } from "../tenants/manager.js";

/**
 * Gestion de l'équipe d'un espace : membres, rôles, invitations, limites par personne. Toutes ces routes sont réservées aux administrateurs de l'espace
 * (`auth/permissions.ts`). Une invitation par email part vers l'adresse de la personne (le lien n'est jamais montré à l'administrateur : seule la personne qui
 * lit cette boîte peut l'ouvrir). Sans adresse, c'est un lien à usage unique, à transmettre par le moyen de ton choix : il est affiché UNE fois.
 * Dans les deux cas la base n'en garde que l'empreinte.
 */
export interface TeamContext {
  /** Consommation et réglages de l'espace de la personne servie. */
  deps: Pick<TenantDeps, "settings" | "costs">;
  accounts: AccountRepo;
  /** Absent : l'outil sert un seul utilisateur local, personne ne peut être invité. */
  invitations?: InvitationRepo;
  /**
   * Connexion par compte (adresse publique pour construire le lien, sessions à fermer quand on retire quelqu'un, envoi d'emails si configuré).
   * Absente : pas d'invitation possible.
   */
  auth?: { publicUrl: string; sessions: SessionStore; mailer?: Mailer };
  /** Qui fait la requête : sa session, ou l'utilisateur local sans connexion. */
  whoIs: (req: FastifyRequest) => AccountContext;
  /** Appelée quand quelqu'un quitte l'espace ou en est retiré : arrête ses détecteurs et efface ses jetons de cet espace. */
  onMemberRemoved?: (who: TenantContext) => Promise<void>;
  /** Convertit une erreur inattendue en réponse. */
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
}

/**
 * Monte les routes de l'équipe.
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 * @returns Rien.
 */
export function registerTeam(app: FastifyInstance, ctx: TeamContext): void {
  const { deps, accounts, fail } = ctx;
  // Emails d'invitation : 20 par personne et par heure, 3 par adresse et par jour (un administrateur ne doit pas pouvoir inonder la boîte de quelqu'un)
  const mailByInviter = createRateLimiter(20, 3_600_000);
  const mailByAddress = createRateLimiter(3, 86_400_000);

  /** Une règle des comptes violée (dernier administrateur, rôle inconnu, invitation invalide...) est une erreur de la personne : 400, avec le message. */
  const failTeam = (reply: FastifyReply, err: unknown) => (err instanceof AccountError ? reply.code(400).send({ error: err.message }) : fail(reply, err));

  /** Identifiant de membre lu dans l'adresse, ou null s'il n'est pas un entier positif. */
  const memberId = (req: FastifyRequest<{ Params: { userId: string } }>): number | null => {
    const id = Number(req.params.userId);
    return Number.isInteger(id) && id > 0 ? id : null;
  };

  /** L'état de l'équipe : l'espace, ses membres (rôle, comptes de forge, limites, consommation) et les invitations en attente. */
  app.get("/api/team", async (req, reply) => {
    try {
      const who = ctx.whoIs(req);
      const [workspace, members, pending, settings] = await Promise.all([accounts.getWorkspace(who.workspaceId), accounts.listMembers(who.workspaceId), ctx.invitations?.listPending(who.workspaceId) ?? [], deps.settings.get()]);
      if (!workspace) return reply.code(404).send({ error: "Espace introuvable" });
      const month = currentMonth();
      return {
        workspace: { id: workspace.id, name: workspace.name, kind: workspace.kind },
        loginEnabled: Boolean(ctx.auth),
        canInvite: Boolean(ctx.auth && ctx.invitations) && workspace.kind === "team",
        canEmail: Boolean(ctx.auth?.mailer),
        agentAuth: settings.agentAuth,
        defaults: settings.quotas,
        members: await Promise.all(
          members.map(async (m) => ({
            userId: m.user_id,
            name: m.name,
            email: m.email,
            role: m.role,
            you: m.user_id === who.userId,
            joinedAt: m.created_at,
            identities: await accounts.listIdentities(m.user_id),
            quota: { budgetUsd: m.budget_usd === null ? null : Number(m.budget_usd), dailyRuns: m.daily_runs === null ? null : Number(m.daily_runs) },
            usage: { monthUsd: await deps.costs.userMonthTotal(m.user_id, month), runsToday: await deps.costs.userRunsToday(m.user_id) },
          })),
        ),
        invitations: pending.map((i) => ({ id: i.id, role: i.role, note: i.note, forgeLogin: i.forge_login, email: i.email, createdBy: i.created_by_name, createdAt: i.created_at, expiresAt: i.expires_at })),
      };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  /**
   * Crée une invitation. Avec une adresse email, le lien part par email et n'est jamais renvoyé ; sans adresse, il est renvoyé : c'est la seule fois où il est visible.
   * Si l'email ne part pas, l'invitation est révoquée aussitôt (pas de lien en circulation que personne n'a reçu).
   */
  app.post<{ Body: { role?: unknown; note?: unknown; forgeLogin?: unknown; email?: unknown; days?: unknown } | null }>("/api/team/invitations", async (req, reply) => {
    try {
      if (!ctx.auth || !ctx.invitations) return reply.code(409).send({ error: "Aucune connexion n'est configurée (variables AUTH_* ou RESEND_* du .env) : personne ne pourrait accepter l'invitation." });
      const who = ctx.whoIs(req);
      const body = req.body ?? {};
      const rawEmail = typeof body.email === "string" ? body.email.trim() : "";
      const email = rawEmail === "" ? null : readEmail(rawEmail);
      if (rawEmail !== "" && email === null) return reply.code(400).send({ error: "Adresse email invalide" });
      if (email !== null && !ctx.auth.mailer) return reply.code(409).send({ error: "L'envoi d'emails n'est pas configuré (RESEND_API_KEY et MAIL_FROM du .env) : crée un lien d'invitation, à transmettre à la main." });

      if (email !== null) {
        const existing = await accounts.getUserByEmail(email);
        if (existing && (await accounts.membershipRole(who.workspaceId, existing.id)) !== null) return reply.code(400).send({ error: "Cette personne est déjà membre de l'espace" });
        const byInviter = mailByInviter.take(String(who.userId));
        const byAddress = mailByAddress.take(email);
        if (!byInviter.ok || !byAddress.ok) return reply.code(429).send({ error: "Trop d'invitations envoyées : réessaie plus tard" });
      }

      const days = body.days === undefined ? INVITATION_DAYS : Number(body.days);
      const role = typeof body.role === "string" ? body.role : "";
      const note = typeof body.note === "string" ? body.note : "";
      const created = await ctx.invitations.create({
        workspaceId: who.workspaceId,
        role,
        note,
        forgeLogin: typeof body.forgeLogin === "string" ? body.forgeLogin : null,
        email,
        days,
        createdBy: who.userId,
      });
      const link = `${ctx.auth.publicUrl}/invite/${created.token}`;
      if (email === null) return { id: created.id, link, expiresAt: created.expiresAt };

      try {
        const [inviter, workspace] = await Promise.all([accounts.getUser(who.userId), accounts.getWorkspace(who.workspaceId)]);
        await ctx.auth.mailer!.send({ to: email, ...invitationMail({ invitedBy: inviter?.name ?? "Un administrateur", workspaceName: workspace?.name ?? "", role: role as Role, note: note.trim(), link, days }) });
      } catch (err) {
        log.warn("team.invite_mail_failed", { error: errorMessage(err) });
        await ctx.invitations.revoke(who.workspaceId, created.id);
        return reply.code(502).send({ error: "L'email n'a pas pu partir : l'invitation n'a pas été créée. Réessaie dans un moment, ou crée un lien à transmettre à la main." });
      }
      return { id: created.id, emailed: true, email, expiresAt: created.expiresAt };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/api/team/invitations/:id/revoke", async (req, reply) => {
    try {
      const id = Number(req.params.id);
      if (!ctx.invitations || !Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "Invitation invalide" });
      await ctx.invitations.revoke(ctx.whoIs(req).workspaceId, id);
      return { ok: true };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  /** Change le rôle d'un membre. Refusé si l'espace n'aurait plus d'administrateur. Prend effet tout de suite : le rôle est relu à chaque requête. */
  app.post<{ Params: { userId: string }; Body: { role?: unknown } | null }>("/api/team/members/:userId/role", async (req, reply) => {
    try {
      const userId = memberId(req);
      if (userId === null) return reply.code(400).send({ error: "Membre invalide" });
      await accounts.setRole(ctx.whoIs(req).workspaceId, userId, String(req.body?.role ?? "") as Role); // le dépôt des comptes refuse un rôle inconnu
      return { ok: true };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  /**
   * Retire un membre (ou quitte l'espace). Ses sessions dans cet espace sont fermées, ses détecteurs arrêtés et ses jetons de cet espace effacés. Refusé si c'est
   * le dernier administrateur.
   */
  app.post<{ Params: { userId: string } }>("/api/team/members/:userId/remove", async (req, reply) => {
    try {
      const userId = memberId(req);
      if (userId === null) return reply.code(400).send({ error: "Membre invalide" });
      const { workspaceId } = ctx.whoIs(req);
      await accounts.removeMember(workspaceId, userId);
      await ctx.auth?.sessions.deleteForMember(userId, workspaceId);
      await ctx.onMemberRemoved?.({ userId, workspaceId });
      return { ok: true };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  /** Fixe les limites propres à un membre : null reprend la valeur par défaut de l'espace, 0 ne limite pas. */
  app.post<{ Params: { userId: string }; Body: { budgetUsd?: unknown; dailyRuns?: unknown } | null }>("/api/team/members/:userId/quota", async (req, reply) => {
    try {
      const userId = memberId(req);
      if (userId === null) return reply.code(400).send({ error: "Membre invalide" });
      const value = (raw: unknown): number | null => (raw === null || raw === undefined || raw === "" ? null : Number(raw));
      await accounts.setMemberQuota(ctx.whoIs(req).workspaceId, userId, { budgetUsd: value(req.body?.budgetUsd), dailyRuns: value(req.body?.dailyRuns) });
      return { ok: true };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  /** Transforme l'espace personnel en espace d'équipe, pour pouvoir y inviter. Les données ne bougent pas. */
  app.post<{ Body: { name?: unknown } | null }>("/api/team/convert", async (req, reply) => {
    try {
      await accounts.convertToTeam(ctx.whoIs(req).workspaceId, typeof req.body?.name === "string" ? req.body.name : undefined);
      return { ok: true };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  app.post<{ Body: { name?: unknown } | null }>("/api/team/rename", async (req, reply) => {
    try {
      await accounts.renameWorkspace(ctx.whoIs(req).workspaceId, typeof req.body?.name === "string" ? req.body.name : "");
      return { ok: true };
    } catch (err) {
      return failTeam(reply, err);
    }
  });
}
