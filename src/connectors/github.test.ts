import { describe, expect, it } from "vitest";
import type { GithubClient } from "../github/client.js";
import type { GithubCheckRun, GithubCommit, GithubFile, GithubIssue, GithubPull, GithubRepo, GithubReview, GithubReviewComment, GithubUser } from "../github/types.js";
import { GithubConnector, toChangeRequest, toCheckRunStatus, toCommit, toCommitStatus, toCurrentUser, toDiff, toReviewBody, toReviewComment, toTicket } from "./github.js";

// Réponses construites d'après la documentation de l'API REST GitHub (pas enregistrées sur un vrai compte).
const alex: GithubUser = { id: 9, login: "alex", name: "Alex Martin" };
const collegue: GithubUser = { id: 12, login: "collegue" };

const repo: GithubRepo = {
  id: 321,
  name: "projet",
  full_name: "acme/projet",
  description: "Un projet",
  clone_url: "https://github.com/acme/projet.git",
  html_url: "https://github.com/acme/projet",
  default_branch: "main",
};

const pull: GithubPull = {
  id: 1001,
  number: 7,
  title: "#609 Import des règles",
  body: "Related to #609",
  state: "open",
  draft: false,
  merged_at: null,
  html_url: "https://github.com/acme/projet/pull/7",
  user: collegue,
  requested_reviewers: [alex],
  labels: [{ name: "Statut::Validation technique" }],
  head: { ref: "feature/609-import", sha: "a".repeat(40) },
  base: { ref: "develop", repo },
};

const issue: GithubIssue = {
  id: 5,
  number: 609,
  title: "Import des règles",
  body: "Texte",
  state: "open",
  labels: [{ name: "Statut::A traiter" }, "bug"],
  html_url: "https://github.com/acme/projet/issues/609",
  updated_at: "2026-11-10T10:00:00Z",
  user: collegue,
  milestone: { title: "G26_20" },
  repository: repo,
};

