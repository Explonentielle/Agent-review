import type {
  GithubBranch,
  GithubCheckRun,
  GithubCommit,
  GithubCommitStatus,
  GithubFile,
  GithubIssue,
  GithubIssueComment,
  GithubOrg,
  GithubPull,
  GithubRepo,
  GithubReview,
  GithubReviewComment,
  GithubSearchItem,
  GithubUser,
} from "./types.js";

export class GithubError extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    public readonly status: number,
    body: string,
  ) {
    super(`GitHub ${method} ${path} → ${status} : ${body.slice(0, 500)}`);
    this.name = "GithubError";
  }
}

/** Nom complet d'un dépôt : proprietaire/depot, sans rien qui puisse sortir du chemin d'API. */
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Identifiant d'organisation : lettres, chiffres et tirets, rien qui puisse sortir du chemin d'API. */
const ORG_LOGIN = /^[A-Za-z0-9-]+$/;

/** Garde-fou contre une pagination qui ne finirait pas : 100 éléments par page. */
const MAX_PAGES = 30;

/**
 * Client minimal de l'API REST GitHub (fetch natif, pas de dépendance).
 * Les dépôts sont désignés par leur nom complet (proprietaire/depot) : la traduction depuis
 * l'identifiant numérique est faite par le connecteur.
 */
