import { describe, expect, it } from "vitest";
import type { GitlabClient } from "../gitlab/client.js";
import type { GitlabCurrentUser, GitlabIssue, GitlabMergeRequest, GitlabNote } from "../gitlab/types.js";
import { GitlabConnector, toChangeRequest, toComment, toCurrentUser, toTicket } from "./gitlab.js";

const user = { id: 9, username: "collegue", name: "Collègue" };

const mrJson: GitlabMergeRequest = {
  id: 1001,
  iid: 7,
  project_id: 65,
  title: "Resolve « Intégration images »",
  description: "Related to #609",
  state: "opened",
  draft: false,
  source_branch: "feature/609-images",
  target_branch: "globale",
  sha: "a".repeat(40),
  web_url: "https://gitlab.example/groupe/projet/-/merge_requests/7",
  references: { full: "groupe/projet!7" },
  author: user,
  reviewers: [user],
  labels: ["Statut::Validation technique"],
};

const issueJson: GitlabIssue = {
  id: 5,
  iid: 609,
  project_id: 65,
  title: "Import des règles",
  description: "Texte",
  labels: ["Statut::A traiter"],
  web_url: "https://gitlab.example/groupe/projet/-/issues/609",
  updated_at: "2026-11-09T10:00:00Z",
  references: { full: "groupe/projet#609" },
  author: user,
  milestone: { title: "G26_20" },
};

describe("traduction des réponses GitLab", () => {
  it("demande de fusion", () => {
    expect(toChangeRequest(mrJson)).toEqual({
      projectId: 65,
      projectPath: "groupe/projet",
      iid: 7,
      title: "Resolve « Intégration images »",
      description: "Related to #609",
      state: "opened",
      draft: false,
      sourceBranch: "feature/609-images",
      targetBranch: "globale",
      headSha: "a".repeat(40),
      url: "https://gitlab.example/groupe/projet/-/merge_requests/7",
      author: user,
      reviewers: [user],
      labels: ["Statut::Validation technique"],
    });
  });

  it("états : une fusion en cours (locked) compte comme fusionnée", () => {
    expect(toChangeRequest({ ...mrJson, state: "locked" }).state).toBe("merged");
    expect(toChangeRequest({ ...mrJson, state: "merged" }).state).toBe("merged");
    expect(toChangeRequest({ ...mrJson, state: "closed" }).state).toBe("closed");
    expect(toChangeRequest({ ...mrJson, reviewers: undefined }).reviewers).toEqual([]);
  });

  it("ticket, avec et sans les champs facultatifs", () => {
    expect(toTicket(issueJson)).toEqual({
      projectId: 65,
      projectPath: "groupe/projet",
      iid: 609,
      title: "Import des règles",
      description: "Texte",
      labels: ["Statut::A traiter"],
      url: "https://gitlab.example/groupe/projet/-/issues/609",
      updatedAt: "2026-11-09T10:00:00Z",
      milestone: "G26_20",
      author: user,
    });
    const bare = toTicket({ id: 1, iid: 2, project_id: 3, title: "t", description: null, labels: [], web_url: "u" });
    expect(bare).toMatchObject({ projectPath: null, updatedAt: null, milestone: null, author: null });
  });

  it("commentaire : général, sur une ligne du diff, ancienne ligne, messages système", () => {
    const note: GitlabNote = { id: 1, body: "Texte", system: false, author: user, created_at: "2026-11-09T10:00:00Z" };
    expect(toComment(note)).toMatchObject({ position: null, resolvable: false, resolved: false, system: false, createdAt: "2026-11-09T10:00:00Z" });
    expect(toComment({ ...note, position: { new_path: "a.php", new_line: 42 }, resolvable: true, resolved: true })).toMatchObject({
      position: { path: "a.php", line: 42 },
      resolvable: true,
      resolved: true,
    });
    expect(toComment({ ...note, position: { new_path: null, new_line: null, old_path: "b.php", old_line: 7 } }).position).toEqual({ path: "b.php", line: 7 });
    expect(toComment({ ...note, system: true }).system).toBe(true);
  });

  it("adresse de commit : commit_email, puis email, puis email public, puis adresse par défaut", () => {
    const base: GitlabCurrentUser = { ...user };
    expect(toCurrentUser({ ...base, commit_email: "c@x.fr", email: "e@x.fr", public_email: "p@x.fr" }).commitEmail).toBe("c@x.fr");
    expect(toCurrentUser({ ...base, email: "e@x.fr", public_email: "p@x.fr" }).commitEmail).toBe("e@x.fr");
    expect(toCurrentUser({ ...base, public_email: "p@x.fr" }).commitEmail).toBe("p@x.fr");
    expect(toCurrentUser(base).commitEmail).toBe("collegue@users.noreply");
  });
});

