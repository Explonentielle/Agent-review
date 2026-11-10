import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../agent/runner.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { runDevTask, type DevDeps } from "./pipeline.js";

const BACKENDS = ["sqlite", "postgres"] as const;

const BRANCH = "feature/609-import-des-regles";

const devResult = (over: Record<string, unknown> = {}) => ({
  status: "done",
  summary: "Correction de l'import.\n\n- **Fichier** : `app.js` modifié.",
  commit_message: "Correction de l'import",
  tests: "Aucun test lancé.",
  notes_for_reviewer: [],
  questions: [],
  ...over,
});

type RecordingRunner = AgentRunner & { requests: AgentRequest[] };

/** Faux exécuteur d'agent : fait la modification demandée dans le dossier de travail, puis renvoie le rapport. */
function runnerThat(edit: (cwd: string) => void, structured: unknown = devResult()): RecordingRunner {
  const requests: AgentRequest[] = [];
  return {
    requests,
    async run(req) {
      requests.push(req);
      req.onSession?.("sess-1");
      req.onEvent?.("tool", "Edit app.js");
      edit(req.cwd);
      return { structured, sessionId: "sess-1", costUsd: 0.1, numTurns: 3 };
    },
  };
}

describe.each(BACKENDS)("agent dev, de bout en bout, base %s (faux connecteur, vrai dépôt git local)", (backend) => {
  let h: Harness;
  const deps = (runner: AgentRunner): DevDeps => ({ config: h.config, forges: h.forges, costs: h.costs, settings: h.settings, tasks: h.tasks, runner });
  const newTask = () =>
    h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import des règles", issueUrl: "https://forge.example/groupe/projet/-/issues/609", extraInstructions: null });

  beforeEach(async () => {
    h = await createHarness(backend);
    h.connector.tickets.set(609, h.ticket());
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("premier passage : branche, commit de l'outil, push de cette branche seule, MR en brouillon", async () => {
    const runner = runnerThat((cwd) => writeFileSync(path.join(cwd, "app.js"), "export const x = 2;\n"));
    const id = await newTask();
    await runDevTask(id, deps(runner));

    const task = (await h.tasks.get(id))!;
    expect(task.error).toBeNull();
    expect(task.status).toBe("mr_created");
    expect(task.branch).toBe(BRANCH);
    expect(task.mr_iid).toBe(12);
    expect(task.session_id).toBe("sess-1");

    expect(h.remoteBranchSha(BRANCH)).not.toBe("");
    expect(h.remoteBranchSha("develop")).toBe(h.developSha);
    expect(h.lastCommit(BRANCH)).toBe("Alex Dev|alex@example.com|#609 - Correction de l'import");

    const mr = h.connector.createdChangeRequests[0]!;
    expect(mr).toMatchObject({ sourceBranch: BRANCH, targetBranch: "develop", title: "Draft: #609 - Import des règles", assigneeId: 7, removeSourceBranch: false });
    expect(mr.description).toContain("Related to #609");
    expect(mr.description).toContain("Développé par un agent IA");

    const req = runner.requests[0]!;
    expect(req.systemPrompt).toContain("Règles de sécurité (non modifiables"); // garde-fous toujours présents
    expect(req.systemPrompt).toContain("Aucune : ne lance pas de tests"); // aucune commande autorisée sur ce projet
    expect(req.prompt).toContain("Importer un fichier Excel");
    expect(req.persistSession).toBe(true);
    expect(req.tools).toContain("Bash");

    const events = (await h.tasks.events(id)).map((e) => `${e.kind}:${e.text}`);
    expect(events).toContain(`step:Branche ${BRANCH} créée depuis develop`);
    expect(events).toContain("tool:Edit app.js");
  });

  it("ticket trop flou : l'agent se bloque, rien n'est poussé ni créé", async () => {
    const runner = runnerThat(() => undefined, devResult({ status: "blocked", questions: ["Quelle colonne est concernée ?"] }));
    const id = await newTask();
    await runDevTask(id, deps(runner));

    expect((await h.tasks.get(id))!.status).toBe("blocked");
    expect(h.remoteBranchSha(BRANCH)).toBe("");
    expect(h.connector.createdChangeRequests).toEqual([]);
  });

  it("fichier ISO-8859-1 corrompu par l'agent : push refusé, rien de publié, travail conservé", async () => {
    const runner = runnerThat((cwd) => {
      const file = path.join(cwd, "legacy.php");
      // Ce que font les outils d'édition : lecture en UTF-8 (accents remplacés), réécriture en UTF-8
      writeFileSync(file, readFileSync(file).toString("utf8").replace("$a = 1", "$a = 2"));
    });
    const id = await newTask();
    await runDevTask(id, deps(runner));

    const task = (await h.tasks.get(id))!;
    expect(task.status).toBe("error");
    expect(task.error).toMatch(/Push refusé.*legacy\.php/);
    expect(h.remoteBranchSha(BRANCH)).toBe("");
    expect(h.connector.createdChangeRequests).toEqual([]);
    expect(task.worktree_path).not.toBeNull();
  });

  it("fichier de secrets : push refusé", async () => {
    const runner = runnerThat((cwd) => writeFileSync(path.join(cwd, ".env"), "TOKEN=abc\n"));
    const id = await newTask();
    await runDevTask(id, deps(runner));

    expect((await h.tasks.get(id))!.error).toMatch(/Fichiers sensibles modifiés \(\.env\)/);
    expect(h.remoteBranchSha(BRANCH)).toBe("");
  });

  it("branche protégée ou déjà existante : refus avant même de lancer l'agent", async () => {
    const runner = runnerThat((cwd) => writeFileSync(path.join(cwd, "app.js"), "x\n"));

    h.connector.protectedBranches = ["feature/*"];
    const id1 = await newTask();
    await runDevTask(id1, deps(runner));
    expect((await h.tasks.get(id1))!.error).toMatch(/protégée/);

    h.connector.protectedBranches = [];
    h.connector.existingBranches.add(BRANCH);
    const id2 = await newTask();
    await runDevTask(id2, deps(runner));
    expect((await h.tasks.get(id2))!.error).toMatch(/existe déjà/);

    expect(runner.requests).toHaveLength(0);
    expect(h.remoteBranchSha(BRANCH)).toBe("");
  });

  it("reprise : nouveau commit par-dessus la branche de la MR, commentaire de rapport, jamais de réécriture", async () => {
    const first = runnerThat((cwd) => writeFileSync(path.join(cwd, "app.js"), "export const x = 2;\n"));
    const originId = await newTask();
    await runDevTask(originId, deps(first));
    const origin = (await h.tasks.get(originId))!;
    expect(origin.status).toBe("mr_created");
    const firstSha = h.remoteBranchSha(BRANCH);

    h.connector.changeRequestComments.set(origin.mr_iid!, [
      { id: 1, body: "Il manque les docblocks", system: false, author: { id: 9, username: "rel", name: "Relecteur" }, createdAt: "2026-11-09T11:00:00Z", position: { path: "app.js", line: 1 }, resolvable: true, resolved: false },
    ]);
    const second = runnerThat((cwd) => writeFileSync(path.join(cwd, "NOTES.md"), "docblocks ajoutés\n"), devResult({ summary: "Docblocks ajoutés.", commit_message: "Ajout des docblocks" }));
    const followId = (await h.tasks.insert({
      projectId: 1,
      projectPath: "groupe/projet",
      issueIid: 609,
      issueTitle: "Import des règles",
      issueUrl: origin.issue_url,
      extraInstructions: "Ajoute les docblocks",
      followup: { parentId: originId, branch: BRANCH, baseBranch: "develop", targetBranch: "develop", mrIid: origin.mr_iid!, mrUrl: origin.mr_url! },
    }));
    await runDevTask(followId, deps(second));

    const follow = (await h.tasks.get(followId))!;
    expect(follow.error).toBeNull();
    expect(follow.status).toBe("mr_updated");
    expect(h.commitsAhead(BRANCH)).toBe(2);
    expect(h.lastCommit(BRANCH)).toBe("Alex Dev|alex@example.com|#609 - Ajout des docblocks");
    expect(h.remoteBranchSha(BRANCH)).not.toBe(firstSha);
    expect(h.remoteBranchSha("develop")).toBe(h.developSha);

    const note = h.connector.postedComments.at(-1)!;
    expect(note).toMatchObject({ iid: origin.mr_iid, kind: "note" });
    expect(note.body).toContain("> Ajoute les docblocks");

    const prompt = second.requests[0]!.prompt;
    expect(prompt).toContain("Ajoute les docblocks");
    expect(prompt).toContain("Il manque les docblocks");
    expect(prompt).toContain("git diff origin/develop...HEAD");
  });

  it("reprise impossible si la MR n'est plus ouverte", async () => {
    const first = runnerThat((cwd) => writeFileSync(path.join(cwd, "app.js"), "export const x = 2;\n"));
    const originId = await newTask();
    await runDevTask(originId, deps(first));
    const origin = (await h.tasks.get(originId))!;

    h.connector.changeRequests.get(origin.mr_iid!)!.state = "merged";
    const followId = (await h.tasks.insert({
      projectId: 1,
      projectPath: "groupe/projet",
      issueIid: 609,
      issueTitle: "Import des règles",
      issueUrl: origin.issue_url,
      extraInstructions: "Corrige",
      followup: { parentId: originId, branch: BRANCH, baseBranch: "develop", targetBranch: "develop", mrIid: origin.mr_iid!, mrUrl: origin.mr_url! },
    }));
    const second = runnerThat(() => undefined);
    await runDevTask(followId, deps(second));

    expect((await h.tasks.get(followId))!.error).toMatch(/n'est plus ouverte/);
    expect(second.requests).toHaveLength(0);
    expect(h.commitsAhead(BRANCH)).toBe(1);
  });
});
