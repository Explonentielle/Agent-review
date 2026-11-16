import { GithubClient, isRepoFullName } from "../github/client.js";
import type {
  GithubCheckRun,
  GithubCommit,
  GithubCommitStatus,
  GithubFile,
  GithubIssue,
  GithubIssueComment,
  GithubLabel,
  GithubPull,
  GithubRepo,
  GithubReview,
  GithubReviewComment,
  GithubUser,
} from "../github/types.js";
import { errorMessage, log } from "../logger.js";
import type {
  Branch,
  ChangeRequest,
  CheckStatus,
  Comment,
  CommentKind,
  Commit,
  CurrentUser,
  Diff,
  ForgeConnector,
  GitCredentials,
  Namespace,
  NewChangeRequest,
  NewProject,
  NewTicket,
  Person,
  Project,
  Ticket,
} from "./types.js";

// --- Traduction GitHub vers le vocabulaire neutre ---------------------------------

/** Compte supprimé : GitHub renvoie parfois un auteur null. */
const GHOST: Person = { id: 0, username: "ghost", name: "ghost" };

const toPerson = (u: GithubUser | null | undefined): Person => (u ? { id: u.id, username: u.login, name: u.name || u.login } : GHOST);

const labelNames = (labels: Array<GithubLabel | string>): string[] => labels.map((l) => (typeof l === "string" ? l : l.name));

export function toCurrentUser(u: GithubUser): CurrentUser {
  return { ...toPerson(u), commitEmail: u.email || `${u.id}+${u.login}@users.noreply.github.com` };
}

export function toProject(r: GithubRepo): Project {
  return { id: r.id, path: r.full_name, name: r.name, description: r.description, cloneUrl: r.clone_url, url: r.html_url };
}

export function toTicket(i: GithubIssue, projectId: number, projectPath: string): Ticket {
  return {
    projectId,
    projectPath,
    iid: i.number,
    title: i.title,
    description: i.body,
    labels: labelNames(i.labels),
    url: i.html_url,
    updatedAt: i.updated_at ?? null,
    milestone: i.milestone?.title ?? null,
    author: i.user ? toPerson(i.user) : null,
  };
}

export function toChangeRequest(pull: GithubPull): ChangeRequest {
  return {
    projectId: pull.base.repo.id,
    projectPath: pull.base.repo.full_name,
    iid: pull.number,
    title: pull.title,
    description: pull.body,
    state: pull.state === "open" ? "opened" : pull.merged_at ? "merged" : "closed",
    draft: pull.draft ?? false,
    sourceBranch: pull.head.ref,
    targetBranch: pull.base.ref,
    headSha: pull.head.sha,
    url: pull.html_url,
    author: toPerson(pull.user),
    reviewers: (pull.requested_reviewers ?? []).map(toPerson),
    labels: labelNames(pull.labels),
  };
}

export const toDiff = (f: GithubFile): Diff => ({
  oldPath: f.previous_filename ?? f.filename,
  newPath: f.filename,
  diff: f.patch ?? "",
  isNew: f.status === "added",
  isDeleted: f.status === "removed",
  isRenamed: f.status === "renamed",
});

export const toCommit = (c: GithubCommit): Commit => ({
  shortId: c.sha.slice(0, 7),
  title: c.commit.message.split("\n")[0] ?? "",
  authorName: c.commit.author?.name ?? "",
});

/** Reprend les mots de GitLab (success, failed, running...) pour que les prompts ne changent pas selon la forge. */
export function toCheckRunStatus(run: GithubCheckRun): CheckStatus {
  let status: string;
  if (run.status !== "completed") status = run.status === "queued" ? "pending" : "running";
  else if (run.conclusion === "success" || run.conclusion === "neutral") status = "success";
  else if (run.conclusion === "skipped") status = "skipped";
  else if (run.conclusion === "cancelled") status = "canceled";
  else if (run.conclusion === "action_required") status = "manual";
  else status = "failed";
  return { name: run.name, status };
}

export const toCommitStatus = (s: GithubCommitStatus): CheckStatus => ({
  name: s.context,
  status: s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failed",
});

const noThread = { position: null, resolvable: false, resolved: false } as const;

export const toIssueComment = (c: GithubIssueComment): Comment => ({ id: c.id, body: c.body, system: false, author: toPerson(c.user), createdAt: c.created_at, ...noThread });