describe("GitlabConnector", () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const record =
    <T>(name: string, result: T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push([name, ...args]);
      return result;
    };
  let mrState: GitlabMergeRequest = { ...mrJson, draft: true, title: "Draft: Resolve « Intégration images »" };
  let keepDraft = false;
  const client = {
    createMergeRequest: record("createMergeRequest", mrJson),
    createMergeRequestDiscussion: record("discussion", { id: "d1" }),
    createMergeRequestNote: record("note", { id: 2 }),
    approveMergeRequest: record("approve", {}),
    addIssueLabels: record("addIssueLabels", issueJson),
    getProtectedBranches: record("protected", [{ name: "main" }, { name: "release/*" }]),
    getIssue: async (_p: number, iid: number) => (iid === 404 ? null : issueJson),
    getMergeRequest: async () => mrState,
    updateMergeRequestTitle: async (p: number, i: number, title: string) => {
      calls.push(["title", p, i, title]);
      if (!keepDraft) mrState = { ...mrState, title, draft: false };
      return mrState;
    },
    mergeMergeRequest: record("merge", mrJson),
    createIssue: record("createIssue", { ...issueJson, iid: 700, title: "Ajouter un export", labels: ["Statut::A traiter"], web_url: "https://gitlab.example/groupe/projet/-/issues/700" }),
    listProjectIssues: record("listProjectIssues", [issueJson]),
    createProject: record("createProject", { id: 90, name: "Mon outil", path_with_namespace: "groupe/mon-outil", description: "d", http_url_to_repo: "https://gitlab.example/groupe/mon-outil.git", web_url: "https://gitlab.example/groupe/mon-outil" }),
    listCreatableGroups: record("groups", [{ id: 12, name: "Groupe", full_path: "groupe" }]),
    getCurrentUser: async () => ({ ...user, username: "moi" }),
    getNamespace: async (path: string) => ({ id: 3, name: "Moi", full_path: path }),
    getProjectByPath: async (path: string) => ({ id: 65, name: "projet", path_with_namespace: path, description: null, http_url_to_repo: "https://gitlab.example/x.git", web_url: "u" }),
  } as unknown as GitlabClient;
  const connector = new GitlabConnector(client, "jeton");

  it("expose les identifiants git et la référence de la tête d'une MR", () => {
    expect(connector.kind).toBe("gitlab");
    expect(connector.gitCredentials()).toEqual({ username: "oauth2", token: "jeton" });
    expect(connector.changeRequestHeadRef(12)).toBe("refs/merge-requests/12/head");
  });

  it("crée une demande de fusion avec les noms de champs de GitLab", async () => {
    const cr = await connector.createChangeRequest(65, { sourceBranch: "feature/1-x", targetBranch: "develop", title: "Draft: x", description: "d", assigneeId: 7, removeSourceBranch: false });
    expect(calls.at(-1)).toEqual([
      "createMergeRequest",
      65,
      { source_branch: "feature/1-x", target_branch: "develop", title: "Draft: x", description: "d", assignee_id: 7, remove_source_branch: false },
    ]);
    expect(cr.iid).toBe(7);
    expect(cr.url).toBe("https://gitlab.example/groupe/projet/-/merge_requests/7");
  });

  it("une review est un fil de discussion, un rapport d'agent est un simple commentaire", async () => {
    calls.length = 0;
    await connector.commentOnChangeRequest(65, 7, "corps de review", "review");
    expect(calls).toEqual([["discussion", 65, 7, "corps de review"]]);
    calls.length = 0;
    await connector.commentOnChangeRequest(65, 7, "rapport", "note");
    expect(calls).toEqual([["note", 65, 7, "rapport"]]);
  });

  it("l'approbation transmet le commit relu", async () => {
    calls.length = 0;
    await connector.approveChangeRequest(65, 7, "b".repeat(40));
    expect(calls).toEqual([["approve", 65, 7, "b".repeat(40)]]);
  });

  it("ticket introuvable : null ; branches protégées : leurs noms ; labels", async () => {
    expect(await connector.getTicket(65, 404)).toBeNull();
    expect((await connector.getTicket(65, 609))?.iid).toBe(609);
    expect(await connector.getProtectedBranches(65)).toEqual(["main", "release/*"]);
    calls.length = 0;
    await connector.addTicketLabels(65, 609, ["Statut::En cours"]);
    expect(calls).toEqual([["addIssueLabels", 65, 609, ["Statut::En cours"]]]);
  });

  it("crée un ticket avec les noms de champs de GitLab et rend un ticket neutre", async () => {
    calls.length = 0;
    const ticket = await connector.createTicket(65, { title: "Ajouter un export", description: "texte", labels: ["Statut::A traiter"] });
    expect(calls).toEqual([["createIssue", 65, { title: "Ajouter un export", description: "texte", labels: ["Statut::A traiter"] }]]);
    expect(ticket).toMatchObject({ projectId: 65, iid: 700, title: "Ajouter un export", url: "https://gitlab.example/groupe/projet/-/issues/700" });
  });

  it("liste les tickets ouverts d'un projet, quel que soit l'assigné", async () => {
    const tickets = await connector.listProjectTickets(65);
    expect(tickets.map((t) => t.iid)).toEqual([609]);
  });

  it("propose l'espace personnel puis les groupes, et crée un projet privé dans le groupe choisi", async () => {
    expect(await connector.listNamespaces()).toEqual([
      { id: "3", path: "moi", name: "Moi", kind: "personal" },
      { id: "12", path: "groupe", name: "Groupe", kind: "group" },
    ]);
    calls.length = 0;
    const project = await connector.createProject({ name: "Mon outil", description: "d", namespaceId: "12", private: true, withReadme: true });
    expect(calls).toEqual([["createProject", { name: "Mon outil", description: "d", namespace_id: 12, visibility: "private", initialize_with_readme: true }]]);
    expect(project).toMatchObject({ id: 90, path: "groupe/mon-outil" });
    // Sans groupe : l'espace personnel (GitLab le choisit) ; un groupe qui n'est pas un numéro est refusé avant tout appel
    calls.length = 0;
    await connector.createProject({ name: "Perso", description: "", private: false, withReadme: false });
    expect(calls[0]).toEqual(["createProject", { name: "Perso", description: "", namespace_id: undefined, visibility: "public", initialize_with_readme: false }]);
    await expect(connector.createProject({ name: "x", description: "", namespaceId: "../admin", private: true, withReadme: true })).rejects.toThrow("Groupe invalide");
  });

  it("sortie du brouillon : GitLab retire « Draft: » du titre ; sans effet si la MR n'est pas en brouillon ; échec si elle y reste", async () => {
    calls.length = 0;
    await connector.markChangeRequestReady(65, 7);
    expect(calls).toEqual([["title", 65, 7, "Resolve « Intégration images »"]]);

    calls.length = 0;
    await connector.markChangeRequestReady(65, 7); // déjà sortie du brouillon par l'appel précédent
    expect(calls).toEqual([]);

    mrState = { ...mrJson, draft: true, title: "[Draft] Autre titre" };
    calls.length = 0;
    await connector.markChangeRequestReady(65, 7);
    expect(calls).toEqual([["title", 65, 7, "Autre titre"]]);

    mrState = { ...mrJson, draft: true, title: "Titre sans préfixe" };
    keepDraft = true;
    await expect(connector.markChangeRequestReady(65, 7)).rejects.toThrow("reste en brouillon");
    keepDraft = false;
  });

  it("fusion : le commit relu est transmis à GitLab", async () => {
    calls.length = 0;
    await connector.mergeChangeRequest(65, 7, "d".repeat(40));
    expect(calls).toEqual([["merge", 65, 7, "d".repeat(40)]]);
  });

  it("reconnaît l'URL d'une merge request, et seulement celle-là", async () => {
    expect(await connector.resolveChangeRequestUrl("https://gitlab.example/groupe/sous-groupe/projet/-/merge_requests/715")).toEqual({ projectId: 65, iid: 715 });
    expect(await connector.resolveChangeRequestUrl("https://gitlab.example/groupe/projet/-/issues/3")).toBeNull();
    expect(await connector.resolveChangeRequestUrl("65")).toBeNull();
  });
});
