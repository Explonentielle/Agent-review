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
  ForgeKind,
  GitCredentials,
  NewChangeRequest,
  Project,
  Ticket,
} from "../connectors/types.js";

/**
 * Connecteur en mémoire, RÉSERVÉ AUX TESTS : il remplace la forge pour tester les pipelines de bout
 * en bout, avec un vrai dépôt git local. Il n'est branché sur aucun script ni sur le dashboard.
 * Les actions d'écriture sont enregistrées pour que les tests les vérifient.
 */
export class FakeConnector implements ForgeConnector {
  readonly kind: ForgeKind;

  me: CurrentUser = { id: 7, username: "alex", name: "Alex Dev", commitEmail: "alex@example.com" };
  project: Project;
  tickets = new Map<number, Ticket>();
  ticketComments = new Map<number, Comment[]>();
  protectedBranches: string[] = [];
  /** Branches déclarées comme déjà présentes sur la forge. */
  existingBranches = new Set<string>();
  changeRequests = new Map<number, ChangeRequest>();
  changeRequestComments = new Map<number, Comment[]>();
  diffs = new Map<number, Diff[]>();
  commits = new Map<number, Commit[]>();
  checkStatuses: CheckStatus[] = [];
  reviewRequests: ChangeRequest[] = [];

  // Actions d'écriture enregistrées
  createdChangeRequests: NewChangeRequest[] = [];
  postedComments: Array<{ iid: number; body: string; kind: CommentKind }> = [];
  approvals: Array<{ iid: number; headSha: string }> = [];
  addedLabels: Array<{ iid: number; labels: string[] }> = [];

  private nextIid = 12;

  /** `kind` : la forge que ce faux connecteur prétend être (« gitlab » par défaut), pour tester plusieurs forges. */
  constructor(project: Partial<Project> & { cloneUrl: string }, kind: ForgeKind = "gitlab") {
    this.kind = kind;
    this.project = { id: 1, path: "groupe/projet", name: "projet", description: null, url: "https://forge.example/groupe/projet", ...project };
  }

  gitCredentials(): GitCredentials {
    return { username: "oauth2", token: "token-factice" };
  }

  changeRequestHeadRef(iid: number): string {
    return `refs/merge-requests/${iid}/head`;
  }

  async resolveChangeRequestUrl(url: string): Promise<{ projectId: number; iid: number } | null> {
    const m = url.match(/\/-\/merge_requests\/(\d+)/);
    return m ? { projectId: this.project.id, iid: Number(m[1]) } : null;
  }

  async getCurrentUser(): Promise<CurrentUser> {
    return this.me;
  }

  async getProject(): Promise<Project> {
    return this.project;
  }

  async searchProjects(search: string): Promise<Project[]> {
    return this.project.path.includes(search) ? [this.project] : [];
  }

  async listBranches(): Promise<Branch[]> {
    return [{ name: "develop", isDefault: true, isProtected: true }];
  }

  async getProtectedBranches(): Promise<string[]> {
    return this.protectedBranches;
  }

  async branchExists(_projectId: number, branch: string): Promise<boolean> {
    return this.existingBranches.has(branch);
  }

  async listAssignedTickets(): Promise<Ticket[]> {
    return [...this.tickets.values()];
  }

  async getTicket(_projectId: number, iid: number): Promise<Ticket | null> {
    return this.tickets.get(iid) ?? null;
  }

  async getTicketComments(_projectId: number, iid: number): Promise<Comment[]> {
    return this.ticketComments.get(iid) ?? [];
  }

  async addTicketLabels(_projectId: number, iid: number, labels: string[]): Promise<void> {
    this.addedLabels.push({ iid, labels });
  }

  async listReviewRequests(): Promise<ChangeRequest[]> {
    return this.reviewRequests;
  }

  async getChangeRequest(_projectId: number, iid: number): Promise<ChangeRequest> {
    const cr = this.changeRequests.get(iid);
    if (!cr) throw new Error(`Demande ${iid} inconnue du faux connecteur`);
    return cr;
  }

  async getChangeRequestDiffs(_projectId: number, iid: number): Promise<Diff[]> {
    return this.diffs.get(iid) ?? [];
  }

  async getChangeRequestCommits(_projectId: number, iid: number): Promise<Commit[]> {
    return this.commits.get(iid) ?? [];
  }

  async getChangeRequestComments(_projectId: number, iid: number): Promise<Comment[]> {
    return this.changeRequestComments.get(iid) ?? [];
  }

  async getCheckStatuses(): Promise<CheckStatus[]> {
    return this.checkStatuses;
  }

  async createChangeRequest(projectId: number, input: NewChangeRequest): Promise<ChangeRequest> {
    this.createdChangeRequests.push(input);
    const iid = this.nextIid++;
    const cr: ChangeRequest = {
      projectId,
      projectPath: this.project.path,
      iid,
      title: input.title,
      description: input.description,
      state: "opened",
      draft: /^draft:/i.test(input.title),
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      headSha: "0".repeat(40),
      url: `${this.project.url}/-/merge_requests/${iid}`,
      author: this.me,
      reviewers: [],
      labels: [],
    };
    this.changeRequests.set(iid, cr);
    return cr;
  }

  async commentOnChangeRequest(_projectId: number, iid: number, body: string, kind: CommentKind): Promise<void> {
    this.postedComments.push({ iid, body, kind });
  }

  async approveChangeRequest(_projectId: number, iid: number, headSha: string): Promise<void> {
    this.approvals.push({ iid, headSha });
  }
}
