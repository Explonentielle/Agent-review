import { errorMessage, log } from "../logger.js";
import type { Vault } from "../secrets/vault.js";
import { SERVICE_NAMES, WEBHOOK_SECRET, buildPayload, parseWebhook, type NotifyEvent, type Webhook } from "./webhook.js";

/** Résultat d'un envoi : l'erreur est écrite pour la personne, sans jamais contenir l'adresse du webhook. */
export type SendResult = { sent: true } | { sent: false; error: string };

export interface NotifierOptions {
  /** Remplaçable dans les tests. */
  fetchImpl?: typeof fetch;
  /** Horloge, en millisecondes (remplaçable dans les tests). */
  now?: () => number;
  /** Messages automatiques au plus par heure : un plan qui boucle ne doit pas inonder le salon. Le message de test n'est pas compté. */
  maxPerHour?: number;
  timeoutMs?: number;
}

export type Notifier = ReturnType<typeof createNotifier>;

/**
 * Envoie les notifications d'une personne vers le webhook (Discord ou Slack) enregistré dans son coffre. Aucune notification ne doit jamais
 * faire échouer ce qui la déclenche : `send` ne lève pas d'erreur, il la renvoie (et la journalise sans l'adresse du webhook).
 * @param vault Coffre de la personne : l'adresse du webhook y est lue à chaque envoi, donc un changement s'applique tout de suite.
 * @param options Remplacements pour les tests, plafond horaire et délai maximum d'un envoi.
 * @returns L'envoi d'un message.
 */
export function createNotifier(vault: Pick<Vault, "store" | "scope">, options: NotifierOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const maxPerHour = options.maxPerHour ?? 20;
  const timeoutMs = options.timeoutMs ?? 5000;
  const sentAt: number[] = [];

  /**
   * Lit le webhook de la personne.
   * @returns Le webhook, ou la raison pour laquelle il n'y en a pas d'utilisable.
   */
  async function readWebhook(): Promise<{ webhook: Webhook } | { error: string }> {
    let raw: string | null;
    try {
      raw = await vault.store.get(vault.scope, WEBHOOK_SECRET);
    } catch (err) {
      log.warn("notify.unreadable", { error: errorMessage(err) });
      return { error: "Le webhook enregistré est illisible : enregistre-le à nouveau." };
    }
    if (!raw) return { error: "Aucun webhook enregistré." };
    try {
      return { webhook: parseWebhook(raw) };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }

  return {
    /**
     * Envoie un message au webhook de la personne.
     * @param event Message à envoyer.
     * @returns `sent: true`, ou l'erreur (aucun webhook, plafond horaire atteint, service injoignable ou qui refuse).
     */
    async send(event: NotifyEvent): Promise<SendResult> {
      const found = await readWebhook();
      if ("error" in found) return { sent: false, error: found.error };
      const { webhook } = found;
      if (event.kind !== "test") {
        const since = now() - 3_600_000;
        while (sentAt.length > 0 && sentAt[0]! < since) sentAt.shift();
        if (sentAt.length >= maxPerHour) {
          log.warn("notify.rate_limited", { kind: event.kind });
          return { sent: false, error: `Limite de ${maxPerHour} notifications par heure atteinte.` };
        }
        sentAt.push(now());
      }
      const service = SERVICE_NAMES[webhook.service];
      try {
        // Pas de redirection suivie : une réponse 3xx n'est pas un envoi réussi, et l'adresse ne mène jamais ailleurs que chez le service
        const res = await fetchImpl(webhook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildPayload(webhook, event)),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status < 200 || res.status >= 300) {
          log.warn("notify.refused", { service: webhook.service, status: res.status, kind: event.kind });
          return { sent: false, error: `${service} a refusé le message (HTTP ${res.status}).${res.status === 404 ? " Le webhook existe-t-il encore ?" : ""}` };
        }
        return { sent: true };
      } catch (err) {
        log.warn("notify.failed", { service: webhook.service, kind: event.kind, error: errorMessage(err) });
        return { sent: false, error: `Envoi impossible vers ${service} : ${errorMessage(err)}` };
      }
    },
  };
}