/** L'état « résolu » d'un fil n'est pas dans l'API REST : il est laissé inconnu (non résolvable) plutôt qu'inventé. */
export const toReviewComment = (c: GithubReviewComment): Comment => ({
  ...toIssueComment(c),
  position: { path: c.path, line: c.line ?? c.original_line ?? null },
});

/** Le texte d'une review soumise est un commentaire général ; les reviews sans texte ou en brouillon sont ignorées. */
export function toReviewBody(r: GithubReview): Comment | null {
  if (!r.body || !r.submitted_at) return null;
  return { id: r.id, body: r.body, system: false, author: toPerson(r.user), createdAt: r.submitted_at, ...noThread };
}

/** Portée d'un label « Portée::valeur » : tout ce qui précède le dernier « :: ». */
const scopeOf = (label: string): string | null => (label.includes("::") ? label.slice(0, label.lastIndexOf("::")) : null);

/** Nom de dépôt accepté par GitHub. */
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const DRAFT_PREFIX = /^\s*(?:draft|wip)\s*:\s*/i;

// --- Connecteur ---------------------------------------------------------------------

/**
 * Connecteur GitHub (API REST) : enveloppe `GithubClient` et traduit ses réponses.
 *
 * L'identifiant de projet du vocabulaire neutre est l'identifiant numérique du dépôt ; le client
 * travaille avec son nom complet, retrouvé et mis en cache par `repo()`.
 */
export class GithubConnector implements ForgeConnector {
  readonly kind = "github" as const;

  private readonly repos = new Map<number, GithubRepo>();
  private cachedUser: GithubUser | null = null;

  constructor(
    private readonly client: GithubClient,
    private readonly token: string,
  ) {}

  static fromConfig(github: { apiUrl: string; token: string }): GithubConnector {
    return new GithubConnector(new GithubClient(github.apiUrl.replace(/\/+$/, ""), github.token), github.token);
  }

  gitCredentials(): GitCredentials {
    return { username: "x-access-token", token: this.token };
  }

  changeRequestHeadRef(iid: number): string {
    return `refs/pull/${iid}/head`;
  }

