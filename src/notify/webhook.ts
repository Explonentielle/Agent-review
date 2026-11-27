import { SecretError } from "../secrets/crypto.js";

/** Nom, dans le coffre de la personne, de l'adresse du webhook qui reçoit ses notifications. */
export const WEBHOOK_SECRET = "notify.webhook";

/** Ce qui déclenche un message. `test` ne part que sur demande, depuis les Paramètres. */
export type NotifyKind = "plan_failed" | "plan_done" | "plan_waiting_merge" | "review_needs_human" | "test";

/** Un message à envoyer : un titre, un détail et, si utile, l'adresse de la MR concernée. */
export interface NotifyEvent {
  kind: NotifyKind;
  title: string;
  detail?: string | undefined;
  url?: string | null | undefined;
}

export type WebhookService = "discord" | "slack";

/** Webhook reconnu : le service qui le reçoit (il fixe le format du message) et son adresse. */
export interface Webhook {
  service: WebhookService;
  url: string;
}

/** Noms lisibles des services, pour les messages d'erreur. */
export const SERVICE_NAMES: Record<WebhookService, string> = { discord: "Discord", slack: "Slack" };

const DISCORD_HOSTS = new Set(["discord.com", "ptb.discord.com", "canary.discord.com", "discordapp.com"]);
const SLACK_HOST = "hooks.slack.com";
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SAFE_URL = /^https?:\/\/[^\s<>|]+$/;

/**
 * Contrôle l'adresse d'un webhook. Seuls Discord et Slack sont acceptés, en https : l'outil ne doit pas pouvoir être dirigé vers une adresse
 * quelconque (réseau interne de la machine comprise) par une valeur saisie dans le tableau de bord.
 * @param value Adresse saisie.
 * @returns Le service et l'adresse nettoyée (sans fragment).
 * @throws SecretError Si l'adresse n'est pas un webhook Discord ou Slack en https.
 */
export function parseWebhook(value: string): Webhook {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SecretError("Adresse invalide : colle l'adresse complète du webhook (https://discord.com/api/webhooks/...)");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new SecretError("L'adresse doit être en https, sans identifiants ni numéro de port");
  const clean = `${url.origin}${url.pathname}${url.search}`;
  if (DISCORD_HOSTS.has(url.hostname) && url.pathname.startsWith("/api/webhooks/")) return { service: "discord", url: clean };
  if (url.hostname === SLACK_HOST && url.pathname.startsWith("/services/")) return { service: "slack", url: clean };
  throw new SecretError("Seuls les webhooks Discord (https://discord.com/api/webhooks/...) et Slack (https://hooks.slack.com/services/...) sont acceptés");
}

/**
 * Nettoie un texte avant envoi : sans caractères de contrôle, coupé à une longueur.
 * @param text Texte à nettoyer.
 * @param max Nombre maximum de caractères.
 * @returns Le texte nettoyé.
 */
function clean(text: string, max: number): string {
  const t = text.replace(CONTROL, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Corps JSON du message pour le service du webhook. Discord : aucune mention n'est autorisée (un titre de MR écrit par quelqu'un d'autre ne doit pas
 * pouvoir « @everyone »). Slack : `&`, `<` et `>` sont échappés, ce qui neutralise les mentions et les liens du texte.
 * @param webhook Webhook cible.
 * @param event Message à envoyer.
 * @returns L'objet à envoyer en JSON.
 */
export function buildPayload(webhook: Webhook, event: NotifyEvent): Record<string, unknown> {
  const title = clean(event.title, 200);
  const detail = event.detail ? clean(event.detail, 1200) : "";
  const link = event.url && SAFE_URL.test(event.url) ? clean(event.url, 300) : "";
  if (webhook.service === "slack") {
    const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return { text: [`*${escape(title)}*`, detail && escape(detail), link && `<${link}>`].filter(Boolean).join("\n") };
  }
  return { username: "review-agent", content: [`**${title}**`, detail, link && `<${link}>`].filter(Boolean).join("\n"), allowed_mentions: { parse: [] } };
}
