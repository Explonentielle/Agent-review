import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunner } from "../agent/runner.js";
import { runDevTask } from "../dev/pipeline.js";
import { REVIEW_MARKER } from "../review/format.js";
import { approve, publishComment, runReview, type PipelineDeps } from "../review/pipeline.js";
import { RepoWorkspace } from "../review/workspace.js";
import { FakeConnector } from "../testing/fakeConnector.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { startReviewPoller } from "../triggers/reviewPoller.js";
import { ForgeRegistry } from "./registry.js";
import type { ChangeRequest } from "./types.js";

const reviewOk = { summary: "RAS", verdict: "approve", coverage: "full", ci_failure_related: false, injection_suspected: false, findings: [], positives: [], questions_for_author: [] };
const devResult = { status: "done", summary: "Correction.", commit_message: "Correction", tests: "Aucun test lancé.", notes_for_reviewer: [], questions: [] };

/**
 * Deux forges dans la même base, avec les MÊMES numéros de projet, de ticket et de demande : chaque
 * review et chaque tâche doit être traitée par la forge qui l'a créée, jamais par l'autre.
 */
describe("plusieurs forges : chaque donnée passe par sa forge", () => {
  let h: Harness;
  let github: FakeConnector;
  let forges: ForgeRegistry;

  beforeEach(async () => {
    h = await createHarness();
    github = new FakeConnector({ cloneUrl: h.remoteUrl, path: "acme/projet", url: "https://github.com/acme/projet" }, "github");
    github.me = { id: 9, username: "alex-gh", name: "Alex GitHub", commitEmail: "9+alex-gh@users.noreply.github.com" };
    // Le faux dépôt expose les têtes de demandes sous refs/merge-requests : on le garde pour les deux forges
    github.changeRequestHeadRef = (iid: number) => `refs/merge-requests/${iid}/head`;
    forges = new ForgeRegistry([
      { connector: h.connector, workspace: h.workspace, username: "alex" },
      { connector: github, workspace: new RepoWorkspace(path.join(h.root, "repos-github"), "jeton-github"), username: "alex-gh" },
    ]);
    await h.settings.saveProject({ source: "github", projectId: 1, path: "acme/projet", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "" });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const reviewDeps = (runner: AgentRunner): PipelineDeps => ({ config: h.config, forges, costs: h.costs, reviews: h.reviews, settings: h.settings, runner });

  it("tâche de dev GitHub : ticket, commit, push et PR passent par GitHub, pas par GitLab", async () => {
    h.connector.tickets.set(609, { ...h.ticket(), title: "Ticket GitLab" });
    github.tickets.set(609, { ...h.ticket(), title: "Ticket GitHub", projectPath: "acme/projet" });
    const runner: AgentRunner = {
      async run(req) {
        writeFileSync(path.join(req.cwd, "app.js"), "export const x = 2;\n");
        return { structured: devResult, sessionId: null, costUsd: 0.1, numTurns: 2 };
      },
    };
    const id = await h.tasks.insert({ source: "github", projectId: 1, projectPath: "acme/projet", issueIid: 609, issueTitle: "Ticket GitHub", issueUrl: "u", extraInstructions: null });

    await runDevTask(id, { config: h.config, forges, costs: h.costs, settings: h.settings, tasks: h.tasks, runner });

    expect(await h.tasks.get(id)).toMatchObject({ status: "mr_created", source: "github", error: null });
    expect(github.createdChangeRequests).toHaveLength(1);
    expect(h.connector.createdChangeRequests).toHaveLength(0);
    expect(h.lastCommit("feature/609-ticket-github")).toBe("Alex GitHub|9+alex-gh@users.noreply.github.com|#609 - Correction"); // l'identité GitHub signe le commit
  });

  it("tâche de dev sans réglage pour sa forge : refusée, même si un projet de même numéro existe chez l'autre", async () => {
    await h.settings.deleteProject("github", 1); // il reste le projet GitLab numéro 1
    const id = await h.tasks.insert({ source: "github", projectId: 1, projectPath: "acme/projet", issueIid: 609, issueTitle: "t", issueUrl: "u", extraInstructions: null });

    await runDevTask(id, { config: h.config, forges, costs: h.costs, settings: h.settings, tasks: h.tasks, runner: { run: async () => ({ structured: devResult, sessionId: null, costUsd: 0, numTurns: 0 }) } });

    expect(await h.tasks.get(id)).toMatchObject({ status: "error" });
    expect((await h.tasks.get(id))!.error).toMatch(/Projet non configuré/);
    expect(h.connector.createdChangeRequests).toHaveLength(0);
    expect(github.createdChangeRequests).toHaveLength(0);
  });

  it("une tâche dont la forge n'est plus configurée passe en erreur avec un message clair", async () => {
    const onlyGitlab = new ForgeRegistry([{ connector: h.connector, workspace: h.workspace, username: "alex" }]);
    const id = await h.tasks.insert({ source: "github", projectId: 1, projectPath: "acme/projet", issueIid: 609, issueTitle: "t", issueUrl: "u", extraInstructions: null });

    await runDevTask(id, { config: h.config, forges: onlyGitlab, costs: h.costs, settings: h.settings, tasks: h.tasks, runner: { run: async () => ({ structured: devResult, sessionId: null, costUsd: 0, numTurns: 0 }) } });

    expect((await h.tasks.get(id))!.error).toMatch(/Aucun jeton GitHub enregistré/);
  });

  describe("reviews", () => {
    const pull = (sha: string): ChangeRequest => ({
      projectId: 1,
      projectPath: "acme/projet",
      iid: 7,
      title: "Titre de la PR GitHub",
      description: "",
      state: "opened",
      draft: false,
      sourceBranch: "feature/x",
      targetBranch: "develop",
      headSha: sha,
      url: "https://github.com/acme/projet/pull/7",
      author: { id: 12, username: "collegue", name: "Collègue" },
      reviewers: [github.me],
      labels: [],
    });
    const newReview = (source: "gitlab" | "github", sha: string) =>
      h.reviews.insertIfNew({ source, projectId: 1, projectPath: source === "github" ? "acme/projet" : "groupe/projet", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: sha }).then((id) => id!);

    it("review GitHub : lue, commentée et approuvée sur GitHub seulement", async () => {
      const sha = h.addMergeRequestRef(7, { "app.js": "export const x = 3;\n" });
      github.changeRequests.set(7, pull(sha));
      const seen: string[] = [];
      const runner: AgentRunner = {
        async run(req) {
          seen.push(readFileSync(path.join(req.cwd, "app.js"), "utf8"));
          return { structured: reviewOk, sessionId: null, costUsd: 0.02, numTurns: 3 };
        },
      };
      const id = await newReview("github", sha);

      await runReview(id, reviewDeps(runner));
      expect(await h.reviews.get(id)).toMatchObject({ status: "auto_ok", source: "github", error: null });
      expect(seen).toEqual(["export const x = 3;\n"]);

      await publishComment(id, reviewDeps(runner), false);
      await approve(id, reviewDeps(runner), false);
      expect(github.postedComments).toHaveLength(1);
      expect(github.postedComments[0]).toMatchObject({ iid: 7, kind: "review" });
      expect(github.postedComments[0]!.body).toContain(REVIEW_MARKER);
      expect(github.approvals).toEqual([{ iid: 7, headSha: sha }]);
      expect(h.connector.postedComments).toEqual([]);
      expect(h.connector.approvals).toEqual([]);
    });

    it("deux reviews de même numéro de projet et de demande : chacune va chez sa forge", async () => {
      const sha = h.addMergeRequestRef(7, { "app.js": "export const x = 3;\n" });
      github.changeRequests.set(7, pull(sha));
      h.connector.changeRequests.set(7, { ...pull(sha), projectPath: "groupe/projet", url: "https://forge.example/groupe/projet/-/merge_requests/7" });
      const runner: AgentRunner = { run: async () => ({ structured: reviewOk, sessionId: null, costUsd: 0.02, numTurns: 3 }) };
      // Commits différents : la contrainte d'unicité des reviews porte sur (projet, demande, commit)
      const onGitlab = await newReview("gitlab", sha);
      const onGithub = await newReview("github", sha.replace(/^./, "f"));
      await h.reviews.saveResult(onGithub, { status: "auto_ok", decisionReasons: [], resultJson: JSON.stringify(reviewOk), changedLines: 1, costUsd: 0, numTurns: 1 });

      await runReview(onGitlab, reviewDeps(runner));
      await publishComment(onGitlab, reviewDeps(runner), false);
      expect(h.connector.postedComments).toHaveLength(1);
      expect(github.postedComments).toHaveLength(0);

      await publishComment(onGithub, reviewDeps(runner), false);
      expect(h.connector.postedComments).toHaveLength(1);
      expect(github.postedComments).toHaveLength(1);
      expect(github.postedComments[0]).toMatchObject({ iid: 7, kind: "review" });
    });

    it("une review dont la forge n'est plus configurée passe en erreur avec un message clair", async () => {
      const sha = h.addMergeRequestRef(7, { "app.js": "x\n" });
      const id = await newReview("github", sha);
      const onlyGitlab = new ForgeRegistry([{ connector: h.connector, workspace: h.workspace, username: "alex" }]);
      const deps = { ...reviewDeps({ run: async () => ({ structured: reviewOk, sessionId: null, costUsd: 0, numTurns: 0 }) }), forges: onlyGitlab };

      await runReview(id, deps);
      expect(await h.reviews.get(id)).toMatchObject({ status: "error" });
      expect((await h.reviews.get(id))!.error).toMatch(/Aucun jeton GitHub enregistré/);

      // Même un commentaire ou une approbation ne partent jamais chez l'autre forge
      await h.reviews.saveResult(id, { status: "auto_ok", decisionReasons: [], resultJson: JSON.stringify(reviewOk), changedLines: 1, costUsd: 0, numTurns: 1 });
      await expect(publishComment(id, deps, false)).rejects.toThrow("Aucun jeton GitHub enregistré");
      await expect(approve(id, deps, false)).rejects.toThrow("Aucun jeton GitHub enregistré");
      expect(h.connector.postedComments).toEqual([]);
      expect(h.connector.approvals).toEqual([]);
    });
  });

  it("poller : les demandes détectées chez GitHub sont enregistrées avec la source « github »", async () => {
    const sha = "a".repeat(40);
    github.reviewRequests = [{ projectId: 1, projectPath: "acme/projet", iid: 7, title: "PR", description: "", state: "opened", draft: false, sourceBranch: "f", targetBranch: "develop", headSha: sha, url: "https://github.com/acme/projet/pull/7", author: { id: 12, username: "collegue", name: "Collègue" }, reviewers: [], labels: [] }];
    const enqueued: number[] = [];

    const stop = startReviewPoller({ connector: github, reviews: h.reviews, settings: h.settings, username: "alex-gh", intervalMs: 60_000, enqueue: (id) => enqueued.push(id) });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();

    expect(enqueued).toHaveLength(1);
    expect(await h.reviews.get(enqueued[0]!)).toMatchObject({ source: "github", project_id: 1, mr_iid: 7, project_path: "acme/projet" });
  });
});
