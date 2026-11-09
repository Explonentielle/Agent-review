import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface Checkout {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Gère une copie locale de chaque dépôt (clone bare partiel) et des worktrees :
 * - jetables pour la review (au sha exact de la MR) ;
 * - conservés pour l'agent dev (branche du ticket), pour pouvoir reprendre la main ensuite.
 *
 * Le token n'est jamais écrit dans l'URL du remote ni dans .git/config : il est injecté à chaque
 * commande via GIT_CONFIG_* en variable d'env, donc invisible dans `git remote -v` et dans `ps`.
 */
export class RepoWorkspace {
  private readonly reposDir: string;
  private readonly worktreesDir: string;
  private readonly devDir: string;

  constructor(
    reposDir: string,
    private readonly token: string,
  ) {
    // Absolu obligatoire : `git -C <miroir> worktree add <chemin>` résout un chemin relatif depuis le miroir.
    this.reposDir = path.resolve(reposDir);
    this.worktreesDir = path.join(this.reposDir, "worktrees");
    this.devDir = path.join(this.reposDir, "dev");
    mkdirSync(this.worktreesDir, { recursive: true });
    mkdirSync(this.devDir, { recursive: true });
  }

  // --- Review ----------------------------------------------------------------

  async checkoutMergeRequest(projectId: number, cloneUrl: string, mrIid: number, sha: string): Promise<Checkout> {
    const mirror = await this.ensureMirror(projectId, cloneUrl);
    // GitLab expose la tête de chaque MR sous refs/merge-requests/<iid>/head
    await this.git(["-C", mirror, "fetch", "--force", "origin", `refs/merge-requests/${mrIid}/head:refs/mr/${mrIid}`]);

    const wt = path.join(this.worktreesDir, `${projectId}-${mrIid}-${sha.slice(0, 8)}`);
    if (existsSync(wt)) {
      await this.git(["-C", mirror, "worktree", "remove", "--force", wt]).catch(() => undefined);
    }
    await this.git(["-C", mirror, "worktree", "add", "--detach", "--force", wt, sha]);

    return {
      path: wt,
      cleanup: async () => {
        await this.git(["-C", mirror, "worktree", "remove", "--force", wt]).catch(() => undefined);
      },
    };
  }

  // --- Agent dev ---------------------------------------------------------------

  /** Crée la branche du ticket depuis la branche de base à jour, dans un worktree dédié. */
  async createBranchWorktree(projectId: number, cloneUrl: string, baseBranch: string, branch: string): Promise<string> {
    const mirror = await this.fetchBranch(projectId, cloneUrl, baseBranch);

    const wt = this.devWorktreePath(projectId, branch);
    if (existsSync(wt)) {
      await this.git(["-C", mirror, "worktree", "remove", "--force", wt]).catch(() => undefined);
    }
    // Une branche locale restée d'un essai précédent (jamais poussée, sinon on aurait refusé plus tôt)
    await this.git(["-C", mirror, "branch", "-D", branch]).catch(() => undefined);
    await this.git(["-C", mirror, "worktree", "add", "-b", branch, wt, `refs/remotes/origin/${baseBranch}`]);
    return wt;
  }

  /**
   * Reprise d'une MR : worktree sur la branche du ticket telle qu'elle est sur GitLab (commits
   * ajoutés à la main compris). Refuse si l'ancien worktree contient du travail non poussé.
   */
  async checkoutExistingBranch(projectId: number, cloneUrl: string, branch: string): Promise<string> {
    const mirror = await this.fetchBranch(projectId, cloneUrl, branch);
    const remote = `refs/remotes/origin/${branch}`;

    const wt = this.devWorktreePath(projectId, branch);
    if (existsSync(wt)) {
      if ((await this.changedFiles(wt)).length > 0) {
        throw new Error(`Le dossier de travail ${wt} contient des modifications non committées : pousse-les ou supprime le dossier avant la reprise`);
      }
      const ahead = Number((await this.git(["-C", wt, "rev-list", "--count", `${remote}..HEAD`])).trim());
      if (ahead > 0) {
        throw new Error(`Le dossier de travail ${wt} contient ${ahead} commit(s) non poussé(s) : pousse-les ou supprime le dossier avant la reprise`);
      }
      await this.git(["-C", mirror, "worktree", "remove", "--force", wt]);
    }
    await this.git(["-C", mirror, "branch", "-D", branch]).catch(() => undefined);
    await this.git(["-C", mirror, "worktree", "add", "-b", branch, wt, remote]);
    return wt;
  }

  /** Met à jour refs/remotes/origin/<branch> dans le miroir. Retourne le chemin du miroir. */
  async fetchBranch(projectId: number, cloneUrl: string, branch: string): Promise<string> {
    const mirror = await this.ensureMirror(projectId, cloneUrl);
    await this.git(["-C", mirror, "fetch", "--force", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return mirror;
  }

  devWorktreePath(projectId: number, branch: string): string {
    return path.join(this.devDir, `${projectId}-${branch.replace(/[^A-Za-z0-9._-]+/g, "_")}`);
  }

  /** Fichiers modifiés, ajoutés ou supprimés dans le worktree (non committés). */
  async changedFiles(worktree: string): Promise<string[]> {
    const out = await this.git(["-C", worktree, "status", "--porcelain", "--untracked-files=all"]);
    return out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        const p = l.slice(3);
        return p.includes(" -> ") ? (p.split(" -> ").pop() ?? p) : p;
      })
      .map((p) => p.replace(/^"|"$/g, ""));
  }

  async headSha(worktree: string): Promise<string> {
    return (await this.git(["-C", worktree, "rev-parse", "HEAD"])).trim();
  }

  /**
   * Si l'agent a réussi à committer malgré l'interdiction, ses commits sont repliés en
   * modifications non committées : seul le commit de l'outil (avec la convention) est poussé.
   * Retourne true si un repli a eu lieu.
   */
  async foldAgentCommits(worktree: string, baseSha: string): Promise<boolean> {
    if ((await this.headSha(worktree)) === baseSha) return false;
    await this.git(["-C", worktree, "reset", "--soft", baseSha]);
    return true;
  }

  async diffStat(worktree: string): Promise<string> {
    return this.git(["-C", worktree, "diff", "--cached", "--stat"]);
  }

  async commitAll(worktree: string, message: string, author: { name: string; email: string }): Promise<void> {
    await this.git(["-C", worktree, "add", "--all"]);
    await this.git(["-C", worktree, "commit", "-m", message], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    });
  }

  /** Pousse HEAD vers la branche nommée, et rien d'autre. Jamais de --force. */
  async pushBranch(worktree: string, branch: string): Promise<void> {
    await this.git(["-C", worktree, "push", "origin", `HEAD:refs/heads/${branch}`]);
  }

  async removeDevWorktree(projectId: number, cloneUrl: string, worktree: string): Promise<void> {
    const mirror = await this.ensureMirror(projectId, cloneUrl);
    await this.git(["-C", mirror, "worktree", "remove", "--force", worktree]).catch(() => undefined);
  }

  // --- Interne -----------------------------------------------------------------

  private async ensureMirror(projectId: number, cloneUrl: string): Promise<string> {
    const mirror = path.join(this.reposDir, `${projectId}.git`);
    if (!existsSync(mirror)) {
      await this.git(["clone", "--bare", "--filter=blob:none", cloneUrl, mirror]);
    }
    return mirror;
  }

  private async git(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const basic = Buffer.from(`oauth2:${this.token}`).toString("base64");
    const { stdout } = await execFileAsync("git", args, {
      env: {
        ...process.env,
        ...extraEnv,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      },
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  }
}
