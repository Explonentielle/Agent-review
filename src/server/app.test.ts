import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };

describe("API du dashboard sur le connecteur", () => {
  let h: Harness;
  let enqueuedDev: number[];
  let enqueuedReviews: number[];
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    h = await createHarness();
    enqueuedDev = [];
    enqueuedReviews = [];
    h.connector.tickets.set(609, h.ticket());
    const current = await h.settings.get();
    await h.settings.save({ ...current, workflow: { ...current.workflow, todoLabels: ["Statut::A traiter"] } });
    app = buildServer({
      config: h.config,
      forges: h.forges,
      costs: h.costs,
      reviews: h.reviews,
      settings: h.settings,
      tasks: h.tasks,
      vault: h.vault,
      audit: h.audit,
      accounts: h.accounts,
      local: h.local,
      enqueueReview: (id) => enqueuedReviews.push(id),
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
        source: "gitlab",
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

  it("lancer une review détectée : seulement si elle attend, une seule fois, mise en file", async () => {
    const mr = { projectId: 1, projectPath: "groupe/projet", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: "a".repeat(40) };
    const waiting = (await h.reviews.insertIfNew({ ...mr, status: "detected" }))!;
    const queued = (await h.reviews.insertIfNew({ ...mr, mrIid: 8 }))!;
    const start = (id: number, headers: Record<string, string> = WRITE) => app.inject({ method: "POST", url: `/api/reviews/${id}/start`, headers });

    expect((await start(waiting, {})).statusCode).toBe(403); // en-tête anti-CSRF
    expect((await start(999_999)).statusCode).toBe(404);
    expect((await start(queued)).statusCode).toBe(409); // déjà en file : rien à lancer
    expect(enqueuedReviews).toEqual([]);

    expect((await start(waiting)).statusCode).toBe(200);
    expect(enqueuedReviews).toEqual([waiting]);
    expect(await h.reviews.get(waiting)).toMatchObject({ status: "queued" });
    expect((await start(waiting)).statusCode).toBe(409); // un second clic ne relance pas
    expect(enqueuedReviews).toEqual([waiting]);
    expect(await h.db.get("SELECT kind, automatic FROM actions WHERE review_id = ?", [waiting])).toEqual({ kind: "start", automatic: 0 });
  });

  it("secrets : valeurs jamais renvoyées, en-tête anti-CSRF, noms limités, jeton GitHub contrôlé", async () => {
    const save = (name: string, payload: object, headers: Record<string, string> = WRITE) => app.inject({ method: "POST", url: `/api/secrets/${name}`, headers, payload });

    const initial = await app.inject({ method: "GET", url: "/api/secrets" });
    expect(initial.json()).toEqual({
      secrets: [
        { name: "gitlab.token", label: "Jeton GitLab", source: "env", updatedAt: null, live: false },
        { name: "github.token", label: "Jeton GitHub", source: null, updatedAt: null, live: false },
        { name: "anthropic.api_key", label: "Clé API Anthropic", source: null, updatedAt: null, live: true },
      ],
    });

    expect((await save("github.token", { value: "github_pat_X" }, {})).statusCode).toBe(403); // sans l'en-tête
    expect((await save("planio.api_key", { value: "x".repeat(20) })).statusCode).toBe(400); // secret non géré ici
    expect((await save("github.token", {})).statusCode).toBe(400); // valeur manquante
    expect((await save("github.token", { value: 42 })).statusCode).toBe(400);
    expect((await save("github.token", { value: "   " })).statusCode).toBe(400); // vide après nettoyage

    const saved = await save("github.token", { value: "github_pat_SAISIE_AU_DASHBOARD_1" });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ restartRequired: true });
    expect(saved.body).not.toContain("SAISIE_AU_DASHBOARD");

    const listed = await app.inject({ method: "GET", url: "/api/secrets" });
    expect(listed.json<{ secrets: { name: string; source: string | null }[] }>().secrets.map((s) => [s.name, s.source])).toEqual([
      ["gitlab.token", "env"],
      ["github.token", "vault"],
      ["anthropic.api_key", null],
    ]);
    for (const url of ["/api/secrets", "/api/stats", "/api/settings"]) expect((await app.inject({ method: "GET", url })).body).not.toContain("SAISIE_AU_DASHBOARD");

    // La clé API sert tout de suite, sans redémarrage
    expect(((await app.inject({ method: "GET", url: "/api/stats" })).json() as { apiKeyConfigured: boolean }).apiKeyConfigured).toBe(false);
    expect((await save("anthropic.api_key", { value: "sk-ant-SAISIE-AU-DASHBOARD-1" })).json()).toEqual({ restartRequired: false });
    expect(((await app.inject({ method: "GET", url: "/api/stats" })).json() as { apiKeyConfigured: boolean }).apiKeyConfigured).toBe(true);
    expect(h.config.anthropicApiKey).toBe("sk-ant-SAISIE-AU-DASHBOARD-1");

    const removed = await app.inject({ method: "POST", url: "/api/secrets/anthropic.api_key/delete", headers: WRITE });
    expect(removed.json()).toEqual({ deleted: true, restartRequired: false });
    expect(h.config.anthropicApiKey).toBeNull();
    expect((await app.inject({ method: "POST", url: "/api/secrets/anthropic.api_key/delete" })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/secrets/inconnu/delete", headers: WRITE })).statusCode).toBe(400);
  });

  it("secrets : un jeton GitHub refusé par GitHub n'est pas enregistré ; un secret du .env n'est pas modifiable", async () => {
    h.vault.verifyGithubToken = async () => {
      throw new Error("Bad credentials");
    };
    const refused = await app.inject({ method: "POST", url: "/api/secrets/github.token", headers: WRITE, payload: { value: "github_pat_REFUSE_123456" } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: "Bad credentials" });
    expect(await h.vault.store.has(h.vault.scope, "github.token")).toBe(false);

    h.vault.fromEnv["anthropic.api_key"] = true;
    const conflict = await app.inject({ method: "POST", url: "/api/secrets/anthropic.api_key", headers: WRITE, payload: { value: "sk-ant-AUTRE-12345678" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: string }>().error).toMatch(/\.env/);
    expect((await app.inject({ method: "POST", url: "/api/secrets/anthropic.api_key/delete", headers: WRITE })).statusCode).toBe(409);
  });
});
