import type {
  GitlabBranch,
  GitlabCommit,
  GitlabCommitStatus,
  GitlabCurrentUser,
  GitlabDiff,
  GitlabIssue,
  GitlabMergeRequest,
  GitlabNamespace,
  GitlabNote,
  GitlabProject,
  GitlabProtectedBranch,
} from "./types.js";

export class GitlabError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    body: string,
  ) {
    super(`GitLab ${method} ${path} → ${status} : ${body.slice(0, 500)}`);
    this.name = "GitlabError";
  }
}

/**
 * Client minimal de l'API GitLab v4 (fetch natif, pas de dépendance).
 * Méthodes ajoutées au fil des besoins.
 */
export class GitlabClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  // --- Lecture ---------------------------------------------------------------

  /** MR ouvertes, hors draft, où l'utilisateur est reviewer. */
  listReviewRequests(username: string): Promise<GitlabMergeRequest[]> {
    const qs = new URLSearchParams({ scope: "all", state: "opened", reviewer_username: username, wip: "no" });
    return this.getAll<GitlabMergeRequest>(`/merge_requests?${qs}`);
  }

  getProject(projectId: number): Promise<GitlabProject> {
    return this.request("GET", `/projects/${projectId}`);
  }

  /** ex. "groupe/sous-groupe/projet" */
  getProjectByPath(projectPath: string): Promise<GitlabProject> {
    return this.request("GET", `/projects/${encodeURIComponent(projectPath)}`);
  }

  getMergeRequest(projectId: number, mrIid: number): Promise<GitlabMergeRequest> {
    return this.request("GET", `/projects/${projectId}/merge_requests/${mrIid}`);
  }

  /** Remplace l'endpoint /changes déprécié (dépréciation GitLab). */
  getMergeRequestDiffs(projectId: number, mrIid: number): Promise<GitlabDiff[]> {
    return this.getAll(`/projects/${projectId}/merge_requests/${mrIid}/diffs`);
  }

  getMergeRequestCommits(projectId: number, mrIid: number): Promise<GitlabCommit[]> {
    return this.getAll(`/projects/${projectId}/merge_requests/${mrIid}/commits`);
  }

  getCommitStatuses(projectId: number, sha: string): Promise<GitlabCommitStatus[]> {
    return this.getAll(`/projects/${projectId}/repository/commits/${sha}/statuses`);
  }

  async getIssue(projectId: number, issueIid: number): Promise<GitlabIssue | null> {
    try {
      return await this.request<GitlabIssue>("GET", `/projects/${projectId}/issues/${issueIid}`);
    } catch (err) {
      if (err instanceof GitlabError && err.status === 404) return null;
      throw err;
    }
  }

  /** Tickets ouverts d'un projet, les plus récemment modifiés d'abord (100 au plus). */
  listProjectIssues(projectId: number): Promise<GitlabIssue[]> {
    return this.request("GET", `/projects/${projectId}/issues?state=opened&order_by=updated_at&per_page=100`);
  }

  /** Groupes où la personne a au moins le rôle Developer (c'est là qu'on peut en général créer un projet). */
  listCreatableGroups(): Promise<GitlabNamespace[]> {
    return this.request("GET", "/groups?min_access_level=30&order_by=path&per_page=100");
  }

  /** Espace de noms personnel (« moi/ »), retrouvé par le nom d'utilisateur. */
  getNamespace(path: string): Promise<GitlabNamespace> {
    return this.request("GET", `/namespaces/${encodeURIComponent(path)}`);
  }

  getCurrentUser(): Promise<GitlabCurrentUser> {
    return this.request("GET", "/user");
  }

  /** Tickets ouverts assignés à l'utilisateur du token, tous projets confondus. */
  listAssignedIssues(): Promise<GitlabIssue[]> {
    return this.getAll("/issues?scope=assigned_to_me&state=opened&order_by=updated_at");
  }

  getIssueNotes(projectId: number, issueIid: number): Promise<GitlabNote[]> {
    return this.getAll(`/projects/${projectId}/issues/${issueIid}/notes?sort=asc&order_by=created_at`);
  }

  /** Projets dont l'utilisateur est membre (recherche pour la page Paramètres). */
  searchProjects(search: string): Promise<GitlabProject[]> {
    const qs = new URLSearchParams({ membership: "true", simple: "true", search, per_page: "20", order_by: "last_activity_at" });
    return this.request("GET", `/projects?${qs}`);
  }

  listBranches(projectId: number, search = ""): Promise<GitlabBranch[]> {
    const qs = new URLSearchParams({ per_page: "50", ...(search ? { search } : {}) });
    return this.request("GET", `/projects/${projectId}/repository/branches?${qs}`);
  }

  getProtectedBranches(projectId: number): Promise<GitlabProtectedBranch[]> {
    return this.getAll(`/projects/${projectId}/protected_branches`);
  }

  async branchExists(projectId: number, branch: string): Promise<boolean> {
    try {
      await this.request("GET", `/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`);
      return true;
    } catch (err) {
      if (err instanceof GitlabError && err.status === 404) return false;
      throw err;
    }
  }

  // --- Écriture --------------------------------------------------------------

  createMergeRequest(
    projectId: number,
    mr: { source_branch: string; target_branch: string; title: string; description: string; assignee_id?: number; remove_source_branch?: boolean },
  ): Promise<GitlabMergeRequest> {
    return this.request("POST", `/projects/${projectId}/merge_requests`, mr);
  }

  /** Ajoute des labels (les labels scopés `Statut::x` remplacent automatiquement l'ancien du même scope). */
  addIssueLabels(projectId: number, issueIid: number, labels: string[]): Promise<GitlabIssue> {
    return this.request("PUT", `/projects/${projectId}/issues/${issueIid}`, { add_labels: labels.join(",") });
  }

  /** Change le titre d'une MR (c'est ainsi que GitLab sort une MR du brouillon : le préfixe « Draft: » disparaît). */
  updateMergeRequestTitle(projectId: number, mrIid: number, title: string): Promise<GitlabMergeRequest> {
    return this.request("PUT", `/projects/${projectId}/merge_requests/${mrIid}`, { title });
  }

  /** Fusionne la MR seulement si sa tête est toujours `sha` (GitLab répond 409 sinon) ; la branche source est conservée. */
  mergeMergeRequest(projectId: number, mrIid: number, sha: string): Promise<GitlabMergeRequest> {
    return this.request("PUT", `/projects/${projectId}/merge_requests/${mrIid}/merge`, { sha, should_remove_source_branch: false });
  }

  /** Commentaires de la MR (généraux et sur le diff), dans l'ordre chronologique. */
  getMergeRequestNotes(projectId: number, mrIid: number): Promise<GitlabNote[]> {
    return this.getAll(`/projects/${projectId}/merge_requests/${mrIid}/notes?sort=asc&order_by=created_at`);
  }

  createMergeRequestNote(projectId: number, mrIid: number, body: string): Promise<GitlabNote> {
    return this.request("POST", `/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
  }

  createMergeRequestDiscussion(projectId: number, mrIid: number, body: string): Promise<{ id: string }> {
    return this.request("POST", `/projects/${projectId}/merge_requests/${mrIid}/discussions`, { body });
  }

  /**
   * Approuve la MR uniquement si sa tête est toujours `sha` : si un nouveau commit a été poussé
   * entre la review et l'approbation, GitLab refuse : on n'approuve jamais du code non reviewé.
   */
  approveMergeRequest(projectId: number, mrIid: number, sha: string): Promise<unknown> {
    return this.request("POST", `/projects/${projectId}/merge_requests/${mrIid}/approve`, { sha });
  }

  /** Crée un projet. Sans `namespace_id`, GitLab le met dans l'espace personnel. */
  createProject(project: { name: string; description: string; namespace_id?: number; visibility: "private" | "internal" | "public"; initialize_with_readme: boolean }): Promise<GitlabProject> {
    return this.request("POST", "/projects", project);
  }

  /**
   * Création d'un ticket (Scribe). Par défaut il est assigné à l'utilisateur du jeton : un ticket dicté au Scribe est le sien et apparaît dans
   * « Mes tickets ». L'assignation est un confort : si l'utilisateur n'est pas lisible, le ticket est créé sans assigné plutôt que de ne pas l'être.
   */
  async createIssue(projectId: number, issue: { title: string; description: string; labels?: string[] }, assignToMe = true): Promise<GitlabIssue> {
    const meId = assignToMe ? await this.tokenUserId() : null;
    return this.request("POST", `/projects/${projectId}/issues`, {
      title: issue.title,
      description: issue.description,
      labels: issue.labels?.join(","),
      ...(meId !== null ? { assignee_ids: [meId] } : {}),
    });
  }

  /**
   * Envoie un fichier au projet (`POST /projects/:id/uploads`, formulaire multipart). GitLab répond avec le Markdown à coller dans un ticket.
   * @param projectId Projet.
   * @param name Nom du fichier (déjà assaini).
   * @param bytes Contenu.
   * @returns Le Markdown du fichier envoyé (par exemple `![capture](/uploads/ab12.../capture.png)`).
   */
  async uploadFile(projectId: number, name: string, bytes: Uint8Array): Promise<{ markdown: string }> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), name);
    const path = `/projects/${projectId}/uploads`;
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, { method: "POST", headers: { "PRIVATE-TOKEN": this.token }, body: form });
    if (!res.ok) throw new GitlabError("POST", path, res.status, await res.text());
    const data = (await res.json()) as { markdown?: unknown };
    if (typeof data.markdown !== "string") throw new Error("GitLab n'a pas renvoyé le lien du fichier envoyé");
    return { markdown: data.markdown };
  }

  private meId: number | null | undefined;
  /** Identifiant de l'utilisateur du jeton (lu une fois), ou null s'il ne peut pas être lu. */
  private async tokenUserId(): Promise<number | null> {
    if (this.meId === undefined) this.meId = await this.getCurrentUser().then((u) => u.id, () => null);
    return this.meId;
  }

  // --- Transport -------------------------------------------------------------

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers: {
        "PRIVATE-TOKEN": this.token,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GitlabError(method, path, res.status, await res.text());
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Suit la pagination GitLab (header x-next-page). */
  private async getAll<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    let page = "1";

    while (page) {
      const res = await fetch(`${this.baseUrl}/api/v4${path}${sep}per_page=100&page=${page}`, {
        headers: { "PRIVATE-TOKEN": this.token },
      });
      if (!res.ok) throw new GitlabError("GET", path, res.status, await res.text());
      items.push(...((await res.json()) as T[]));
      page = res.headers.get("x-next-page") ?? "";
    }
    return items;
  }
}
