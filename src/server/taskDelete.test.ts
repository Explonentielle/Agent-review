import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

describe("API : supprimer une tâche de l'agent dev", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];

  async function server() {
    const app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
    });
    apps.push(app);
    await app.ready();
    return app;
  }
  const del = (app: FastifyInstance, id: number | string) => app.inject({ method: "POST", url: `/api/tasks/${id}/delete`, payload: {}, headers: { "x-review-agent": "1" } });
  const newTask = (iid = 609) => h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: iid, issueTitle: "Un ticket", issueUrl: "https://forge.example/i/1", extraInstructions: null });

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("supprime une tâche en échec avec son journal ; les autres tâches restent", async () => {
    const failed = await newTask();
    await h.tasks.update(failed, { status: "error", error: "La MR a été refusée", branch: "feature/609-x" });
    await h.tasks.addEvent(failed, "error", "La MR a été refusée");
    const kept = await newTask(610);
    await h.tasks.update(kept, { status: "mr_created" });

    const app = await server();
    const res = await del(app, failed);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await h.tasks.get(failed)).toBeUndefined();
    expect(await h.tasks.events(failed)).toEqual([]);
    expect((await h.tasks.get(kept))?.status).toBe("mr_created");
    expect((await app.inject({ method: "GET", url: `/api/tasks/${failed}` })).statusCode).toBe(404);
  });

  it("refuse tant que l'agent travaille : la tâche est conservée", async () => {
    const queued = await newTask();
    const running = await newTask(610);
    await h.tasks.update(running, { status: "running" });
    const app = await server();

    for (const id of [queued, running]) {
      const res = await del(app, id);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain("arrête-le d'abord");
      expect(await h.tasks.get(id)).toBeDefined();
    }
  });

  it("tâche inconnue : 404 ; l'en-tête anti-CSRF est exigé comme pour toute écriture", async () => {
    const app = await server();
    expect((await del(app, 9999)).statusCode).toBe(404);
    const failed = await newTask();
    await h.tasks.update(failed, { status: "error" });
    const noHeader = await app.inject({ method: "POST", url: `/api/tasks/${failed}/delete`, payload: {} });
    expect(noHeader.statusCode).toBe(403);
    expect(await h.tasks.get(failed)).toBeDefined();
  });

  it("une tâche supprimée ne bloque plus : le ticket peut être relancé et la cause de l'échec est visible dans les listes", async () => {
    h.connector.tickets.set(609, h.ticket());
    const failed = await newTask();
    await h.tasks.update(failed, { status: "error", error: "Création de la MR refusée : la branche cible n'existe pas" });
    const app = await server();

    const issues = (await app.inject({ method: "GET", url: "/api/issues" })).json<Array<{ task: { status: string; error: string | null } }>>();
    expect(issues[0]!.task).toMatchObject({ status: "error", error: "Création de la MR refusée : la branche cible n'existe pas" });

    expect((await del(app, failed)).statusCode).toBe(200);
    const after = (await app.inject({ method: "GET", url: "/api/issues" })).json<Array<{ task: unknown }>>();
    expect(after[0]!.task).toBeNull();
  });
});
