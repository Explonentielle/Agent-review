import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../agent/runner.js";
import { levelOf } from "../auth/permissions.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

/* « Vérifier la connexion » : un vrai test auprès d'Anthropic (requête minimale, sans outil), au nom de la personne servie. */
describe("API : test réel de la connexion à Claude", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];

  async function server(runner: AgentRunner) {
    const app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0, checkRunner: runner,
    });
    apps.push(app);
    await app.ready();
    return app;
  }
  const check = (app: FastifyInstance) => app.inject({ method: "POST", url: "/api/claude/check", payload: {}, headers: { "x-review-agent": "1" } });
  const accepting = (calls: AgentRequest[]): AgentRunner => ({ run: async (req) => { calls.push(req); return { structured: { ok: true }, sessionId: null, costUsd: 0.01, numTurns: 1 }; } });
  const refusing: AgentRunner = { run: async () => { throw new Error("Claude Code a échoué (success) : Failed to authenticate. API Error: 401 Invalid bearer token"); } };

  beforeEach(async () => { h = await createHarness(); });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("une connexion acceptée est annoncée, avec le modèle des reviews et sans aucun outil", async () => {
    const calls: AgentRequest[] = [];
    const app = await server(accepting(calls));
    const res = await check(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, kind: "ok", mode: "subscription", cached: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.model).toBe((await h.settings.get()).review.model);
  });

  it("un jeton refusé par Anthropic est dit refusé, avec la marche à suivre, sans erreur HTTP", async () => {
    const app = await server(refusing);
    const res = await check(app);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ kind: string; detail: string }>()).toMatchObject({ ok: false, kind: "refused" });
    expect(res.json<{ detail: string }>().detail).toContain("claude setup-token");
  });

  it("un clic répété tout de suite ne relance pas l'agent (il consomme du quota)", async () => {
    const calls: AgentRequest[] = [];
    const app = await server(accepting(calls));
    await check(app);
    const again = await check(app);
    expect(again.json()).toMatchObject({ ok: true, cached: true });
    expect(calls).toHaveLength(1);
  });

  it("le mode clé API teste la clé : le constat le dit", async () => {
    await h.settings.save({ ...(await h.settings.get()), agentAuth: "api" });
    const app = await server(refusing);
    expect((await check(app)).json()).toMatchObject({ ok: false, kind: "refused", mode: "api" });
  });

  it("la route est classée « agir » : un lecteur ne peut pas dépenser le quota de l'espace", () => {
    expect(levelOf("POST", "/api/claude/check")).toBe("act");
  });
});