describe("traduction des réponses GitHub", () => {
  it("pull request en demande de fusion", () => {
    expect(toChangeRequest(pull)).toEqual({
      projectId: 321,
      projectPath: "acme/projet",
      iid: 7,
      title: "#609 Import des règles",
      description: "Related to #609",
      state: "opened",
      draft: false,
      sourceBranch: "feature/609-import",
      targetBranch: "develop",
      headSha: "a".repeat(40),
      url: "https://github.com/acme/projet/pull/7",
      author: { id: 12, username: "collegue", name: "collegue" },
      reviewers: [{ id: 9, username: "alex", name: "Alex Martin" }],
      labels: ["Statut::Validation technique"],
    });
  });

  it("états : fermée sans fusion, fusionnée, brouillon absent, auteur supprimé, aucun relecteur", () => {
    expect(toChangeRequest({ ...pull, state: "closed" }).state).toBe("closed");
    expect(toChangeRequest({ ...pull, state: "closed", merged_at: "2026-11-10T12:00:00Z" }).state).toBe("merged");
    expect(toChangeRequest({ ...pull, draft: undefined }).draft).toBe(false);
    expect(toChangeRequest({ ...pull, draft: true }).draft).toBe(true);
    expect(toChangeRequest({ ...pull, user: null }).author).toEqual({ id: 0, username: "ghost", name: "ghost" });
    expect(toChangeRequest({ ...pull, requested_reviewers: undefined }).reviewers).toEqual([]);
  });

  it("ticket : labels objets ou texte, dépôt fourni, champs facultatifs", () => {
    expect(toTicket(issue, 321, "acme/projet")).toEqual({
      projectId: 321,
      projectPath: "acme/projet",
      iid: 609,
      title: "Import des règles",
      description: "Texte",
      labels: ["Statut::A traiter", "bug"],
      url: "https://github.com/acme/projet/issues/609",
      updatedAt: "2026-11-10T10:00:00Z",
      milestone: "G26_20",
      author: { id: 12, username: "collegue", name: "collegue" },
    });
    expect(toTicket({ ...issue, user: null, milestone: null, body: null }, 321, "acme/projet")).toMatchObject({ author: null, milestone: null, description: null });
  });

  it("fichiers modifiés : ajouté, supprimé, renommé, sans patch (binaire ou trop gros)", () => {
    const file = (f: Partial<GithubFile>): GithubFile => ({ filename: "a.php", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b", ...f });

    expect(toDiff(file({}))).toEqual({ oldPath: "a.php", newPath: "a.php", diff: "@@ -1 +1 @@\n-a\n+b", isNew: false, isDeleted: false, isRenamed: false });
    expect(toDiff(file({ status: "added" }))).toMatchObject({ isNew: true });
    expect(toDiff(file({ status: "removed" }))).toMatchObject({ isDeleted: true });
    expect(toDiff(file({ filename: "b.php", previous_filename: "a.php", status: "renamed" }))).toMatchObject({ oldPath: "a.php", newPath: "b.php", isRenamed: true });
    expect(toDiff(file({ patch: undefined })).diff).toBe("");
  });

  it("commit : identifiant court, première ligne du message, auteur absent", () => {
    const commit: GithubCommit = { sha: "abcdef0123456789", commit: { message: "Change x\n\nDétails", author: { name: "Alex" } } };

    expect(toCommit(commit)).toEqual({ shortId: "abcdef0", title: "Change x", authorName: "Alex" });
    expect(toCommit({ ...commit, commit: { message: "Seul", author: null } })).toEqual({ shortId: "abcdef0", title: "Seul", authorName: "" });
  });

  it("vérifications : les mêmes mots que GitLab", () => {
    const run = (status: string, conclusion: string | null): GithubCheckRun => ({ name: "phpunit", status, conclusion });

    expect(toCheckRunStatus(run("completed", "success")).status).toBe("success");
    expect(toCheckRunStatus(run("completed", "neutral")).status).toBe("success");
    expect(toCheckRunStatus(run("completed", "skipped")).status).toBe("skipped");
    expect(toCheckRunStatus(run("completed", "cancelled")).status).toBe("canceled");
    expect(toCheckRunStatus(run("completed", "action_required")).status).toBe("manual");
    for (const conclusion of ["failure", "timed_out", "startup_failure", "stale"]) expect(toCheckRunStatus(run("completed", conclusion)).status).toBe("failed");
    expect(toCheckRunStatus(run("queued", null)).status).toBe("pending");
    expect(toCheckRunStatus(run("in_progress", null)).status).toBe("running");
    expect(toCheckRunStatus(run("completed", "success")).name).toBe("phpunit");

    expect(toCommitStatus({ context: "ci/legacy", state: "success" })).toEqual({ name: "ci/legacy", status: "success" });
    expect(toCommitStatus({ context: "ci/legacy", state: "pending" }).status).toBe("pending");
    expect(toCommitStatus({ context: "ci/legacy", state: "error" }).status).toBe("failed");
    expect(toCommitStatus({ context: "ci/legacy", state: "failure" }).status).toBe("failed");
  });

  it("commentaires : ligne du diff (ligne actuelle, sinon d'origine), reviews sans texte ou en brouillon ignorées", () => {
    const inline: GithubReviewComment = { id: 1, body: "Ici", user: alex, created_at: "2026-11-10T10:00:00Z", path: "a.php", line: 42 };

    expect(toReviewComment(inline)).toMatchObject({ position: { path: "a.php", line: 42 }, resolvable: false, resolved: false, system: false });
    expect(toReviewComment({ ...inline, line: null, original_line: 7 }).position).toEqual({ path: "a.php", line: 7 });
    expect(toReviewComment({ ...inline, line: undefined, original_line: undefined }).position).toEqual({ path: "a.php", line: null });

    const review: GithubReview = { id: 3, body: "Texte de la review", user: alex, submitted_at: "2026-11-10T11:00:00Z" };
    expect(toReviewBody(review)).toMatchObject({ id: 3, body: "Texte de la review", createdAt: "2026-11-10T11:00:00Z", position: null });
    expect(toReviewBody({ ...review, body: "" })).toBeNull();
    expect(toReviewBody({ ...review, body: null })).toBeNull();
    expect(toReviewBody({ ...review, submitted_at: null })).toBeNull();
  });

  it("adresse de commit : celle du compte, sinon l'adresse anonyme de GitHub", () => {
    expect(toCurrentUser({ ...alex, email: "alex@example.com" })).toEqual({ id: 9, username: "alex", name: "Alex Martin", commitEmail: "alex@example.com" });
    expect(toCurrentUser({ ...alex, email: null }).commitEmail).toBe("9+alex@users.noreply.github.com");
    expect(toCurrentUser(alex).commitEmail).toBe("9+alex@users.noreply.github.com");
  });
});

/** Faux client : les méthodes d'écriture et de lecture sont notées dans `calls`, les réponses viennent de `answers`. */
function setup(answers: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const client = new Proxy(
    {},
    {
      get: (_target, name: string) => async (...args: unknown[]) => {
        calls.push([name, ...args]);
        const answer = answers[name];
        if (typeof answer === "function") return (answer as (...a: unknown[]) => unknown)(...args);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  ) as unknown as GithubClient;
  return { connector: new GithubConnector(client, "jeton-de-test"), calls, count: (name: string) => calls.filter(([n]) => n === name).length };
}

describe("GithubConnector", () => {
  it("expose les identifiants git et la référence de la tête d'une PR", () => {
    const { connector } = setup();

    expect(connector.kind).toBe("github");
    expect(connector.gitCredentials()).toEqual({ username: "x-access-token", token: "jeton-de-test" });
    expect(connector.changeRequestHeadRef(12)).toBe("refs/pull/12/head");
  });

  it("reconnaît l'URL d'une PR, rien d'autre", async () => {
    const { connector, count } = setup({ getRepo: repo });

    expect(await connector.resolveChangeRequestUrl("https://github.com/acme/projet/pull/12/files")).toEqual({ projectId: 321, iid: 12 });
    expect(await connector.resolveChangeRequestUrl("https://gitlab.example/groupe/projet/-/merge_requests/12")).toBeNull();
    expect(await connector.resolveChangeRequestUrl("https://github.com/acme/projet/issues/12")).toBeNull();
    expect(await connector.resolveChangeRequestUrl("https://github.com/a%20b/projet/pull/12")).toBeNull();
    expect(count("getRepo")).toBe(1);
  });

  it("retrouve le dépôt à partir de son identifiant, une seule fois", async () => {
    const { connector, count } = setup({ getRepoById: repo, getIssue: issue, getIssueComments: [] });

    expect(await connector.getProject(321)).toEqual({ id: 321, path: "acme/projet", name: "projet", description: "Un projet", cloneUrl: "https://github.com/acme/projet.git", url: "https://github.com/acme/projet" });
    await connector.getTicket(321, 609);
    await connector.getTicketComments(321, 609);
    expect(count("getRepoById")).toBe(1);
  });

  it("tickets assignés : les PR sont écartées, les dépôts mémorisés", async () => {
    const pullAsIssue: GithubIssue = { ...issue, number: 7, pull_request: {} };
    const { connector, count } = setup({ listAssignedIssues: [issue, pullAsIssue, { ...issue, number: 700, repository: undefined }], getIssue: issue });

    const tickets = await connector.listAssignedTickets();
    expect(tickets.map((t) => t.iid)).toEqual([609]);
    expect(tickets[0]).toMatchObject({ projectId: 321, projectPath: "acme/projet" });

    await connector.getTicket(321, 609);
    expect(count("getRepoById")).toBe(0);
  });

  it("un ticket introuvable, ou qui est en fait une PR, donne null", async () => {
    const { connector } = setup({ getRepoById: repo, getIssue: (_f: string, n: number) => (n === 7 ? { ...issue, number: 7, pull_request: {} } : n === 404 ? null : issue) });

    expect(await connector.getTicket(321, 609)).toMatchObject({ iid: 609 });
    expect(await connector.getTicket(321, 7)).toBeNull();
    expect(await connector.getTicket(321, 404)).toBeNull();
  });

  describe("labels", () => {
    it("un label à portée remplace les autres de la même portée, comme sur GitLab", async () => {
      const labels = ["Statut::A traiter", "Statut::En cours", "Statut::Validation technique", "Priorité::Haute", "bug"];
      const { connector, calls } = setup({ getRepoById: repo, getIssue: { ...issue, labels } });

      await connector.addTicketLabels(321, 609, ["Statut::Validation technique"]);

      expect(calls.filter(([n]) => n === "addIssueLabels")).toEqual([["addIssueLabels", "acme/projet", 609, ["Statut::Validation technique"]]]);
      expect(calls.filter(([n]) => n === "removeIssueLabel").map(([, , , label]) => label)).toEqual(["Statut::A traiter", "Statut::En cours"]);
    });

    it("l'ajout passe avant le retrait : si l'ajout échoue, rien n'est retiré", async () => {
      const { connector, count } = setup({ getRepoById: repo, addIssueLabels: new Error("refusé"), getIssue: issue });

      await expect(connector.addTicketLabels(321, 609, ["Statut::En cours"])).rejects.toThrow("refusé");
      expect(count("removeIssueLabel")).toBe(0);
    });

    it("un label sans portée est simplement ajouté", async () => {
      const { connector, count } = setup({ getRepoById: repo });

      await connector.addTicketLabels(321, 609, ["bug"]);
      expect(count("addIssueLabels")).toBe(1);
      expect(count("getIssue")).toBe(0);
      expect(count("removeIssueLabel")).toBe(0);
    });
  });

  describe("demandes de fusion", () => {
    const searchResults = [
      { number: 7, repository_url: "https://api.github.com/repos/acme/projet" },
      { number: 8, repository_url: "https://api.github.com/repos/acme/projet" },
      { number: 9, repository_url: "inattendu" },
    ];

    it("PR où un avis est demandé : recherche, puis détail de chaque PR, brouillons écartés", async () => {
      const { connector, calls, count } = setup({
        searchReviewRequests: searchResults,
        getPull: (_f: string, n: number) => (n === 8 ? { ...pull, number: 8, draft: true } : pull),
      });

      const requests = await connector.listReviewRequests("alex");
      expect(requests.map((r) => r.iid)).toEqual([7]);
      expect(requests[0]).toMatchObject({ projectId: 321, projectPath: "acme/projet", headSha: "a".repeat(40) });
      expect(calls[0]).toEqual(["searchReviewRequests", "alex"]);
      expect(count("getPull")).toBe(2); // la troisième n'a pas d'adresse de dépôt lisible
      await connector.getChangeRequest(321, 7);
      expect(count("getRepoById")).toBe(0); // le dépôt a été mémorisé au passage
    });

    it("commentaires : généraux, sur le diff et texte des reviews, triés par date", async () => {
      const { connector } = setup({
        getRepoById: repo,
        getIssueComments: [{ id: 1, body: "général", user: alex, created_at: "2026-11-10T10:00:00Z" }],
        getPullReviewComments: [{ id: 2, body: "sur la ligne", user: collegue, created_at: "2026-11-10T09:00:00Z", path: "a.php", line: 3 }],
        getPullReviews: [
          { id: 3, body: "review envoyée par l'outil", user: alex, submitted_at: "2026-11-10T11:00:00Z" },
          { id: 4, body: "brouillon", user: alex, submitted_at: null },
          { id: 5, body: "", user: alex, submitted_at: "2026-11-10T12:00:00Z" },
        ],
      });

      const comments = await connector.getChangeRequestComments(321, 7);
      expect(comments.map((c) => c.id)).toEqual([2, 1, 3]);
      expect(comments[0]!.position).toEqual({ path: "a.php", line: 3 });
    });

    it("vérifications : jobs et statuts classiques réunis", async () => {
      const { connector, calls } = setup({
        getRepoById: repo,
        getCheckRuns: [{ name: "phpunit", status: "completed", conclusion: "failure" }],
        getCommitStatuses: [{ context: "ci/legacy", state: "success" }],
      });

      expect(await connector.getCheckStatuses(321, "a".repeat(40))).toEqual([
        { name: "phpunit", status: "failed" },
        { name: "ci/legacy", status: "success" },
      ]);
      expect(calls.find(([n]) => n === "getCheckRuns")).toEqual(["getCheckRuns", "acme/projet", "a".repeat(40)]);
    });

    it("diffs et commits passent par le nom complet du dépôt", async () => {
      const { connector } = setup({
        getRepoById: repo,
        getPullFiles: [{ filename: "a.php", status: "added", patch: "@@ -0,0 +1 @@\n+x" }],
        getPullCommits: [{ sha: "abcdef0123", commit: { message: "Change x", author: { name: "Alex" } } }],
      });

      expect(await connector.getChangeRequestDiffs(321, 7)).toEqual([{ oldPath: "a.php", newPath: "a.php", diff: "@@ -0,0 +1 @@\n+x", isNew: true, isDeleted: false, isRenamed: false }]);
      expect(await connector.getChangeRequestCommits(321, 7)).toEqual([{ shortId: "abcdef0", title: "Change x", authorName: "Alex" }]);
    });
  });

  describe("création d'une PR", () => {
    const input = { sourceBranch: "feature/609-import", targetBranch: "develop", title: "Draft: #609 Import", description: "Corps", assigneeId: 9, removeSourceBranch: false };

    it("un titre « Draft: » donne un brouillon sans préfixe, un titre normal une PR prête", async () => {
      const { connector, calls } = setup({ getRepoById: repo, createPull: pull, getCurrentUser: alex, addAssignees: {} });

      const cr = await connector.createChangeRequest(321, input);
      expect(calls.find(([n]) => n === "createPull")).toEqual(["createPull", "acme/projet", { title: "#609 Import", head: "feature/609-import", base: "develop", body: "Corps", draft: true }]);
      expect(cr).toMatchObject({ iid: 7, projectId: 321 });

      await connector.createChangeRequest(321, { ...input, title: "Correctif simple" });
      expect(calls.filter(([n]) => n === "createPull").at(-1)![2]).toMatchObject({ title: "Correctif simple", draft: false });
      await connector.createChangeRequest(321, { ...input, title: "WIP : à finir" });
      expect(calls.filter(([n]) => n === "createPull").at(-1)![2]).toMatchObject({ title: "à finir", draft: true });
    });

    it("la PR est assignée à l'utilisateur de l'outil, pas à un autre", async () => {
      const { connector, calls } = setup({ getRepoById: repo, createPull: pull, getCurrentUser: alex, addAssignees: {} });

      await connector.createChangeRequest(321, input);
      expect(calls.find(([n]) => n === "addAssignees")).toEqual(["addAssignees", "acme/projet", 7, ["alex"]]);

      await connector.createChangeRequest(321, { ...input, assigneeId: 999 });
      await connector.createChangeRequest(321, { ...input, assigneeId: undefined });
      expect(calls.filter(([n]) => n === "addAssignees")).toHaveLength(1);
    });

    it("si l'assignation échoue, la PR créée est conservée", async () => {
      const { connector } = setup({ getRepoById: repo, createPull: pull, getCurrentUser: alex, addAssignees: new Error("utilisateur non assignable") });

      await expect(connector.createChangeRequest(321, input)).resolves.toMatchObject({ iid: 7 });
    });

    it("si la création échoue, l'erreur remonte", async () => {
      const { connector, count } = setup({ getRepoById: repo, createPull: new Error("422 : branche inconnue") });

      await expect(connector.createChangeRequest(321, input)).rejects.toThrow("branche inconnue");
      expect(count("addAssignees")).toBe(0);
    });
  });

  describe("commentaires et approbation", () => {
    it("« review » envoie une review de type commentaire, « note » un commentaire général", async () => {
      const { connector, calls } = setup({ getRepoById: repo });

      await connector.commentOnChangeRequest(321, 7, "Texte A", "review");
      await connector.commentOnChangeRequest(321, 7, "Texte B", "note");
      expect(calls.filter(([n]) => n === "createReview")).toEqual([["createReview", "acme/projet", 7, { event: "COMMENT", body: "Texte A" }]]);
      expect(calls.filter(([n]) => n === "createIssueComment")).toEqual([["createIssueComment", "acme/projet", 7, "Texte B"]]);
    });

    it("approuve le commit relu quand c'est toujours la tête", async () => {
      const { connector, calls } = setup({ getRepoById: repo, getPull: pull });

      await connector.approveChangeRequest(321, 7, "a".repeat(40));
      expect(calls.find(([n]) => n === "createReview")).toEqual(["createReview", "acme/projet", 7, { event: "APPROVE", commit_id: "a".repeat(40) }]);
    });

    it("refuse d'approuver quand un commit a été poussé depuis la review", async () => {
      const { connector, count } = setup({ getRepoById: repo, getPull: { ...pull, head: { ref: "feature/609-import", sha: "b".repeat(40) } } });

      await expect(connector.approveChangeRequest(321, 7, "a".repeat(40))).rejects.toThrow("nouveau commit");
      expect(count("createReview")).toBe(0);
    });
  });

  describe("projets et branches", () => {
    it("recherche : filtre sur le nom complet, 20 résultats au plus", async () => {
      const many = Array.from({ length: 30 }, (_, i): GithubRepo => ({ ...repo, id: 1000 + i, name: `outil-${i}`, full_name: `acme/outil-${i}` }));
      const { connector } = setup({ listAccessibleRepos: [repo, ...many] });

      expect((await connector.searchProjects("PROJET")).map((p) => p.path)).toEqual(["acme/projet"]);
      expect(await connector.searchProjects("outil")).toHaveLength(20);
      expect(await connector.searchProjects("")).toHaveLength(20);
    });

    it("branches : défaut et protection, filtre de recherche", async () => {
      const { connector } = setup({
        getRepoById: repo,
        listBranches: (_f: string, protectedOnly?: boolean) => (protectedOnly ? [{ name: "main", protected: true }] : [{ name: "main", protected: true }, { name: "develop", protected: false }, { name: "feature/x", protected: false }]),
      });

      expect(await connector.listBranches(321)).toEqual([
        { name: "main", isDefault: true, isProtected: true },
        { name: "develop", isDefault: false, isProtected: false },
        { name: "feature/x", isDefault: false, isProtected: false },
      ]);
      expect((await connector.listBranches(321, "FEAT")).map((b) => b.name)).toEqual(["feature/x"]);
      expect(await connector.getProtectedBranches(321)).toEqual(["main"]);
    });

    it("existence d'une branche : transmise au client avec le nom complet du dépôt", async () => {
      const { connector, calls } = setup({ getRepoById: repo, branchExists: true });

      expect(await connector.branchExists(321, "feature/609-import")).toBe(true);
      expect(calls.find(([n]) => n === "branchExists")).toEqual(["branchExists", "acme/projet", "feature/609-import"]);
    });

    it("utilisateur courant : mémorisé pour les assignations", async () => {
      const { connector, count } = setup({ getCurrentUser: { ...alex, email: "alex@example.com" } });

      expect(await connector.getCurrentUser()).toMatchObject({ username: "alex", commitEmail: "alex@example.com" });
      await connector.getCurrentUser();
      expect(count("getCurrentUser")).toBe(1);
    });
  });
});
