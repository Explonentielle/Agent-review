import type {
  GitlabBranch,
  GitlabCommit,
  GitlabCommitStatus,
  GitlabCurrentUser,
  GitlabDiff,
  GitlabIssue,
  GitlabMergeRequest,
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

  /** Phase 4 : création d'une issue à partir d'un ticket support validé. */
  createIssue(projectId: number, issue: { title: string; description: string; labels?: string[] }): Promise<GitlabIssue> {
    return this.request("POST", `/projects/${projectId}/issues`, {
      title: issue.title,
      description: issue.description,
      labels: issue.labels?.join(","),
    });
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
