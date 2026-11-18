/**
 * Vocabulaire neutre des forges (GitLab, GitHub, Gitea...) : les pipelines, le serveur et le poller
 * n'utilisent que ces types, jamais ceux d'une forge particulière. Un connecteur traduit.
 *
 * - **Ticket** : une issue.
 * - **ChangeRequest** : une demande de fusion (merge request GitLab, pull request GitHub).
 * - `iid` : numéro du ticket ou de la demande dans son projet (iid GitLab, number GitHub).
 * - `projectId` : identifiant numérique du projet chez la forge. Deux forges peuvent donner le même
 *   numéro : en base, il est toujours accompagné de la colonne « source » (`ForgeKind`).
 */

import type { FORGE_KINDS } from "./forges.js";

export type ForgeKind = (typeof FORGE_KINDS)[number];

export interface Person {
  id: number;
  username: string;
  name: string;
}

export interface CurrentUser extends Person {
  /** Adresse utilisée pour signer les commits de l'outil. */
  commitEmail: string;
}

export interface Project {
  id: number;
  /** Chemin complet, ex. groupe/sous-groupe/projet. */
  path: string;
  name: string;
  description: string | null;
  /** URL de clonage HTTPS. */
  cloneUrl: string;
  url: string;
}

export interface Ticket {
  projectId: number;
  /** Chemin du projet quand la forge le fournit avec le ticket. */
  projectPath: string | null;
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  url: string;
  updatedAt: string | null;
  milestone: string | null;
  author: Person | null;
}

export interface Comment {
  id: number;
  body: string;
  /** Message généré par la forge (changement de label, d'assigné...), sans intérêt pour l'agent. */
  system: boolean;
  author: Person;
  createdAt: string;
  /** Rattaché à une ligne du diff d'une demande de fusion. */
  position: { path: string | null; line: number | null } | null;
  resolvable: boolean;
  resolved: boolean;
}

/** `merged` couvre aussi une fusion en cours. */
export type ChangeRequestState = "opened" | "closed" | "merged";

export interface ChangeRequest {
  projectId: number;
  projectPath: string;
  iid: number;
  title: string;
  description: string | null;
  state: ChangeRequestState;
  draft: boolean;
  sourceBranch: string;
  targetBranch: string;
  /** Commit de tête : ce qui est relu, et ce qu'on approuve. */
  headSha: string;
  url: string;
  author: Person;
  reviewers: Person[];
  labels: string[];
}

export interface Diff {
  oldPath: string;
  newPath: string;
  diff: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
}

export interface Commit {
  shortId: string;
  title: string;
  authorName: string;
}

/** Résultat d'un job de CI sur un commit. */
export interface CheckStatus {
  name: string;
  status: string;
}

export interface Branch {
  name: string;
  isDefault: boolean;
  isProtected: boolean;
}

export interface NewChangeRequest {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  assigneeId?: number;
  removeSourceBranch?: boolean;
}

/** Un ticket à créer. */
export interface NewTicket {
  title: string;
  description: string;
  labels?: string[];
}

/** Où l'on peut créer un projet : le compte de la personne, ou un groupe (GitLab) ou une organisation (GitHub). */
export interface Namespace {
  /** Identifiant à repasser à `createProject` (numéro de groupe chez GitLab, identifiant de compte chez GitHub). */
  id: string;
  path: string;
  name: string;
  kind: "personal" | "group";
}

/** Un projet (dépôt) à créer. */
export interface NewProject {
  name: string;
  description: string;
  /** `Namespace.id` choisi ; absent : le compte personnel. */
  namespaceId?: string;
  private: boolean;
  /** Initialiser le dépôt avec un README (branche par défaut créée, donc clonable tout de suite). */
  withReadme: boolean;
}

/** Identifiants pour git (clonage, récupération, push) : jamais écrits dans l'URL du remote. */
export interface GitCredentials {
  username: string;
  token: string;
}

/**
 * `review` : fil de discussion à résoudre, pour une review. `note` : simple commentaire, pour un
 * rapport d'agent.
 */
