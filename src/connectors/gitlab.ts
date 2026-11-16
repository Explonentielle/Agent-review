import { GitlabClient } from "../gitlab/client.js";
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
  GitlabUser,
} from "../gitlab/types.js";
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

// --- Traduction GitLab vers le vocabulaire neutre ---------------------------------

const toPerson = (u: GitlabUser): Person => ({ id: u.id, username: u.username, name: u.name });

export function toCurrentUser(u: GitlabCurrentUser): CurrentUser {
  return { ...toPerson(u), commitEmail: u.commit_email || u.email || u.public_email || `${u.username}@users.noreply` };
}

export function toProject(p: GitlabProject): Project {
  return { id: p.id, path: p.path_with_namespace, name: p.name, description: p.description, cloneUrl: p.http_url_to_repo, url: p.web_url };
}

export function toTicket(i: GitlabIssue): Ticket {
  return {
    projectId: i.project_id,
    projectPath: i.references?.full.replace(/#\d+$/, "") ?? null,
    iid: i.iid,
    title: i.title,
    description: i.description,
    labels: i.labels,
    url: i.web_url,
    updatedAt: i.updated_at ?? null,
    milestone: i.milestone?.title ?? null,
    author: i.author ? toPerson(i.author) : null,
  };
}

export function toComment(n: GitlabNote): Comment {
  const path = n.position?.new_path ?? n.position?.old_path ?? null;
  return {
    id: n.id,
    body: n.body,
    system: n.system,
    author: toPerson(n.author),
    createdAt: n.created_at,
    position: n.position ? { path, line: n.position.new_line ?? n.position.old_line ?? null } : null,
    resolvable: n.resolvable ?? false,
    resolved: n.resolved ?? false,
  };
}

export function toChangeRequest(mr: GitlabMergeRequest): ChangeRequest {
  return {
    projectId: mr.project_id,
    projectPath: mr.references.full.replace(/!\d+$/, ""),
    iid: mr.iid,
    title: mr.title,
    description: mr.description,
    // « locked » : fusion en cours
    state: mr.state === "opened" ? "opened" : mr.state === "closed" ? "closed" : "merged",
    draft: mr.draft,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    headSha: mr.sha,
    url: mr.web_url,
    author: toPerson(mr.author),
    reviewers: (mr.reviewers ?? []).map(toPerson),
    labels: mr.labels,
  };
}

const toNamespace = (n: GitlabNamespace, kind: Namespace["kind"]): Namespace => ({ id: String(n.id), path: n.full_path, name: n.name, kind });

export const toDiff = (d: GitlabDiff): Diff => ({ oldPath: d.old_path, newPath: d.new_path, diff: d.diff, isNew: d.new_file, isDeleted: d.deleted_file, isRenamed: d.renamed_file });
export const toCommit = (c: GitlabCommit): Commit => ({ shortId: c.short_id, title: c.title, authorName: c.author_name });
export const toCheckStatus = (s: GitlabCommitStatus): CheckStatus => ({ name: s.name, status: s.status });
export const toBranch = (b: GitlabBranch): Branch => ({ name: b.name, isDefault: b.default, isProtected: b.protected });

/** Préfixes de brouillon reconnus par GitLab dans le titre d'une MR. */
const DRAFT_TITLE = /^\s*(?:\[(?:draft|wip)\]|\((?:draft|wip)\)|(?:draft|wip):)\s*/i;

// --- Connecteur ---------------------------------------------------------------------

/** Connecteur GitLab (API v4) : enveloppe `GitlabClient` et traduit ses réponses. */
export class GitlabConnector implements ForgeConnector {
  readonly kind = "gitlab" as const;

  constructor(
    private readonly client: GitlabClient,
    private readonly token: string,
  ) {}

  static fromConfig(gitlab: { url: string; token: string }): GitlabConnector {
    return new GitlabConnector(new GitlabClient(gitlab.url, gitlab.token), gitlab.token);
  }

  gitCredentials(): GitCredentials {
    return { username: "oauth2", token: this.token };
  }

  changeRequestHeadRef(iid: number): string {
    return `refs/merge-requests/${iid}/head`;
  }

  async resolveChangeRequestUrl(url: string): Promise<{ projectId: number; iid: number } | null> {
    const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (!m) return null;
    const project = await this.client.getProjectByPath(m[1]!);
    return { projectId: project.id, iid: Number(m[2]) };
  }

  async getCurrentUser(): Promise<CurrentUser> {
    return toCurrentUser(await this.client.getCurrentUser());
  }

  async getProject(projectId: number): Promise<Project> {
    return toProject(await this.client.getProject(projectId));
  }

  async searchProjects(search: string): Promise<Project[]> {
    return (await this.client.searchProjects(search)).map(toProject);
  }

  async listBranches(projectId: number, search = ""): Promise<Branch[]> {
    return (await this.client.listBranches(projectId, search)).map(toBranch);
  }

  async getProtectedBranches(projectId: number): Promise<string[]> {
    return (await this.client.getProtectedBranches(projectId)).map((b) => b.name);
  }

  branchExists(projectId: number, branch: string): Promise<boolean> {
    return this.client.branchExists(projectId, branch);
  }

  async listNamespaces(): Promise<Namespace[]> {
    const groups = (await this.client.listCreatableGroups()).map((g) => toNamespace(g, "group"));
    // L'espace personnel n'est pas indispensable : sans lui, les groupes restent proposés
    try {
      const me = await this.client.getCurrentUser();
      return [toNamespace(await this.client.getNamespace(me.username), "personal"), ...groups];
    } catch {
      return groups;
    }
  }

  async createProject(input: NewProject): Promise<Project> {
    const namespaceId = input.namespaceId === undefined ? undefined : Number(input.namespaceId);
    if (namespaceId !== undefined && !Number.isInteger(namespaceId)) throw new Error(`Groupe invalide : ${input.namespaceId}`);
    const project = await this.client.createProject({
      name: input.name,
      description: input.description,
      namespace_id: namespaceId,
      visibility: input.private ? "private" : "public",
      initialize_with_readme: input.withReadme,
    });
    return toProject(project);
  }

  async listProjectTickets(projectId: number): Promise<Ticket[]> {
    return (await this.client.listProjectIssues(projectId)).map(toTicket);
  }

  async createTicket(projectId: number, input: NewTicket): Promise<Ticket> {
    return toTicket(await this.client.createIssue(projectId, { title: input.title, description: input.description, labels: input.labels }));
  }

  async listAssignedTickets(): Promise<Ticket[]> {
    return (await this.client.listAssignedIssues()).map(toTicket);
  }

  async getTicket(projectId: number, iid: number): Promise<Ticket | null> {
    const issue = await this.client.getIssue(projectId, iid);
    return issue ? toTicket(issue) : null;
  }

  async getTicketComments(projectId: number, iid: number): Promise<Comment[]> {
    return (await this.client.getIssueNotes(projectId, iid)).map(toComment);
  }

  async addTicketLabels(projectId: number, iid: number, labels: string[]): Promise<void> {
    await this.client.addIssueLabels(projectId, iid, labels);
  }

  async listReviewRequests(username: string): Promise<ChangeRequest[]> {
    return (await this.client.listReviewRequests(username)).map(toChangeRequest);
  }

  async getChangeRequest(projectId: number, iid: number): Promise<ChangeRequest> {
    return toChangeRequest(await this.client.getMergeRequest(projectId, iid));
  }

  async getChangeRequestDiffs(projectId: number, iid: number): Promise<Diff[]> {
    return (await this.client.getMergeRequestDiffs(projectId, iid)).map(toDiff);
  }

  async getChangeRequestCommits(projectId: number, iid: number): Promise<Commit[]> {
    return (await this.client.getMergeRequestCommits(projectId, iid)).map(toCommit);
  }

  async getChangeRequestComments(projectId: number, iid: number): Promise<Comment[]> {
    return (await this.client.getMergeRequestNotes(projectId, iid)).map(toComment);
  }

  async getCheckStatuses(projectId: number, sha: string): Promise<CheckStatus[]> {
    return (await this.client.getCommitStatuses(projectId, sha)).map(toCheckStatus);
  }

  async createChangeRequest(projectId: number, input: NewChangeRequest): Promise<ChangeRequest> {
    const mr = await this.client.createMergeRequest(projectId, {
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      title: input.title,
      description: input.description,
      assignee_id: input.assigneeId,
      remove_source_branch: input.removeSourceBranch,
    });
    return toChangeRequest(mr);
  }

  async commentOnChangeRequest(projectId: number, iid: number, body: string, kind: CommentKind): Promise<void> {
    if (kind === "review") await this.client.createMergeRequestDiscussion(projectId, iid, body);
    else await this.client.createMergeRequestNote(projectId, iid, body);
  }

  async approveChangeRequest(projectId: number, iid: number, headSha: string): Promise<void> {
    await this.client.approveMergeRequest(projectId, iid, headSha);
  }

  /** GitLab sort une MR du brouillon en retirant « Draft: » (ou [Draft], (Draft), WIP:) du titre. */
  async markChangeRequestReady(projectId: number, iid: number): Promise<void> {
    const mr = await this.client.getMergeRequest(projectId, iid);
    if (!mr.draft) return;
    const title = mr.title.replace(DRAFT_TITLE, "").trim();
    const updated = await this.client.updateMergeRequestTitle(projectId, iid, title || mr.title);
    if (updated.draft) throw new Error(`La MR !${iid} reste en brouillon : retire-lui son statut de brouillon chez GitLab`);
  }

  async mergeChangeRequest(projectId: number, iid: number, headSha: string): Promise<void> {
    await this.client.mergeMergeRequest(projectId, iid, headSha);
  }
}
