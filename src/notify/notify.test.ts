import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server/app.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { createNotifier } from "./notifier.js";
import { WEBHOOK_SECRET, buildPayload, parseWebhook } from "./webhook.js";

const DISCORD = "https://discord.com/api/webhooks/123456789/jeton-secret-du-webhook";
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXXXXX";

describe("adresse du webhook", () => {
  it("accepte un webhook Discord ou Slack en https et reconnaît le service", () => {
    expect(parseWebhook(DISCORD)).toEqual({ service: "discord", url: DISCORD });
    expect(parseWebhook(`  ${SLACK}#ancre `)).toEqual({ service: "slack", url: SLACK });
    expect(parseWebhook("https://canary.discord.com/api/webhooks/1/abc?thread_id=42").url).toBe("https://canary.discord.com/api/webhooks/1/abc?thread_id=42");
  });

  it("refuse toute autre adresse : http, autre site, faux sous-domaine, identifiants, port, chemin qui n'est pas un webhook", () => {
    for (const bad of [
      "pas une adresse",
      "http://discord.com/api/webhooks/1/abc",
      "https://example.com/api/webhooks/1/abc",
      "https://discord.com.pirate.fr/api/webhooks/1/abc",
      "https://discord.com/channels/1/2",
      "https://utilisateur:mdp@discord.com/api/webhooks/1/abc",
      "https://discord.com:8443/api/webhooks/1/abc",
      "https://hooks.slack.com/autre/chemin",
      "https://127.0.0.1/api/webhooks/1/abc",
      "https://169.254.169.254/latest/meta-data",
    ]) {
      expect(() => parseWebhook(bad), bad).toThrow();
    }
  });
});

describe("corps du message", () => {
  it("Discord : titre en gras, détail, lien sans aperçu, et aucune mention n'est permise", () => {
    const payload = buildPayload(parseWebhook(DISCORD), { kind: "plan_failed", title: "Plan en échec : @everyone export", detail: "Le ticket a échoué.", url: "https://forge.example/mr/12" });
    expect(payload).toEqual({ username: "review-agent", content: "**Plan en échec : @everyone export**\nLe ticket a échoué.\n<https://forge.example/mr/12>", allowed_mentions: { parse: [] } });
  });

  it("Slack : les chevrons et l'esperluette du texte sont échappés, donc aucune mention ni lien ne passe", () => {
    const payload = buildPayload(parseWebhook(SLACK), { kind: "review_needs_human", title: "Review <!channel> & co", detail: "<https://pirate.example|cliquez ici>" });
    expect(payload).toEqual({ text: "*Review &lt;!channel&gt; &amp; co*\n&lt;https://pirate.example|cliquez ici&gt;" });
  });

  it("ne garde qu'une adresse http(s) sans espace ni chevron, retire les caractères de contrôle et coupe les textes trop longs", () => {
    const discord = parseWebhook(DISCORD);
    expect((buildPayload(discord, { kind: "test", title: "t", url: "javascript:alert(1)" }) as { content: string }).content).toBe("**t**");
    expect((buildPayload(discord, { kind: "test", title: "t", url: "https://a.example/x> @everyone" }) as { content: string }).content).toBe("**t**");
    expect((buildPayload(discord, { kind: "test", title: "a\u0000b\u001bc" }) as { content: string }).content).toBe("**a b c**");
    const long = (buildPayload(discord, { kind: "test", title: "x".repeat(500), detail: "y".repeat(5000) }) as { content: string }).content;
    expect(long.length).toBeLessThan(1500);
    expect(long).toContain("…");
  });
});

