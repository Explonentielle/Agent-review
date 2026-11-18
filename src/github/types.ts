// Sous-ensemble des réponses de l'API REST GitHub réellement utilisées par le projet.

export interface GithubUser {
  id: number;
  login: string;
  /** Absent des listes (tickets, PR) : seul `GET /user` le fournit. */
  name?: string | null;
  /** Null quand l'adresse est privée. */
  email?: string | null;
}

export interface GithubRepo {
  id: number;
  name: string;
  /** ex. "proprietaire/depot" */
  full_name: string;
  description: string | null;
  clone_url: string;
  html_url: string;
  default_branch: string;
}

/** Organisation dont la personne est membre. */
export interface GithubOrg {
  login: string;
}

export interface GithubLabel {
  name: string;
}

export interface GithubIssue {
  id: number;
  /** Numéro dans le dépôt (l'« iid » du vocabulaire neutre). */
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: Array<GithubLabel | string>;
  html_url: string;
  updated_at: string;
  user: GithubUser | null;
  milestone: { title: string } | null;
  /** Présent seulement dans `GET /issues` (tickets de l'utilisateur, tous dépôts confondus). */
  repository?: GithubRepo;
  /** Présent sur une PR : GitHub renvoie les PR dans les listes de tickets. */
  pull_request?: unknown;
}

export interface GithubIssueComment {
  id: number;
  body: string;
  user: GithubUser | null;
  created_at: string;
}

/** Commentaire rattaché à une ligne du diff d'une PR. */
export interface GithubReviewComment extends GithubIssueComment {
  path: string;
  line?: number | null;
  original_line?: number | null;
}

/** Review soumise sur une PR : son texte est un commentaire général. */
export interface GithubReview {
  id: number;
  body: string | null;
  user: GithubUser | null;
  submitted_at?: string | null;
}

export interface GithubPull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  /** Identifiant global de la PR, qu'exige l'API GraphQL (la sortie du brouillon n'existe pas en REST). */
  node_id?: string;
  merged_at: string | null;
  html_url: string;
  user: GithubUser | null;
  requested_reviewers?: GithubUser[];
  labels: Array<GithubLabel | string>;
  head: { ref: string; sha: string };
  base: { ref: string; repo: GithubRepo };
}

export interface GithubFile {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  /** Absent pour un fichier binaire ou trop volumineux. */
  patch?: string;
}

export interface GithubCommit {
  sha: string;
  commit: { message: string; author: { name: string } | null };
}

export interface GithubCheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
}

export interface GithubCommitStatus {
  context: string;
  state: "success" | "failure" | "error" | "pending" | string;
}

export interface GithubBranch {
  name: string;
  protected: boolean;
}

/** Résultat de `GET /search/issues` : on n'en garde que ce qui sert à retrouver la PR. */
export interface GithubSearchItem {
  number: number;
  /** ex. https://api.github.com/repos/proprietaire/depot */
  repository_url: string;
}