export class GithubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  // --- Lecture ---------------------------------------------------------------

  getCurrentUser(): Promise<GithubUser> {
    return this.request("GET", "/user");
  }

  getRepoById(id: number): Promise<GithubRepo> {
    return this.request("GET", `/repositories/${id}`);
  }

  getRepo(fullName: string): Promise<GithubRepo> {
    return this.request("GET", `/repos/${repoPath(fullName)}`);
  }

  /** Dépôts auxquels le jeton donne accès, les plus récemment actifs d'abord (3 pages au plus). */
  listAccessibleRepos(): Promise<GithubRepo[]> {
    return this.getAll("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed", 3);
  }

  listBranches(fullName: string, protectedOnly = false): Promise<GithubBranch[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/branches${protectedOnly ? "?protected=true" : ""}`);
  }

  async branchExists(fullName: string, branch: string): Promise<boolean> {
    return (await this.requestOrNull(`/repos/${repoPath(fullName)}/branches/${branchPath(branch)}`)) !== null;
  }

  /** Tickets ouverts assignés à l'utilisateur du jeton, tous dépôts confondus (les PR y figurent aussi). */
  listAssignedIssues(): Promise<GithubIssue[]> {
    return this.getAll("/issues?filter=assigned&state=open&sort=updated");
  }

  /** Tickets ouverts d'un dépôt, les plus récemment modifiés d'abord (100 au plus ; les PR y figurent aussi). */
  listRepoIssues(fullName: string): Promise<GithubIssue[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/issues?state=open&sort=updated`, 1);
  }

  /** Organisations dont la personne est membre. */
  listOrgs(): Promise<GithubOrg[]> {
    return this.getAll("/user/orgs");
  }

  getIssue(fullName: string, number: number): Promise<GithubIssue | null> {
    return this.requestOrNull(`/repos/${repoPath(fullName)}/issues/${number}`);
  }

  getIssueComments(fullName: string, number: number): Promise<GithubIssueComment[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/issues/${number}/comments`);
  }

  /** PR ouvertes, hors brouillon, dont `login` est relecteur demandé. */
  async searchReviewRequests(login: string): Promise<GithubSearchItem[]> {
    if (!/^[A-Za-z0-9-]+(\[bot\])?$/.test(login)) throw new Error(`Identifiant GitHub invalide : ${login}`);
    const qs = new URLSearchParams({ q: `is:pr is:open draft:false review-requested:${login}` });
    return this.getAll(`/search/issues?${qs}`, 3, (page) => (page as { items: GithubSearchItem[] }).items);
  }

  getPull(fullName: string, number: number): Promise<GithubPull> {
    return this.request("GET", `/repos/${repoPath(fullName)}/pulls/${number}`);
  }

  getPullFiles(fullName: string, number: number): Promise<GithubFile[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/pulls/${number}/files`);
  }

  getPullCommits(fullName: string, number: number): Promise<GithubCommit[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/pulls/${number}/commits`);
  }

  getPullReviewComments(fullName: string, number: number): Promise<GithubReviewComment[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/pulls/${number}/comments`);
  }

  getPullReviews(fullName: string, number: number): Promise<GithubReview[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/pulls/${number}/reviews`);
  }

  getCheckRuns(fullName: string, sha: string): Promise<GithubCheckRun[]> {
    return this.getAll(`/repos/${repoPath(fullName)}/commits/${sha}/check-runs`, MAX_PAGES, (page) => (page as { check_runs: GithubCheckRun[] }).check_runs);
  }

  async getCommitStatuses(fullName: string, sha: string): Promise<GithubCommitStatus[]> {
    const combined = await this.request<{ statuses: GithubCommitStatus[] }>("GET", `/repos/${repoPath(fullName)}/commits/${sha}/status`);
    return combined.statuses;
  }

  // --- Écriture --------------------------------------------------------------

  createPull(fullName: string, pull: { title: string; head: string; base: string; body: string; draft: boolean }): Promise<GithubPull> {
    return this.request("POST", `/repos/${repoPath(fullName)}/pulls`, pull);
  }

  createIssue(fullName: string, issue: { title: string; body: string; labels?: string[] }): Promise<GithubIssue> {
    return this.request("POST", `/repos/${repoPath(fullName)}/issues`, issue);
  }

  /** Crée un dépôt dans le compte de la personne, ou dans une organisation si `org` est donné. */
  createRepo(repo: { name: string; description: string; private: boolean; auto_init: boolean }, org?: string): Promise<GithubRepo> {
    if (org !== undefined && !ORG_LOGIN.test(org)) throw new Error(`Nom d'organisation invalide : ${org}`);
    return this.request("POST", org !== undefined ? `/orgs/${org}/repos` : "/user/repos", repo);
  }

  /** Fusionne la PR seulement si sa tête est toujours `sha` (GitHub répond 409 sinon). Fusion normale ; la branche source est conservée. */
  mergePull(fullName: string, number: number, sha: string): Promise<unknown> {
    return this.request("PUT", `/repos/${repoPath(fullName)}/pulls/${number}/merge`, { sha, merge_method: "merge" });
  }

  /** Sort une PR du brouillon : seule l'API GraphQL le permet. */
  async markPullReady(nodeId: string): Promise<void> {
    const url = this.baseUrl.endsWith("/api/v3") ? this.baseUrl.replace(/\/v3$/, "/graphql") : `${this.baseUrl}/graphql`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }", variables: { id: nodeId } }),
    });
    if (!res.ok) throw new GithubError("POST", "/graphql", res.status, await res.text());
    const out = (await res.json()) as { errors?: Array<{ message: string }> };
    if (out.errors?.length) throw new GithubError("POST", "/graphql", 422, out.errors.map((e) => e.message).join(" ; "));
  }

  addAssignees(fullName: string, number: number, logins: string[]): Promise<unknown> {
    return this.request("POST", `/repos/${repoPath(fullName)}/issues/${number}/assignees`, { assignees: logins });
  }

  addIssueLabels(fullName: string, number: number, labels: string[]): Promise<unknown> {
    return this.request("POST", `/repos/${repoPath(fullName)}/issues/${number}/labels`, { labels });
  }

  removeIssueLabel(fullName: string, number: number, label: string): Promise<unknown> {
    return this.requestOrNull(`/repos/${repoPath(fullName)}/issues/${number}/labels/${encodeURIComponent(label)}`, "DELETE");
  }

  createIssueComment(fullName: string, number: number, body: string): Promise<GithubIssueComment> {
    return this.request("POST", `/repos/${repoPath(fullName)}/issues/${number}/comments`, { body });
  }

  /**
   * Soumet une review sur le commit `commitId`. GitHub ne refuse pas une review sur un commit qui
   * n'est plus la tête : c'est au connecteur de vérifier la tête avant d'approuver.
   */
  createReview(fullName: string, number: number, review: { event: "COMMENT" | "APPROVE"; body?: string; commit_id?: string }): Promise<unknown> {
    return this.request("POST", `/repos/${repoPath(fullName)}/pulls/${number}/reviews`, review);
  }

  // --- Transport -------------------------------------------------------------

  private headers(withBody: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "review-agent",
      ...(withBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new GithubError(method, path, res.status, await res.text());
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Comme `request`, mais renvoie null quand la ressource n'existe pas (404). */
  private async requestOrNull<T>(path: string, method = "GET"): Promise<T | null> {
    try {
      return await this.request<T>(method, path);
    } catch (err) {
      if (err instanceof GithubError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Suit la pagination GitHub (header Link, rel="next"). `pick` extrait la liste quand la réponse
   * est un objet (recherche, check-runs) plutôt qu'un tableau.
   */
  private async getAll<T>(path: string, maxPages = MAX_PAGES, pick?: (page: unknown) => T[]): Promise<T[]> {
    const items: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    let url: string | null = `${this.baseUrl}${path}${sep}per_page=100`;

    for (let page = 0; url && page < maxPages; page++) {
      const res: Response = await fetch(url, { headers: this.headers(false) });
      if (!res.ok) throw new GithubError("GET", path, res.status, await res.text());
      const data: unknown = await res.json();
      items.push(...(pick ? pick(data) : (data as T[])));
      url = nextLink(res.headers.get("link"), this.baseUrl);
    }
    return items;
  }
}

/** URL de la page suivante d'un header Link, uniquement si elle reste sur le même serveur (le jeton n'en sort jamais). */
function nextLink(header: string | null, baseUrl: string): string | null {
  const next = header?.split(",").find((part) => /rel="next"/.test(part));
  const url = next?.match(/<([^>]+)>/)?.[1];
  return url && url.startsWith(`${baseUrl}/`) ? url : null;
}

export const isRepoFullName = (value: string): boolean => FULL_NAME.test(value);

function repoPath(fullName: string): string {
  if (!isRepoFullName(fullName)) throw new Error(`Nom de dépôt invalide : ${fullName}`);
  return fullName;
}

/** Nom de branche pour une URL : chaque segment encodé, les « / » conservés. */
function branchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}
