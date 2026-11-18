import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

type LootResponse = { drops: Array<{ eventId: string; event: string; itemId: string; rarity: string; seed: string }> };

describe("API : butin des projets créés et graine des armes", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];

  async function loot(): Promise<LootResponse> {
    const app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
    });
    apps.push(app);
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/forge/loot" });
    expect(res.statusCode).toBe(200);
    return res.json<LootResponse>();
  }

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("les projets créés (journal) rapportent un petit butin ; une création échouée ou une autre action ne compte pas", async () => {
    for (let i = 0; i < 25; i++) await h.audit.record({ source: "gitlab", action: "project_create", target: `groupe/projet-${i}`, detail: { private: true } });
    await h.audit.record({ source: "gitlab", action: "project_create", target: "groupe/refuse", error: "403 Forbidden" });
    await h.audit.record({ source: "gitlab", action: "ticket_create", target: "5/1", detail: { title: "x" } });
    const out = await loot();
    expect(out.drops.length).toBeGreaterThan(0);
    expect(out.drops.length).toBeLessThanOrEqual(20); // plafonné : jamais plus de 20 projets, et pas tous ne rapportent quelque chose
    expect(out.drops.every((d) => d.event === "project" && d.eventId.startsWith("project-") && d.seed === d.eventId)).toBe(true);
    expect((await loot()).drops).toEqual(out.drops); // recharger ne change rien
  });

  it("sans projet créé, ce chemin ne rapporte rien", async () => {
    await h.audit.record({ source: "gitlab", action: "ticket_create", target: "5/1", detail: { title: "x" } });
    expect((await loot()).drops).toEqual([]);
  });
});