export type CommentKind = "review" | "note";

export interface ForgeConnector {
  readonly kind: ForgeKind;

  gitCredentials(): GitCredentials;
  /** Référence git où la forge expose la tête d'une demande de fusion (refs/merge-requests/12/head). */
  changeRequestHeadRef(iid: number): string;
  /** Reconnaît l'URL d'une demande de fusion de cette forge ; null si ce n'en est pas une. */
  resolveChangeRequestUrl(url: string): Promise<{ projectId: number; iid: number } | null>;

  // Utilisateur et projets
  getCurrentUser(): Promise<CurrentUser>;
  getProject(projectId: number): Promise<Project>;
  /** Projets dont l'utilisateur est membre. */
  searchProjects(search: string): Promise<Project[]>;
  listBranches(projectId: number, search?: string): Promise<Branch[]>;
  /** Noms ou motifs des branches protégées. */
  getProtectedBranches(projectId: number): Promise<string[]>;
  branchExists(projectId: number, branch: string): Promise<boolean>;
  /** Où la personne peut créer un projet : son compte et les groupes ou organisations qui l'acceptent. */
  listNamespaces(): Promise<Namespace[]>;
  /** Crée un projet vide (écriture chez la forge). */
  createProject(input: NewProject): Promise<Project>;

  // Tickets
  /** Tickets ouverts assignés à l'utilisateur, tous projets confondus. */
  listAssignedTickets(): Promise<Ticket[]>;
  /** Tickets ouverts d'un projet (les plus récemment modifiés d'abord, 100 au plus), quel que soit l'assigné. */
  listProjectTickets(projectId: number): Promise<Ticket[]>;
  getTicket(projectId: number, iid: number): Promise<Ticket | null>;
  /** Crée un ticket (écriture chez la forge). */
  createTicket(projectId: number, input: NewTicket): Promise<Ticket>;
  /**
   * Envoie un fichier chez la forge pour l'insérer dans un ticket (écriture chez la forge). Retourne le Markdown à insérer dans la description,
   * ou `null` si cette forge n'offre pas d'envoi de fichier pour les tickets (GitHub n'en propose pas par son API).
   */
  uploadTicketFile(projectId: number, name: string, bytes: Uint8Array): Promise<{ markdown: string } | null>;
  /** Discussion du ticket, dans l'ordre chronologique. */
  getTicketComments(projectId: number, iid: number): Promise<Comment[]>;
  addTicketLabels(projectId: number, iid: number, labels: string[]): Promise<void>;

  // Demandes de fusion
  /** Demandes ouvertes, hors brouillon, où l'utilisateur est relecteur. */
  listReviewRequests(username: string): Promise<ChangeRequest[]>;
  getChangeRequest(projectId: number, iid: number): Promise<ChangeRequest>;
  getChangeRequestDiffs(projectId: number, iid: number): Promise<Diff[]>;
  getChangeRequestCommits(projectId: number, iid: number): Promise<Commit[]>;
  getChangeRequestComments(projectId: number, iid: number): Promise<Comment[]>;
  getCheckStatuses(projectId: number, sha: string): Promise<CheckStatus[]>;
  createChangeRequest(projectId: number, input: NewChangeRequest): Promise<ChangeRequest>;
  commentOnChangeRequest(projectId: number, iid: number, body: string, kind: CommentKind): Promise<void>;
  /** Approuve seulement si la tête est toujours `headSha` : on n'approuve jamais du code non relu. */
  approveChangeRequest(projectId: number, iid: number, headSha: string): Promise<void>;
  /** Passe une demande de fusion de brouillon à prête (écriture chez la forge). Sans effet si elle n'est pas en brouillon. */
  markChangeRequestReady(projectId: number, iid: number): Promise<void>;
  /**
   * Fusionne la demande dans sa branche cible (écriture chez la forge), seulement si sa tête est toujours `headSha` : on ne fusionne jamais
   * du code qui n'a pas été relu. Ne supprime pas la branche source.
   */
  mergeChangeRequest(projectId: number, iid: number, headSha: string): Promise<void>;
}
