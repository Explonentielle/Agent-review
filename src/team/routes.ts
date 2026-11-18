import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AccountError, type AccountContext, type AccountRepo, type Role } from "../db/accounts.js";
import { currentMonth } from "../db/costs.js";
import type { InvitationRepo } from "../db/invitations.js";
import type { SessionStore } from "../auth/sessions.js";
import type { TenantContext, TenantDeps } from "../tenants/manager.js";

/**
 * Gestion de l'équipe d'un espace : membres, rôles, invitations, limites par personne. Toutes ces routes sont réservées aux administrateurs de l'espace
 * (`auth/permissions.ts`). Une invitation est un lien à usage unique, à transmettre à la personne par le moyen de ton choix : il est affiché UNE fois,
 * la base n'en garde que l'empreinte.
 */
export interface TeamContext {
  /** Consommation et réglages de l'espace de la personne servie. */
  deps: Pick<TenantDeps, "settings" | "costs">;
  accounts: AccountRepo;
  /** Absent : l'outil sert un seul utilisateur local, personne ne peut être invité. */
  invitations?: InvitationRepo;
  /** Connexion par compte (adresse publique pour construire le lien, sessions à fermer quand on retire quelqu'un). Absente : pas d'invitation possible. */
  auth?: { publicUrl: string; sessions: SessionStore };
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
        invitations: pending.map((i) => ({ id: i.id, role: i.role, note: i.note, forgeLogin: i.forge_login, createdBy: i.created_by_name, createdAt: i.created_at, expiresAt: i.expires_at })),
      };
    } catch (err) {
      return failTeam(reply, err);
    }
  });

  /** Crée une invitation et renvoie son lien : c'est la seule fois où il est visible. */
  app.post<{ Body: { role?: unknown; note?: unknown; forgeLogin?: unknown; days?: unknown } | null }>("/api/team/invitations", async (req, reply) => {
    try {
      if (!ctx.auth || !ctx.invitations) return reply.code(409).send({ error: "La connexion par compte de forge n'est pas configurée (variables AUTH_* du .env) : personne ne pourrait accepter l'invitation." });
      const who = ctx.whoIs(req);
      const body = req.body ?? {};
      const created = await ctx.invitations.create({
        workspaceId: who.workspaceId,
        role: typeof body.role === "string" ? body.role : "",
        note: typeof body.note === "string" ? body.note : "",
        forgeLogin: typeof body.forgeLogin === "string" ? body.forgeLogin : null,
        ...(body.days === undefined ? {} : { days: Number(body.days) }),
        createdBy: who.userId,
      });
      return { id: created.id, link: `${ctx.auth.publicUrl}/invite/${created.token}`, expiresAt: created.expiresAt };
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