describe("envoi des notifications", () => {
  let h: Harness;
  type Call = { url: string; init: RequestInit };
  let calls: Call[];
  let reply: () => Response | Promise<Response>;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  const save = (url: string) => h.vault.store.put(h.vault.scope, WEBHOOK_SECRET, url);

  beforeEach(async () => {
    h = await createHarness();
    calls = [];
    reply = () => new Response(null, { status: 204 });
  });
  afterEach(() => h.cleanup());

  it("poste le message en JSON sur le webhook enregistré, sans suivre de redirection", async () => {
    await save(DISCORD);
    const result = await createNotifier(h.vault, { fetchImpl }).send({ kind: "plan_done", title: "Plan terminé : export", detail: "2 tickets" });
    expect(result).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(DISCORD);
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ content: "**Plan terminé : export**\n2 tickets", allowed_mentions: { parse: [] } });
  });

  it("sans webhook enregistré, ou avec un webhook devenu invalide, rien ne part et la raison est donnée", async () => {
    const notifier = createNotifier(h.vault, { fetchImpl });
    expect(await notifier.send({ kind: "test", title: "t" })).toEqual({ sent: false, error: "Aucun webhook enregistré." });
    await h.vault.store.put(h.vault.scope, WEBHOOK_SECRET, "https://example.com/pirate");
    expect((await notifier.send({ kind: "test", title: "t" })) as { error: string }).toMatchObject({ sent: false });
    expect(calls).toEqual([]);
  });

  it("un refus du service, une redirection ou une panne de réseau donnent une erreur lisible qui ne contient jamais l'adresse du webhook", async () => {
    await save(DISCORD);
    const notifier = createNotifier(h.vault, { fetchImpl });

    reply = () => new Response("Unknown Webhook", { status: 404 });
    const notFound = await notifier.send({ kind: "test", title: "t" });
    expect(notFound).toMatchObject({ sent: false });
    expect((notFound as { error: string }).error).toContain("HTTP 404");
    expect((notFound as { error: string }).error).toContain("Discord");

    reply = () => new Response(null, { status: 302, headers: { Location: "https://pirate.example/" } });
    expect(await notifier.send({ kind: "test", title: "t" })).toMatchObject({ sent: false });

    reply = () => {
      throw new Error("connexion refusée");
    };
    const down = (await notifier.send({ kind: "test", title: "t" })) as { sent: false; error: string };
    expect(down.error).toContain("connexion refusée");
    for (const text of [notFound, down].map((r) => (r as { error: string }).error)) expect(text).not.toContain("jeton-secret-du-webhook");
  });

  it("plafonne les messages automatiques par heure, sans compter le message de test, et reprend quand la fenêtre a glissé", async () => {
    await save(SLACK);
    let clock = 1_000_000;
    const notifier = createNotifier(h.vault, { fetchImpl, now: () => clock, maxPerHour: 2 });
    const event = { kind: "plan_failed" as const, title: "t" };

    expect((await notifier.send(event)).sent).toBe(true);
    expect((await notifier.send(event)).sent).toBe(true);
    const third = await notifier.send(event);
    expect(third).toMatchObject({ sent: false });
    expect((third as { error: string }).error).toContain("2 notifications par heure");
    expect((await notifier.send({ kind: "test", title: "t" })).sent).toBe(true); // l'essai de la personne passe toujours
    expect(calls).toHaveLength(3);

    clock += 3_600_001;
    expect((await notifier.send(event)).sent).toBe(true);
  });

  describe("routes des Paramètres", () => {
    const apps: FastifyInstance[] = [];
    async function server(withNotifier = true) {
      const app = buildServer({
        config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit,
        accounts: h.accounts, local: h.local, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
        ...(withNotifier ? { notifier: createNotifier(h.vault, { fetchImpl }) } : {}),
      });
      apps.push(app);
      await app.ready();
      return app;
    }
    const post = (app: FastifyInstance, url: string, payload: object = {}) => app.inject({ method: "POST", url, payload, headers: { "x-review-agent": "1" } });
    afterEach(async () => {
      for (const app of apps.splice(0)) await app.close();
    });

    it("enregistre le webhook après contrôle, ne le renvoie jamais, l'essaie et le supprime", async () => {
      const app = await server();
      expect((await app.inject({ method: "GET", url: "/api/notify" })).json()).toEqual({ configured: false, service: null, updatedAt: null });

      expect((await post(app, "/api/notify/webhook", { value: "https://example.com/pirate" })).statusCode).toBe(400);
      expect((await post(app, "/api/notify/webhook", {})).statusCode).toBe(400);
      expect((await post(app, "/api/notify/test")).statusCode).toBe(400); // rien d'enregistré : la raison est donnée

      expect((await post(app, "/api/notify/webhook", { value: DISCORD })).json()).toEqual({ ok: true, service: "discord" });
      const status = await app.inject({ method: "GET", url: "/api/notify" });
      expect(status.json()).toMatchObject({ configured: true, service: "discord" });
      expect(status.body).not.toContain("jeton-secret-du-webhook");
      expect(await h.vault.store.get(h.vault.scope, WEBHOOK_SECRET)).toBe(DISCORD);

      expect((await post(app, "/api/notify/test")).json()).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      reply = () => new Response(null, { status: 404 });
      const refused = await post(app, "/api/notify/test");
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ error: string }>().error).toContain("HTTP 404");

      expect((await post(app, "/api/notify/webhook/delete")).json()).toEqual({ deleted: true });
      expect((await app.inject({ method: "GET", url: "/api/notify" })).json()).toMatchObject({ configured: false });
    });

    it("sans expéditeur, l'essai répond que les notifications ne sont pas disponibles ; un lecteur ne peut rien", async () => {
      expect((await post(await server(false), "/api/notify/test")).statusCode).toBe(409);
      const viewer = buildServer({
        config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit,
        accounts: h.accounts, local: { ...h.local, role: "viewer" }, enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
      });
      apps.push(viewer);
      await viewer.ready();
      expect((await viewer.inject({ method: "GET", url: "/api/notify" })).statusCode).toBe(403);
      expect((await post(viewer, "/api/notify/webhook", { value: DISCORD })).statusCode).toBe(403);
      expect(await h.vault.store.has(h.vault.scope, WEBHOOK_SECRET)).toBe(false);
    });
  });
});
