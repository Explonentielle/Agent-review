import type { FastifyInstance, FastifyReply } from "fastify";
import { errorMessage, log } from "../logger.js";
import { SecretError } from "../secrets/crypto.js";
import type { TenantDeps } from "../tenants/manager.js";
import { WEBHOOK_SECRET, parseWebhook, type WebhookService } from "./webhook.js";

/** Ce que les routes des notifications empruntent au serveur. */
export interface NotifyContext {
  /** Coffre et expéditeur de la personne servie (résolus à chaque requête). */
  deps: Pick<TenantDeps, "vault" | "notifier">;
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
}

/** État du webhook d'une personne : jamais son adresse. */
export interface NotifyStatus {
  configured: boolean;
  service: WebhookService | null;
  updatedAt: string | null;
}

/**
 * Routes des notifications : où la personne reçoit les messages de l'outil (plan arrêté ou terminé, MR à fusionner, review à analyser). L'adresse du webhook
 * est un secret chiffré dans son coffre (comme un jeton) : elle s'enregistre et se supprime ici, et n'est jamais renvoyée.
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 * @returns Rien.
 */
export function registerNotify(app: FastifyInstance, ctx: NotifyContext): void {
  const { fail } = ctx;

  /**
   * Dit si un webhook est enregistré, sans révéler son adresse.
   * @returns Le service reconnu et la date de saisie.
   */
  async function status(): Promise<NotifyStatus> {
    const { vault } = ctx.deps;
    const stored = (await vault.store.list(vault.scope)).find((s) => s.name === WEBHOOK_SECRET);
    if (!stored) return { configured: false, service: null, updatedAt: null };
    let service: WebhookService | null = null;
    try {
      const raw = await vault.store.get(vault.scope, WEBHOOK_SECRET);
      service = raw ? parseWebhook(raw).service : null;
    } catch (err) {
      log.warn("notify.status_unreadable", { error: errorMessage(err) });
    }
    return { configured: true, service, updatedAt: stored.updated_at };
  }

  app.get("/api/notify", async (_req, reply) => {
    try {
      return await status();
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Enregistre le webhook (remplace le précédent) après avoir contrôlé que c'est bien celui de Discord ou de Slack. */
  app.post<{ Body: unknown }>("/api/notify/webhook", async (req, reply) => {
    try {
      const value = (req.body as { value?: unknown } | null)?.value;
      if (typeof value !== "string" || value.trim() === "") throw new SecretError("Colle l'adresse du webhook.");
      const webhook = parseWebhook(value);
      const { vault } = ctx.deps;
      await vault.store.put(vault.scope, WEBHOOK_SECRET, webhook.url);
      return { ok: true, service: webhook.service };
    } catch (err) {
      return fail(reply, err, 400);
    }
  });

  app.post("/api/notify/webhook/delete", async (_req, reply) => {
    try {
      const { vault } = ctx.deps;
      return { deleted: await vault.store.delete(vault.scope, WEBHOOK_SECRET) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** Envoie un message de test au webhook enregistré, pour vérifier qu'il arrive. */
  app.post("/api/notify/test", async (_req, reply) => {
    try {
      const { notifier } = ctx.deps;
      if (!notifier) return reply.code(409).send({ error: "Les notifications ne sont pas disponibles sur cette installation." });
      const result = await notifier.send({ kind: "test", title: "Notification de test", detail: "Si tu lis ce message, review-agent peut te prévenir ici." });
      if (!result.sent) return reply.code(400).send({ error: result.error });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
