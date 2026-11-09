import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };

describe("API du dashboard sur le connecteur", () => {
  let h: Harness;
  let enqueuedDev: number[];
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    h = await createHarness();
    enqueuedDev = [];
    h.connector.tickets.set(609, h.ticket());
    const current = await h.settings.get();
    await h.settings.save({ ...current, workflow: { ...current.workflow, todoLabels: ["Statut::A traiter"] } });
    app = buildServer({
      config: h.config,
      connector: h.connector,
      costs: h.costs,
      reviews: h.reviews,
      workspace: h.workspace,
      settings: h.settings,
      tasks: h.tasks,
      enqueueReview: () => undefined,
      enqueueDev: (id) => enqueuedDev.push(id),
      queueSize: () => 0,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    h.cleanup();
  });

  it("onglet Tickets : colonne d'après les labels, branche prévue, projet prêt pour l'agent", async () => {
    const res = await app.inject({ method: "GET", url: "/api/issues" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        projectId: 1,
        projectPath: "groupe/projet",
        iid: 609,
        title: "Import des règles",
        labels: ["Statut::A traiter"],
        url: "https://forge.example/groupe/projet/-/issues/609",
        updatedAt: "2026-11-09T10:00:00Z",
        milestone: null,
        column: "todo",
        devReady: true,
        branchPreview: "feature/609-import-des-regles",
        baseBranch: "develop",
        targetBranch: "develop",
        task: null,
      },
    ]);
  });

  it("recherche de projets et de branches pour la page Paramètres", async () => {
    const projects = await app.inject({ method: "GET", url: "/api/gitlab/projects?search=groupe" });
    expect(projects.json()).toEqual([{ id: 1, path: "groupe/projet", name: "projet", url: "https://forge.example/groupe/projet" }]);
    const branches = await app.inject({ method: "GET", url: "/api/gitlab/projects/1/branches" });
    expect(branches.json()).toEqual([{ name: "develop", default: true, protected: true }]);
  });

  it("lancer l'agent : en-tête anti-CSRF obligatoire, ticket vérifié sur la forge, un seul agent par ticket", async () => {
    const payload = { projectId: 1, issueIid: 609, extraInstructions: "  Sois prudent  " };
    expect((await app.inject({ method: "POST", url: "/api/tasks", payload })).statusCode).toBe(403);

    const ok = await app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload });
    expect(ok.statusCode).toBe(200);
    const { id } = ok.json() as { id: number };
    expect(enqueuedDev).toEqual([id]);
    expect((await h.tasks.get(id))).toMatchObject({ project_path: "groupe/projet", issue_iid: 609, issue_title: "Import des règles", extra_instructions: "Sois prudent", status: "queued" });

    expect((await app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: { projectId: 1, issueIid: 999 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/tasks", headers: WRITE, payload: { projectId: 2, issueIid: 609 } })).statusCode).toBe(400);
  });

  it("reprise : consignes obligatoires, tâche liée à une MR, nouvelle tâche qui hérite de la branche", async () => {
    const origin = (await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null }));
    const followup = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/tasks/${origin}/followup`, headers: WRITE, payload });

    expect((await followup({})).statusCode).toBe(400); // consignes manquantes
    expect((await followup({ instructions: "Corrige" })).statusCode).toBe(400); // pas de MR liée

    await h.tasks.update(origin, { status: "mr_created", branch: "feature/609-import", base_branch: "develop", target_branch: "develop", mr_iid: 12, mr_url: "https://forge.example/mr/12" });
    const res = await followup({ instructions: "Ajoute les docblocks" });
    expect(res.statusCode).toBe(200);
    const created = (await h.tasks.get((res.json() as { id: number }).id))!;
    expect(created).toMatchObject({ mode: "followup", parent_id: origin, branch: "feature/609-import", mr_iid: 12, extra_instructions: "Ajoute les docblocks" });
    expect(enqueuedDev).toEqual([created.id]);

    expect((await followup({ instructions: "Encore" })).statusCode).toBe(409); // un agent travaille déjà sur ce ticket
  });

  it("nettoyage d'une tâche terminée : le dossier local est supprimé via l'URL de clonage du connecteur", async () => {
    const id = (await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null }));
    await h.tasks.update(id, { status: "mr_created", worktree_path: "/inexistant" });
    const res = await app.inject({ method: "POST", url: `/api/tasks/${id}/cleanup`, headers: WRITE });
    expect(res.statusCode).toBe(200);
    expect((await h.tasks.get(id))!.worktree_path).toBeNull();
  });
});
