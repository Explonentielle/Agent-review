// Sous-ensemble des réponses de l'API GitLab v4 réellement utilisées par le projet.

export interface GitlabUser {
  id: number;
  username: string;
  name: string;
}

export interface GitlabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  http_url_to_repo: string;
  web_url: string;
}

export interface GitlabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "locked" | "merged";
  draft: boolean;
  source_branch: string;
  target_branch: string;
  sha: string;
  web_url: string;
  /** ex. full = "groupe/projet!42" */
  references: { full: string };
  author: GitlabUser;
  reviewers?: GitlabUser[];
  labels: string[];
}

export interface GitlabDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

export interface GitlabCommit {
  id: string;
  short_id: string;
  title: string;
  author_name: string;
}

export interface GitlabCommitStatus {
  name: string;
  status: string;
}

export interface GitlabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  labels: string[];
  web_url: string;
  state?: "opened" | "closed";
  updated_at?: string;
  /** ex. full = "groupe/projet#163" */
  references?: { full: string };
  author?: GitlabUser;
  milestone?: { title: string } | null;
}

export interface GitlabCurrentUser extends GitlabUser {
  email?: string;
  commit_email?: string;
  public_email?: string;
}

export interface GitlabNote {
  id: number;
  body: string;
  system: boolean;
  author: GitlabUser;
  created_at: string;
  /** Commentaire de MR rattaché à une ligne du diff (DiffNote). */
  position?: { new_path?: string | null; new_line?: number | null; old_path?: string | null; old_line?: number | null } | null;
  resolvable?: boolean;
  resolved?: boolean;
}

export interface GitlabBranch {
  name: string;
  default: boolean;
  protected: boolean;
}

export interface GitlabProtectedBranch {
  name: string;
}
