import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChangeRequest } from "../connectors/types.js";
import { runDevTask, type DevDeps } from "../dev/pipeline.js";
import { runReview, type PipelineDeps } from "../review/pipeline.js";
import { createHarness, type Harness } from "../testing/harness.js";

/** Faux `docker` : note les arguments de chaque `run` et répond comme la CLI Claude Code (le résultat est lu dans result.txt). */
const FAKE_DOCKER = String.raw`#!/bin/sh
dir=$(dirname "$0")
case "$1" in
  info) echo "28.0.0|[name=seccomp,profile=builtin]"; exit 0;;
  rm) exit 0;;
  run)
    printf '%s\n' "$@" >> "$dir/runs.txt"
    echo "----" >> "$dir/runs.txt"
    cat "$dir/result.txt"
    exit 0;;
esac
exit 0
`;

const cliResult = (structured: unknown) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: structured, total_cost_usd: 0.01, num_turns: 1, session_id: "s1" });
const reviewOk = { summary: "RAS", verdict: "approve", coverage: "full", ci_failure_related: false, injection_suspected: false, findings: [], positives: [], questions_for_author: [] };
const devBlocked = { status: "blocked", summary: "", commit_message: "", tests: "", notes_for_reviewer: [], questions: ["Quelle colonne est concernée ?"] };

/**
 * De l'image choisie dans les réglages d'un projet au conteneur lancé : les pipelines de review et de dev, sans exécuteur factice,
 * avec un faux docker à la place du vrai. Rien n'est envoyé à Anthropic.
 */
describe.skipIf(process.platform === "win32")("image d'agent par projet, de bout en bout", () => {
  let h: Harness;
  let dir = "";
  const read = (name: string) => readFileSync(path.join(dir, name), "utf8");
  /** Image du dernier conteneur lancé : elle précède le programme (`claude`). */
  const imageLaunched = () => {
    const last = read("runs.txt").split("----\n").filter(Boolean).at(-1)!.split("\n");
    return last[last.indexOf("claude") - 1];
  };
  const launches = () => (existsSync(path.join(dir, "runs.txt")) ? read("runs.txt").split("----\n").filter(Boolean).length : 0);
  const saveProject = (agentImage: string) =>
    h.settings.saveProject({ projectId: 1, path: "groupe/projet", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "", agentImage });

  beforeEach(async () => {
    h = await createHarness();
    dir = mkdtempSync(path.join(tmpdir(), "projet-image-"));
    const bin = path.join(dir, "docker");
    writeFileSync(bin, FAKE_DOCKER);
    chmodSync(bin, 0o755);
    h.config.agentRuntime = { ...h.config.agentRuntime, mode: "docker", image: "defaut:1", extraImages: ["agent-php73:1"], dockerBin: bin, containerUser: "host" };
    h.config.anthropicApiKey = "cle-api-de-test";
    await h.settings.save({ ...(await h.settings.get()), agentAuth: "api" });
    h.connector.tickets.set(609, h.ticket());
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await h.cleanup();
  });

  describe("review", () => {
    let reviewId: number;
    const deps = (): PipelineDeps => ({ config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, forceShadow: true });

    beforeEach(async () => {
      const sha = h.addMergeRequestRef(7, { "app.js": "export const x = 3;\n" });
      const cr: ChangeRequest = {
        projectId: 1,
        projectPath: "groupe/projet",
        iid: 7,
        title: "#609 - Import",
        description: "Related to #609",
        state: "opened",
        draft: false,
        sourceBranch: "feature/609-import",
        targetBranch: "develop",
        headSha: sha,
        url: "https://forge.example/groupe/projet/-/merge_requests/7",
        author: { id: 9, username: "collegue", name: "Collègue" },
        reviewers: [h.connector.me],
        labels: [],
      };
      h.connector.changeRequests.set(7, cr);
      h.connector.diffs.set(7, [{ oldPath: "app.js", newPath: "app.js", diff: "-export const x = 1;\n+export const x = 3;\n", isNew: false, isDeleted: false, isRenamed: false }]);
      h.connector.commits.set(7, [{ shortId: "abc1234", title: "Change x", authorName: "Collègue" }]);
      reviewId = (await h.reviews.insertIfNew({ projectId: 1, projectPath: "groupe/projet", mrIid: 7, mrTitle: cr.title, mrUrl: cr.url, author: "Collègue", headSha: sha }))!;
      writeFileSync(path.join(dir, "result.txt"), cliResult(reviewOk));
    });

    it("l'image choisie par le projet est celle du conteneur ; sans choix, l'image par défaut", async () => {
      await saveProject("agent-php73:1");
      await runReview(reviewId, deps());
      expect((await h.reviews.get(reviewId))!.error).toBeNull();
      expect(imageLaunched()).toBe("agent-php73:1");

      await saveProject("");
      await runReview(reviewId, deps());
      expect(imageLaunched()).toBe("defaut:1");
      expect(launches()).toBe(2);
    });

    it("image non autorisée : la review échoue avec la raison, avant tout conteneur", async () => {
      await saveProject("intrus:1");
      await runReview(reviewId, deps());
      const row = (await h.reviews.get(reviewId))!;
      expect(row.status).toBe("error");
      expect(row.error).toMatch(/« intrus:1 » non autorisée/);
      expect(launches()).toBe(0);
    });
  });

  describe("agent dev", () => {
    const deps = (): DevDeps => ({ config: h.config, forges: h.forges, costs: h.costs, settings: h.settings, tasks: h.tasks });
    const newTask = () =>
      h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import des règles", issueUrl: "https://forge.example/groupe/projet/-/issues/609", extraInstructions: null });

    beforeEach(() => writeFileSync(path.join(dir, "result.txt"), cliResult(devBlocked)));

    it("l'image choisie par le projet est celle du conteneur ; sans choix, l'image par défaut", async () => {
      await saveProject("agent-php73:1");
      const first = await newTask();
      await runDevTask(first, deps());
      expect((await h.tasks.get(first))!.error).toBeNull();
      expect(imageLaunched()).toBe("agent-php73:1");

      await saveProject("");
      await runDevTask(await newTask(), deps());
      expect(imageLaunched()).toBe("defaut:1");
      expect(launches()).toBe(2);
    });

    it("image non autorisée : la tâche échoue avec la raison, avant tout conteneur", async () => {
      await saveProject("intrus:1");
      const id = await newTask();
      await runDevTask(id, deps());
      expect((await h.tasks.get(id))!.error).toMatch(/« intrus:1 » non autorisée/);
      expect(launches()).toBe(0);
    });
  });
});
