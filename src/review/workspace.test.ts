import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoWorkspace } from "./workspace.js";

/** Dépôt distant local (bare) avec une branche develop : remplace GitLab pour le test. */
function makeRemote(root: string): { url: string; developSha: string } {
  const seed = path.join(root, "seed");
  const remote = path.join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd }).toString().trim();

  execFileSync("git", ["init", "-q", "-b", "develop", seed]);
  writeFileSync(path.join(seed, "app.js"), "export const x = 1;\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
  return { url: `file://${remote}`, developSha: git(seed, "rev-parse", "HEAD") };
}

const remoteSha = (url: string, ref: string) =>
  execFileSync("git", ["ls-remote", url, ref]).toString().split(/\s/)[0] ?? "";

describe("RepoWorkspace (flux de l'agent dev)", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("crée la branche, replie un commit de l'agent, et ne pousse que la branche du ticket", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ws-test-"));
    const { url, developSha } = makeRemote(root);
    // Chemin relatif, comme DATA_DIR=./data dans le .env : le worktree doit quand même être créé là où on l'attend
    const ws = new RepoWorkspace(path.relative(process.cwd(), path.join(root, "repos")), "token-factice");

    const wt = await ws.createBranchWorktree(1, url, "develop", "feature/163-test");
    expect(path.isAbsolute(wt)).toBe(true);
    expect(existsSync(path.join(wt, "app.js"))).toBe(true);
    const baseSha = await ws.headSha(wt);
    expect(baseSha).toBe(developSha);

    // L'agent modifie un fichier, en crée un autre, et commit lui-même (cas à replier)
    writeFileSync(path.join(wt, "app.js"), "export const x = 2;\n");
    writeFileSync(path.join(wt, "new.js"), "export const y = 3;\n");
    execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=a@a", "commit", "-qam", "commit de l'agent"], { cwd: wt });

    expect(await ws.foldAgentCommits(wt, baseSha)).toBe(true);
    expect((await ws.changedFiles(wt)).sort()).toEqual(["app.js", "new.js"]);

    await ws.commitAll(wt, "#163 - Test", { name: "Alex", email: "alex@example.com" });
    await ws.pushBranch(wt, "feature/163-test");

    const pushed = remoteSha(url, "refs/heads/feature/163-test");
    expect(pushed).not.toBe("");
    expect(remoteSha(url, "refs/heads/develop")).toBe(developSha);

    const log = execFileSync("git", ["log", "--format=%an|%s", `${developSha}..${pushed}`], { cwd: wt }).toString().trim();
    expect(log).toBe("Alex|#163 - Test");
  });

  it("ne replie rien si l'agent n'a pas committé", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ws-test-"));
    const { url } = makeRemote(root);
    const ws = new RepoWorkspace(path.join(root, "repos"), "token-factice");
    const wt = await ws.createBranchWorktree(1, url, "develop", "feature/1-x");
    writeFileSync(path.join(wt, "app.js"), "modifié\n");
    expect(await ws.foldAgentCommits(wt, await ws.headSha(wt))).toBe(false);
    expect(await ws.changedFiles(wt)).toEqual(["app.js"]);
  });
});
