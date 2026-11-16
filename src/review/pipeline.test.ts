import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../agent/runner.js";
import type { ChangeRequest } from "../connectors/types.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { REVIEW_MARKER } from "./format.js";
import { approve, publishComment, runReview, type PipelineDeps } from "./pipeline.js";

const BACKENDS = ["sqlite", "postgres"] as const;

const reviewOk = { summary: "RAS", verdict: "approve", coverage: "full", ci_failure_related: false, injection_suspected: false, findings: [], positives: ["Clair"], questions_for_author: [] };
const reviewBlocking = {
  ...reviewOk,
  verdict: "request_changes",
  findings: [{ severity: "blocking", confirmed: true, title: "Bug", location: "app.js:1", explanation: "Casse tout" }],
};

type RecordingRunner = AgentRunner & { requests: AgentRequest[]; fileSeen: string[] };

/** Faux exécuteur de review : note ce que l'agent verrait dans son dossier de travail, puis renvoie le résultat. */
function runnerReturning(structured: unknown): RecordingRunner {
  const requests: AgentRequest[] = [];
  const fileSeen: string[] = [];
  return {
    requests,
    fileSeen,
    async run(req) {
      requests.push(req);
      fileSeen.push(readFileSync(path.join(req.cwd, "app.js"), "utf8"));
      return { structured, sessionId: null, costUsd: 0.02, numTurns: 4 };
    },
  };
}

