import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditConnector } from "../connectors/audited.js";
import { ForgeRegistry } from "../connectors/registry.js";
import { GitlabError } from "../gitlab/client.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const OK_RESULT = JSON.stringify({
  summary: "Rien de grave.",
  verdict: "approve",
  coverage: "full",
  ci_failure_related: false,
  injection_suspected: false,
  findings: [{ severity: "suggestion", confirmed: true, title: "Nommage", location: "app.js:3", explanation: "Un nom plus clair." }],
  positives: [],
  questions_for_author: [],
});

describe("API : relire puis fusionner la pièce de l'agent", () => {
  let h: Harness;
  let enqueued: number[];
  let taskId: number;
  let mrIid: number;
  const apps: FastifyInstance[] = [];

  /** Serveur sur le harnais, avec le connecteur enveloppé par l'audit comme en production. */
  async function server() {
    const forges = new ForgeRegistry(h.forges.all().map((f) => ({ ...f, connector: auditConnector(f.connector, h.audit) })));
    const app = buildServer({
      config: h.config, forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: (id) => void enqueued.push(id), enqueueDev: () => undefined, queueSize: () => 0,
    });
    apps.push(app);
    await app.ready();
    return app;
  }
  const get = (app: FastifyInstance, id: number) => app.inject({ method: "GET", url: `/api/tasks/${id}/piece` });
  const post = (app: FastifyInstance, url: string, payload: object = {}) => app.inject({ method: "POST", url, payload, headers: { "x-review-agent": "1" } });
  const review = (app: FastifyInstance, id = taskId) => post(app, `/api/tasks/${id}/review`);
  const merge = (app: FastifyInstance, id = taskId) => post(app, `/api/tasks/${id}/merge`);

  /** Termine la review de ce commit avec le statut voulu. */
  async function finishReview(reviewId: number, status: "auto_ok" | "needs_human") {
    await h.reviews.saveResult(reviewId, { status, decisionReasons: [], resultJson: OK_RESULT, changedLines: 3, costUsd: 0.1, numTurns: 2 });
  }

  beforeEach(async () => {
    h = await createHarness();
    enqueued = [];
    h.connector.checkStatuses = [{ name: "phpunit", status: "success" }];
    // La pièce : une MR en brouillon ouverte par l'agent dev, de la branche de la tâche vers develop (la cible du projet du harnais)
    const mr = await h.connector.createChangeRequest(1, { sourceBranch: "feature/609-import", targetBranch: "develop", title: "Draft: #609 - Import", description: "d" });
    mrIid = mr.iid;
    taskId = await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null });
    await h.tasks.update(taskId, { status: "mr_created", branch: "feature/609-import", mr_iid: mrIid, mr_url: mr.url });
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("avant toute review : l'état dit que la fusion est refusée et pourquoi", async () => {
    const res = (await get(await server(), taskId)).json<{ mr: { state: string; draft: boolean }; review: unknown; readiness: { ok: boolean; reasons: string[] } }>();
    expect(res.mr).toMatchObject({ state: "opened", draft: true });
    expect(res.review).toBeNull();
    expect(res.readiness.ok).toBe(false);
    expect(res.readiness.reasons[0]).toContain("lance d'abord la relecture");
  });

  it("lancer la relecture : une review est créée pour le commit actuel et mise en file, une seule fois", async () => {
    const app = await server();
    const first = (await review(app)).json<{ id: number; status: string; already: boolean }>();
    expect(first).toMatchObject({ status: "queued", already: false });
    expect(enqueued).toEqual([first.id]);
    const row = (await h.reviews.get(first.id))!;
    expect(row).toMatchObject({ source: "gitlab", project_id: 1, mr_iid: mrIid, head_sha: "0".repeat(40), status: "queued" });

    const second = (await review(app)).json<{ id: number; already: boolean }>();
    expect(second).toMatchObject({ id: first.id, already: true }); // pas de doublon ni de seconde mise en file
    expect(enqueued).toEqual([first.id]);

    // Une review en erreur se relance
    await h.reviews.saveError(first.id, "quota");
    const retried = (await review(app)).json<{ id: number; status: string }>();
    expect(retried).toMatchObject({ id: first.id, status: "queued" });
    expect(enqueued).toEqual([first.id, first.id]);
  });

  it("relecture OK : l'état devient « prêt », avec le décompte des points ; la fusion sort la MR du brouillon puis la fusionne, et tout est tracé", async () => {
    const app = await server();
    const { id } = (await review(app)).json<{ id: number }>();
    await finishReview(id, "auto_ok");

    const state = (await get(app, taskId)).json<{ review: { status: string; current: boolean; suggestion: number; blocking: number }; readiness: { ok: boolean; state: string }; checks: { total: number; failed: number } }>();
    expect(state.review).toMatchObject({ status: "auto_ok", current: true, suggestion: 1, blocking: 0 });
    expect(state.readiness).toMatchObject({ ok: true, state: "ready" });
    expect(state.checks).toMatchObject({ total: 1, failed: 0 });

    const res = await merge(app);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, merged: true, target: "develop" });
    expect(h.connector.readied).toEqual([mrIid]);
    expect(h.connector.merges).toEqual([{ iid: mrIid, headSha: "0".repeat(40) }]); // fusionné au commit relu
    expect((await h.connector.getChangeRequest(1, mrIid)).state).toBe("merged");
    expect((await h.tasks.events(taskId)).map((e) => e.text).join("|")).toContain(`MR !${mrIid} fusionnée dans develop`);
    expect((await h.audit.list()).map((e) => e.action).sort()).toEqual(["change_request_merge", "change_request_ready"]);

    // Fusionnée : l'état le dit, et une seconde fusion est refusée
    expect((await get(app, taskId)).json<{ readiness: { state: string } }>().readiness.state).toBe("merged");
    expect((await merge(app)).statusCode).toBe(409);
    expect(h.connector.merges.length).toBe(1);
  });

  it("une MR déjà prête (hors brouillon) n'est pas « re-sortie » du brouillon", async () => {
    const app = await server();
    h.connector.changeRequests.set(mrIid, { ...h.connector.changeRequests.get(mrIid)!, draft: false });
    const { id } = (await review(app)).json<{ id: number }>();
    await finishReview(id, "auto_ok");
    expect((await merge(app)).statusCode).toBe(200);
    expect(h.connector.readied).toEqual([]);
    expect(h.connector.merges.length).toBe(1);
  });

  it("la fusion est refusée, côté serveur, tant qu'une règle n'est pas satisfaite : rien n'est fusionné", async () => {
    const app = await server();
    const fused = () => h.connector.merges.length;

    // Aucune review
    let res = await merge(app);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ reasons: string[] }>().reasons[0]).toContain("lance d'abord la relecture");

    // Review qui demande l'analyse
    const { id } = (await review(app)).json<{ id: number }>();
    await finishReview(id, "needs_human");
    res = await merge(app);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain("demandent ton analyse");

    // Review OK, mais la CI est rouge
    await h.reviews.setStatus(id, "auto_ok");
    h.connector.checkStatuses = [{ name: "phpunit", status: "failed" }];
    res = await merge(app);
    expect(res.json<{ error: string }>().error).toContain("a échoué : phpunit");

    // CI verte, mais la MR a reçu un commit depuis la review
    h.connector.checkStatuses = [{ name: "phpunit", status: "success" }];
    h.connector.changeRequests.set(mrIid, { ...h.connector.changeRequests.get(mrIid)!, headSha: "f".repeat(40) });
    res = await merge(app);
    expect(res.json<{ error: string }>().error).toContain("a changé depuis la dernière review");

    // Commit relu de nouveau, mais la MR vise une autre branche que la cible du projet
    h.connector.changeRequests.set(mrIid, { ...h.connector.changeRequests.get(mrIid)!, headSha: "0".repeat(40), targetBranch: "main" });
    res = await merge(app);
    expect(res.json<{ error: string }>().error).toContain("vise « main » mais le projet est réglé sur « develop »");

    expect(fused()).toBe(0);
    expect(h.connector.readied).toEqual([]);
  });

  it("un refus de la forge (droits) devient un message clair, et rien n'est fusionné", async () => {
    const app = await server();
    const { id } = (await review(app)).json<{ id: number }>();
    await finishReview(id, "auto_ok");
    h.connector.failNextWrite = new GitlabError("PUT", "/projects/1/merge_requests/12/merge", 403, "403 Forbidden");

    const res = await merge(app);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toContain("Maintainer");
    expect(h.connector.merges).toEqual([]);
    expect((await h.audit.list())[0]!.outcome).toBe("error"); // le refus est tracé aussi
  });

  it("une tâche sans MR ne peut être ni relue ni fusionnée ; tâche inconnue : 404 ; l'en-tête anti-CSRF est exigé", async () => {
    const app = await server();
    const noMr = await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 700, issueTitle: "x", issueUrl: "u", extraInstructions: null });
    await h.tasks.update(noMr, { status: "error" });
    expect((await review(app, noMr)).statusCode).toBe(400);
    expect((await merge(app, noMr)).statusCode).toBe(400);
    expect((await get(app, noMr)).statusCode).toBe(400);
    expect((await get(app, 9999)).statusCode).toBe(404);

    const noHeader = await app.inject({ method: "POST", url: `/api/tasks/${taskId}/merge`, payload: {} });
    expect(noHeader.statusCode).toBe(403);
    expect(h.connector.merges).toEqual([]);
  });
});
