import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../config.js";
import type { Ticket } from "../connectors/types.js";
import { createCostRepo, type CostRepo } from "../db/costs.js";
import { createDevTaskRepo, type DevTaskRepo } from "../db/devTasks.js";
import type { Db } from "../db/db.js";
import { openDb } from "../db/index.js";
import { migrate } from "../db/migrations.js";
import { postgresFromPglite, type PgliteLike } from "../db/postgres.js";
import { createReviewRepo, type ReviewRepo } from "../db/reviews.js";
import { RepoWorkspace } from "../review/workspace.js";
import { createSettingsStore, type SettingsStore } from "../settings/store.js";
import { FakeConnector } from "./fakeConnector.js";

/**
 * Environnement de test complet, RÉSERVÉ AUX TESTS : un dépôt distant git local (branche `develop`
 * avec un fichier UTF-8 et un fichier ISO-8859-1), une base SQLite temporaire, les réglages d'un
 * projet configuré pour l'agent dev, et un faux connecteur à la place de la forge.
 */
export interface Harness {
  root: string;
  remoteUrl: string;
  developSha: string;
  config: Config;
  db: Db;
  settings: SettingsStore;
  tasks: DevTaskRepo;
  reviews: ReviewRepo;
  costs: CostRepo;
  workspace: RepoWorkspace;
  connector: FakeConnector;
  /** Tête d'une branche du dépôt distant, ou chaîne vide si elle n'existe pas. */
  remoteBranchSha(branch: string): string;
  /** Nombre de commits de la branche qui ne sont pas dans develop. */
  commitsAhead(branch: string): number;
  /** Dernier commit d'une branche distante : « auteur|email|sujet ». */
  lastCommit(branch: string): string;
  /** Publie la tête d'une demande de fusion (refs/merge-requests/<iid>/head) avec ces fichiers ; retourne son sha. */
  addMergeRequestRef(iid: number, files: Record<string, string>): string;
  /** Ticket de test cohérent avec le projet configuré. */
  ticket(overrides?: Partial<Ticket>): Ticket;
  cleanup(): Promise<void>;
}

/** Moteur de base de données utilisé par le harnais : SQLite (local) ou PostgreSQL embarqué (PGlite). */
export type Backend = "sqlite" | "postgres";

const GIT_IDENTITY = ["-c", "user.name=seed", "-c", "user.email=seed@example.com"];

export async function createHarness(backend: Backend = "sqlite"): Promise<Harness> {
  const root = mkdtempSync(path.join(tmpdir(), "harness-"));
  const seed = path.join(root, "seed");
  const remoteDir = path.join(root, "remote.git");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT_IDENTITY, ...args], { cwd }).toString().trim();

  execFileSync("git", ["init", "-q", "-b", "develop", seed]);
  writeFileSync(path.join(seed, "app.js"), "export const x = 1;\n");
  writeFileSync(path.join(seed, "legacy.php"), Buffer.from("<?php // libellé réservé\n$a = 1;\n", "latin1"));
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", "--bare", seed, remoteDir]);
  const developSha = git(seed, "rev-parse", "HEAD");
  const remoteUrl = `file://${remoteDir}`;

  const dataDir = path.join(root, "data");
  const config = loadConfig({
    GITLAB_URL: "https://forge.example",
    GITLAB_TOKEN: "token-factice",
    GITLAB_USERNAME: "alex",
    DATA_DIR: dataDir,
    CLAUDE_BIN: "/bin/false",
  });
  let db: Db;
  if (backend === "postgres") {
    const { PGlite } = await import("@electric-sql/pglite");
    db = postgresFromPglite(new PGlite() as unknown as PgliteLike);
    await migrate(db);
  } else {
    db = await openDb({ dataDir, databaseUrl: null });
  }
  const settings = createSettingsStore(db);
  await settings.saveProject({ projectId: 1, path: "groupe/projet", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "" });
  const connector = new FakeConnector({ cloneUrl: remoteUrl });

  const remoteBranchSha = (branch: string) => execFileSync("git", ["ls-remote", remoteUrl, `refs/heads/${branch}`]).toString().split(/\s/)[0] ?? "";

  return {
    root,
    remoteUrl,
    developSha,
    config,
    db,
    settings,
    tasks: createDevTaskRepo(db),
    reviews: createReviewRepo(db),
    costs: createCostRepo(db),
    workspace: new RepoWorkspace(path.join(root, "repos"), "token-factice"),
    connector,
    remoteBranchSha,
    commitsAhead: (branch) => Number(git(remoteDir, "rev-list", "--count", `develop..${branch}`)),
    lastCommit: (branch) => git(remoteDir, "log", "-1", "--format=%an|%ae|%s", branch),
    addMergeRequestRef(iid, files) {
      git(seed, "checkout", "-q", "-b", `mr-${iid}`);
      for (const [file, content] of Object.entries(files)) writeFileSync(path.join(seed, file), content);
      git(seed, "add", ".");
      git(seed, "commit", "-qm", `Changements de la MR ${iid}`);
      const sha = git(seed, "rev-parse", "HEAD");
      git(seed, "push", "-q", remoteDir, `HEAD:refs/merge-requests/${iid}/head`);
      git(seed, "checkout", "-q", "develop");
      return sha;
    },
    ticket: (overrides = {}) => ({
      projectId: 1,
      projectPath: "groupe/projet",
      iid: 609,
      title: "Import des règles",
      description: "Importer un fichier Excel de règles tarifaires",
      labels: ["Statut::A traiter"],
      url: "https://forge.example/groupe/projet/-/issues/609",
      updatedAt: "2026-11-09T10:00:00Z",
      milestone: null,
      author: null,
      ...overrides,
    }),
    async cleanup() {
      await db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
