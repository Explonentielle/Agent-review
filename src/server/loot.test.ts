import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

type LootResponse = { catalog: Array<{ id: string; rarity: string }>; drops: Array<{ eventId: string; event: string; itemId: string; rarity: string }> };

describe("API : le butin de la forge", () => {
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
  const task = async (iid: number, status: string) => {
    const id = await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: iid, issueTitle: `Ticket ${iid}`, issueUrl: "u", extraInstructions: null });
    await h.tasks.update(id, { status: status as never, files_changed: 3, num_turns: 12 });
    return id;
  };

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("sans activité : le catalogue, aucun butin", async () => {
    const out = await loot();
    expect(out.catalog.length).toBeGreaterThan(40);
    expect(out.drops).toEqual([]);
  });

  it("une pièce forgée rapporte un objet du catalogue ; fusionnée depuis l'outil, un second ; un échec, rien ; toujours les mêmes objets", async () => {
    const forged = await task(1, "mr_created");
    await task(2, "error");
    const merged = await task(3, "mr_created");
    await h.tasks.addEvent(merged, "step", "MR !12 fusionnée dans develop (commit relu abcd1234)");
    await h.tasks.addEvent(forged, "step", "MR !11 mise à jour"); // un autre message ne vaut pas une fusion

    const first = await loot();
    expect(first.drops.map((d) => d.eventId).sort()).toEqual([`forge-${forged}`, `forge-${merged}`, `merge-${merged}`].sort());
    for (const d of first.drops) expect(first.catalog.find((c) => c.id === d.itemId)?.rarity).toBe(d.rarity);
    expect((await loot()).drops).toEqual(first.drops); // recharger ne change rien
  });

  it("une review terminée peut rapporter un objet (une fois sur deux), une review en cours jamais", async () => {
    for (let i = 0; i < 30; i++) {
      await h.reviews.insertIfNew({ projectId: 1, projectPath: "g/p", mrIid: 100 + i, mrTitle: "t", mrUrl: "u", author: "bob", headSha: String(i).padStart(40, "a"), status: "queued" });
    }
    const all = await h.reviews.list(undefined, 100);
    for (const r of all) await h.reviews.saveResult(r.id, { status: "auto_ok", decisionReasons: [], resultJson: "{}", changedLines: 1, costUsd: null, numTurns: null });
    const done = (await loot()).drops.filter((d) => d.event === "review").length;
    expect(done).toBeGreaterThan(5);
    expect(done).toBeLessThan(25); // environ la moitié de 30
  });
});