  async resolveChangeRequestUrl(url: string): Promise<{ projectId: number; iid: number } | null> {
    const m = url.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!m || !isRepoFullName(m[1]!)) return null;
    const repo = this.remember(await this.client.getRepo(m[1]!));
    return { projectId: repo.id, iid: Number(m[2]) };
  }

  async getCurrentUser(): Promise<CurrentUser> {
    return toCurrentUser(await this.user());
  }

  async getProject(projectId: number): Promise<Project> {
    return toProject(await this.repo(projectId));
  }

  async searchProjects(search: string): Promise<Project[]> {
    const needle = search.toLowerCase();
    const repos = (await this.client.listAccessibleRepos()).map((r) => this.remember(r));
    return repos
      .filter((r) => r.full_name.toLowerCase().includes(needle))
      .slice(0, 20)
      .map(toProject);
  }

  async listBranches(projectId: number, search = ""): Promise<Branch[]> {
    const repo = await this.repo(projectId);
    const needle = search.toLowerCase();
    return (await this.client.listBranches(repo.full_name))
      .filter((b) => b.name.toLowerCase().includes(needle))
      .slice(0, 50)
      .map((b) => ({ name: b.name, isDefault: b.name === repo.default_branch, isProtected: b.protected }));
  }

  /** Branches protégées par nom exact : les motifs et les règles d'ensemble (rulesets) ne sont pas exposés par cette API. */
  async getProtectedBranches(projectId: number): Promise<string[]> {
    const repo = await this.repo(projectId);
    return (await this.client.listBranches(repo.full_name, true)).map((b) => b.name);
  }

  async branchExists(projectId: number, branch: string): Promise<boolean> {
    return this.client.branchExists((await this.repo(projectId)).full_name, branch);
  }

  async listNamespaces(): Promise<Namespace[]> {
    const me = await this.user();
    const orgs = await this.client.listOrgs();
    return [{ id: me.login, path: me.login, name: me.name || me.login, kind: "personal" }, ...orgs.map((o): Namespace => ({ id: o.login, path: o.login, name: o.login, kind: "group" }))];
  }

  /** Dépôt dans le compte de la personne, ou dans l'organisation choisie. */
  async createProject(input: NewProject): Promise<Project> {
    if (!REPO_NAME.test(input.name)) throw new Error("Nom de dépôt invalide : lettres, chiffres, tirets, points et soulignés seulement.");
    const me = await this.user();
    const org = input.namespaceId !== undefined && input.namespaceId !== me.login ? input.namespaceId : undefined;
    const repo = await this.client.createRepo({ name: input.name, description: input.description, private: input.private, auto_init: input.withReadme }, org);
    return toProject(this.remember(repo));
  }

  async listProjectTickets(projectId: number): Promise<Ticket[]> {
    const repo = await this.repo(projectId);
    return (await this.client.listRepoIssues(repo.full_name)).filter((i) => !i.pull_request).map((i) => toTicket(i, repo.id, repo.full_name));
  }

  async createTicket(projectId: number, input: NewTicket): Promise<Ticket> {
    const repo = await this.repo(projectId);
    const issue = await this.client.createIssue(repo.full_name, { title: input.title, body: input.description, labels: input.labels?.length ? input.labels : undefined });
    return toTicket(issue, repo.id, repo.full_name);
  }

  /** GitHub n'a pas d'API publique pour joindre un fichier à un ticket : le fichier reste côté outil, à la disposition de l'agent dev. */
  async uploadTicketFile(): Promise<null> {
    return null;
  }

  async listAssignedTickets(): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    for (const issue of await this.client.listAssignedIssues()) {
      if (issue.pull_request || !issue.repository) continue;
      const repo = this.remember(issue.repository);
      tickets.push(toTicket(issue, repo.id, repo.full_name));
    }
    return tickets;
  }

  async getTicket(projectId: number, iid: number): Promise<Ticket | null> {
    const repo = await this.repo(projectId);
    const issue = await this.client.getIssue(repo.full_name, iid);
    return issue && !issue.pull_request ? toTicket(issue, repo.id, repo.full_name) : null;
  }

  async getTicketComments(projectId: number, iid: number): Promise<Comment[]> {
    const repo = await this.repo(projectId);
    return (await this.client.getIssueComments(repo.full_name, iid)).map(toIssueComment);
  }

  /**
   * Ajoute les labels. GitHub n'a pas de labels à portée : pour « Portée::valeur », les autres labels
   * de la même portée sont retirés, comme le fait GitLab. Ajout d'abord, retrait ensuite : en cas
   * d'échec, le ticket ne perd pas son statut.
   */
  async addTicketLabels(projectId: number, iid: number, labels: string[]): Promise<void> {
    const repo = await this.repo(projectId);
    await this.client.addIssueLabels(repo.full_name, iid, labels);

    const scopes = new Set(labels.map(scopeOf).filter((s): s is string => s !== null));
    if (scopes.size === 0) return;
    const issue = await this.client.getIssue(repo.full_name, iid);
    for (const existing of labelNames(issue?.labels ?? [])) {
      const scope = scopeOf(existing);
      if (scope !== null && scopes.has(scope) && !labels.includes(existing)) await this.client.removeIssueLabel(repo.full_name, iid, existing);
    }
  }

  /**
   * PR ouvertes, hors brouillon, où un avis de l'utilisateur est demandé. GitHub retire la demande
   * dès que la review est soumise : un nouveau commit ne relance une review que si l'avis est redemandé.
   */
  async listReviewRequests(username: string): Promise<ChangeRequest[]> {
    const requests: ChangeRequest[] = [];
    for (const item of await this.client.searchReviewRequests(username)) {
      const fullName = item.repository_url.match(/\/repos\/([^/]+\/[^/]+)$/)?.[1];
      if (!fullName) continue;
      const pull = await this.client.getPull(fullName, item.number);
      this.remember(pull.base.repo);
      if (!pull.draft) requests.push(toChangeRequest(pull));
    }
    return requests;
  }

  async getChangeRequest(projectId: number, iid: number): Promise<ChangeRequest> {
    const repo = await this.repo(projectId);
    return toChangeRequest(await this.client.getPull(repo.full_name, iid));
  }

  async getChangeRequestDiffs(projectId: number, iid: number): Promise<Diff[]> {
    const repo = await this.repo(projectId);
    return (await this.client.getPullFiles(repo.full_name, iid)).map(toDiff);
  }

  async getChangeRequestCommits(projectId: number, iid: number): Promise<Commit[]> {
    const repo = await this.repo(projectId);
    return (await this.client.getPullCommits(repo.full_name, iid)).map(toCommit);
  }

  /** Commentaires généraux, commentaires sur le diff et texte des reviews, dans l'ordre chronologique. */
  async getChangeRequestComments(projectId: number, iid: number): Promise<Comment[]> {
    const repo = await this.repo(projectId);
    const [general, inline, reviews] = await Promise.all([
      this.client.getIssueComments(repo.full_name, iid),
      this.client.getPullReviewComments(repo.full_name, iid),
      this.client.getPullReviews(repo.full_name, iid),
    ]);
    const bodies = reviews.map(toReviewBody).filter((c): c is Comment => c !== null);
    return [...general.map(toIssueComment), ...inline.map(toReviewComment), ...bodies].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getCheckStatuses(projectId: number, sha: string): Promise<CheckStatus[]> {
    const repo = await this.repo(projectId);
    const [runs, statuses] = await Promise.all([this.client.getCheckRuns(repo.full_name, sha), this.client.getCommitStatuses(repo.full_name, sha)]);
    return [...runs.map(toCheckRunStatus), ...statuses.map(toCommitStatus)];
  }

  /**
   * Ouvre une PR. Un titre qui commence par « Draft: » demande un brouillon : le préfixe est retiré
   * (GitHub affiche l'état à part). `removeSourceBranch` est ignoré : GitHub le règle par dépôt, pas par PR.
   * L'assignation n'est qu'un confort : un échec est journalisé, la PR créée est conservée.
   */
  async createChangeRequest(projectId: number, input: NewChangeRequest): Promise<ChangeRequest> {
    const repo = await this.repo(projectId);
    const pull = await this.client.createPull(repo.full_name, {
      title: input.title.replace(DRAFT_PREFIX, ""),
      head: input.sourceBranch,
      base: input.targetBranch,
      body: input.description,
      draft: DRAFT_PREFIX.test(input.title),
    });
    if (input.assigneeId !== undefined) await this.assignToMe(repo.full_name, pull.number, input.assigneeId);
    return toChangeRequest(pull);
  }

  /** `review` : review de type commentaire. `note` : commentaire général de la PR. */
  async commentOnChangeRequest(projectId: number, iid: number, body: string, kind: CommentKind): Promise<void> {
    const repo = await this.repo(projectId);
    if (kind === "review") await this.client.createReview(repo.full_name, iid, { event: "COMMENT", body });
    else await this.client.createIssueComment(repo.full_name, iid, body);
  }

  /**
   * GitHub accepte une approbation sur un commit qui n'est plus la tête : la tête est donc vérifiée
   * ici, et l'approbation est faite sur ce commit précis. On n'approuve jamais du code non relu.
   */
  async approveChangeRequest(projectId: number, iid: number, headSha: string): Promise<void> {
    const repo = await this.repo(projectId);
    const pull = await this.client.getPull(repo.full_name, iid);
    if (pull.head.sha !== headSha) throw new Error(`La PR #${iid} a reçu un nouveau commit depuis la review : approbation refusée`);
    await this.client.createReview(repo.full_name, iid, { event: "APPROVE", commit_id: headSha });
  }

  /** Sort la PR du brouillon (API GraphQL). Sans effet si elle n'est pas en brouillon. */
  async markChangeRequestReady(projectId: number, iid: number): Promise<void> {
    const repo = await this.repo(projectId);
    const pull = await this.client.getPull(repo.full_name, iid);
    if (!pull.draft) return;
    if (!pull.node_id) throw new Error(`La PR #${iid} n'a pas d'identifiant global : retire-lui son statut de brouillon chez GitHub`);
    await this.client.markPullReady(pull.node_id);
  }

  async mergeChangeRequest(projectId: number, iid: number, headSha: string): Promise<void> {
    const repo = await this.repo(projectId);
    await this.client.mergePull(repo.full_name, iid, headSha);
  }

  // --- Interne -------------------------------------------------------------------------

  private remember(repo: GithubRepo): GithubRepo {
    this.repos.set(repo.id, repo);
    return repo;
  }

  private async repo(projectId: number): Promise<GithubRepo> {
    return this.repos.get(projectId) ?? this.remember(await this.client.getRepoById(projectId));
  }

  private async user(): Promise<GithubUser> {
    return (this.cachedUser ??= await this.client.getCurrentUser());
  }

  private async assignToMe(fullName: string, number: number, assigneeId: number): Promise<void> {
    try {
      const me = await this.user();
      if (me.id === assigneeId) await this.client.addAssignees(fullName, number, [me.login]);
    } catch (err) {
      log.warn("github.assign_failed", { repo: fullName, number, error: errorMessage(err) });
    }
  }
}