describe.each(BACKENDS)("review, de bout en bout, base %s (faux connecteur, vrai dépôt git local)", (backend) => {
  let h: Harness;
  let sha: string;
  let cr: ChangeRequest;

  const deps = (runner: AgentRunner, extra: Partial<PipelineDeps> = {}): PipelineDeps => ({
    config: h.config,
    forges: h.forges,
    costs: h.costs,
    reviews: h.reviews,
    settings: h.settings,
    runner,
    ...extra,
  });
  const newReview = async (headSha = sha) =>
    (await h.reviews.insertIfNew({ projectId: 1, projectPath: "groupe/projet", mrIid: 7, mrTitle: cr.title, mrUrl: cr.url, author: "Collègue", headSha }))!;

  beforeEach(async () => {
    h = await createHarness(backend);
    sha = h.addMergeRequestRef(7, { "app.js": "export const x = 3;\n" });
    cr = {
      projectId: 1,
      projectPath: "groupe/projet",
      iid: 7,
      title: "#609 - Import",
      description: "Related to #609",
      state: "opened",
      draft: false,
      sourceBranch: "feature/609-import",
      targetBranch: "develop",
      headSha: sha,
      url: "https://forge.example/groupe/projet/-/merge_requests/7",
      author: { id: 9, username: "collegue", name: "Collègue" },
      reviewers: [h.connector.me],
      labels: [],
    };
    h.connector.changeRequests.set(7, cr);
    h.connector.diffs.set(7, [{ oldPath: "app.js", newPath: "app.js", diff: "-export const x = 1;\n+export const x = 3;\n", isNew: false, isDeleted: false, isRenamed: false }]);
    h.connector.commits.set(7, [{ shortId: "abc1234", title: "Change x", authorName: "Collègue" }]);
    h.connector.checkStatuses = [{ name: "phpunit", status: "success" }];
    h.connector.tickets.set(609, h.ticket());
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("mode ombre : l'agent voit le code au commit relu, et rien n'est publié", async () => {
    const runner = runnerReturning(reviewOk);
    const id = await newReview();
    await runReview(id, deps(runner, { forceShadow: true }));

    const row = (await h.reviews.get(id))!;
    expect(row.error).toBeNull();
    expect(row.status).toBe("auto_ok");

    expect(runner.fileSeen).toEqual(["export const x = 3;\n"]); // extrait au sha de la MR, pas sur develop
    const req = runner.requests[0]!;
    expect(req.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(req.persistSession).toBe(false);
    expect(req.stream).toBe(false);
    expect(req.prompt).toContain("+export const x = 3;");
    expect(req.prompt).toContain("Importer un fichier Excel"); // ticket lié, trouvé par #609
    expect(req.prompt).toContain("**phpunit** : success");
    expect(req.prompt).toContain("`abc1234` Change x (Collègue)");

    expect(h.connector.postedComments).toEqual([]);
    expect(h.connector.approvals).toEqual([]);
  });

  it("un point bloquant demande ton analyse", async () => {
    const id = await newReview();
    await runReview(id, deps(runnerReturning(reviewBlocking), { forceShadow: true }));

    const row = (await h.reviews.get(id))!;
    expect(row.status).toBe("needs_human");
    expect(row.decision_reasons).toContain("1 point(s) bloquant(s)");
  });

  it("publication et approbation : le commentaire est un fil de review, l'approbation porte le commit relu", async () => {
    const id = await newReview();
    const d = deps(runnerReturning(reviewOk), { forceShadow: true });
    await runReview(id, d);

    await publishComment(id, d, false);
    expect(h.connector.postedComments).toHaveLength(1);
    expect(h.connector.postedComments[0]).toMatchObject({ iid: 7, kind: "review" });
    expect(h.connector.postedComments[0]!.body).toContain(REVIEW_MARKER);
    expect((await h.reviews.get(id))!.status).toBe("published");

    await approve(id, d, false);
    expect(h.connector.approvals).toEqual([{ iid: 7, headSha: sha }]);
    expect((await h.reviews.get(id))!.status).toBe("approved");
  });

  it("MR passée à un autre commit depuis la détection : review abandonnée sans lancer l'agent", async () => {
    const runner = runnerReturning(reviewOk);
    const id = await newReview();
    cr.headSha = "f".repeat(40);
    await runReview(id, deps(runner, { forceShadow: true }));

    expect((await h.reviews.get(id))!.status).toBe("dismissed");
    expect(runner.requests).toHaveLength(0);
  });

  it("modes d'action : « commentaire » publie seul, « auto » approuve aussi, mais jamais un point à analyser", async () => {
    await h.settings.save({ ...(await h.settings.get()), actionMode: "comment" });
    const id1 = await newReview();
    await runReview(id1, deps(runnerReturning(reviewOk)));
    expect((await h.reviews.get(id1))!.status).toBe("published");
    expect(h.connector.approvals).toEqual([]);

    await h.settings.save({ ...(await h.settings.get()), actionMode: "auto" });
    const sha2 = h.addMergeRequestRef(8, { "app.js": "export const x = 4;\n" });
    cr.headSha = sha2;
    h.connector.changeRequests.set(8, { ...cr, iid: 8, headSha: sha2 });
    const id2 = (await h.reviews.insertIfNew({ projectId: 1, projectPath: "groupe/projet", mrIid: 8, mrTitle: "Autre", mrUrl: "u", author: "Collègue", headSha: sha2 }))!;
    await runReview(id2, deps(runnerReturning(reviewOk)));
    expect((await h.reviews.get(id2))!.status).toBe("approved");
    expect(h.connector.approvals).toEqual([{ iid: 8, headSha: sha2 }]);

    const sha3 = h.addMergeRequestRef(9, { "app.js": "export const x = 5;\n" });
    h.connector.changeRequests.set(9, { ...cr, iid: 9, headSha: sha3 });
    const id3 = (await h.reviews.insertIfNew({ projectId: 1, projectPath: "groupe/projet", mrIid: 9, mrTitle: "Risquée", mrUrl: "u", author: "Collègue", headSha: sha3 }))!;
    await runReview(id3, deps(runnerReturning(reviewBlocking)));
    expect((await h.reviews.get(id3))!.status).toBe("needs_human");
    expect(h.connector.approvals).toHaveLength(1);
  });

  it("review de la MR de l'agent dev (la tienne) : même en mode « auto », jamais de commentaire ni d'approbation automatiques", async () => {
    await h.settings.save({ ...(await h.settings.get()), actionMode: "auto" });
    // La MR a été ouverte par l'utilisateur de l'outil (l'agent dev agit en son nom) : auteur = utilisateur de la forge
    h.connector.changeRequests.set(7, { ...cr, author: h.connector.me });
    const id = await newReview();
    await runReview(id, deps(runnerReturning(reviewOk)));

    expect((await h.reviews.get(id))!.status).toBe("auto_ok"); // la review est faite et lisible
    expect(h.connector.postedComments).toEqual([]);
    expect(h.connector.approvals).toEqual([]);
  });
});
