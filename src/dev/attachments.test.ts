import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../agent/runner.js";
import { ATTACHMENTS_DIRNAME } from "../attachments/rules.js";
import { createAttachmentStore, type AttachmentStore } from "../attachments/store.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildAttachmentsBlock } from "./context.js";
import { isAttachmentFile } from "./guard.js";
import { runDevTask, type DevDeps } from "./pipeline.js";

const BRANCH = "feature/609-import-des-regles";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("capture d'écran")]);
const CSV = Buffer.from("regle;valeur\nA;1\n", "utf8");

const devResult = () => ({
  status: "done",
  summary: "Correction de l'import.",
  commit_message: "Correction de l'import",
  tests: "Aucun test lancé.",
  notes_for_reviewer: [],
  questions: [],
});

describe("pièces jointes : fichiers et prompt", () => {
  it("le prompt présente les fichiers par leur chemin, et dit qu'ils ne sont pas fiables", () => {
    expect(buildAttachmentsBlock([])).toBe("");
    const block = buildAttachmentsBlock([
      { name: "capture.png", kind: "image", size: 2048 },
      { name: "regles.csv", kind: "text", size: 12 },
    ]);
    expect(block).toContain("## Pièces jointes du développeur");
    expect(block).toContain("2 fichiers");
    expect(block).toContain(`\`${ATTACHMENTS_DIRNAME}/capture.png\` : image, 2 Ko`);
    expect(block).toContain(`\`${ATTACHMENTS_DIRNAME}/regles.csv\` : texte ou données, 12 o`);
    expect(block).toMatch(/non fiables/);
    expect(block).toMatch(/supprimées après ton passage/);
  });

  it("reconnaît un fichier du dossier des pièces jointes, et seulement celui-là", () => {
    expect(isAttachmentFile(".ra-attachments/capture.png")).toBe(true);
    expect(isAttachmentFile("./.ra-attachments/sous/dossier.png")).toBe(true);
    expect(isAttachmentFile(".ra-attachments\\capture.png")).toBe(true);
    expect(isAttachmentFile(".ra-attachments")).toBe(true);
    expect(isAttachmentFile("src/.ra-attachments/capture.png")).toBe(false);
    expect(isAttachmentFile(".ra-attachments-x/a.png")).toBe(false);
    expect(isAttachmentFile("app.js")).toBe(false);
  });
});

describe("agent dev et pièces jointes (faux connecteur, vrai dépôt git local)", () => {
  let h: Harness;
  let store: AttachmentStore;
  const deps = (runner: AgentRunner): DevDeps => ({ config: h.config, forges: h.forges, costs: h.costs, settings: h.settings, tasks: h.tasks, runner, attachments: store });
  const newTask = () =>
    h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import des règles", issueUrl: "https://forge.example/groupe/projet/-/issues/609", extraInstructions: null });
  /** Une tâche avec deux fichiers joints. */
  async function taskWithFiles(): Promise<number> {
    const id = await newTask();
    const a = await store.stage("capture.png", PNG);
    const b = await store.stage("regles.csv", CSV);
    await store.attach({ task: id }, [a.id, b.id]);
    return id;
  }
  const remoteFiles = (branch: string) =>
    execFileSync("git", ["--git-dir", path.join(h.root, "remote.git"), "ls-tree", "-r", "--name-only", branch]).toString().split("\n").filter(Boolean);

  beforeEach(async () => {
    h = await createHarness();
    store = createAttachmentStore(path.join(h.config.dataDir, "attachments"), h.local.workspaceId);
    h.connector.tickets.set(609, h.ticket());
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("l'agent trouve les fichiers dans son dossier de travail ; ils sont supprimés après lui et ne partent jamais dans le commit", async () => {
    const seen: { png?: boolean; csv?: string; prompt?: string } = {};
    const runner: AgentRunner = {
      async run(req: AgentRequest) {
        const dir = path.join(req.cwd, ATTACHMENTS_DIRNAME);
        seen.png = existsSync(path.join(dir, "capture.png")) && readFileSync(path.join(dir, "capture.png")).equals(PNG);
        seen.csv = readFileSync(path.join(dir, "regles.csv"), "utf8");
        seen.prompt = req.prompt;
        writeFileSync(path.join(req.cwd, "app.js"), "export const x = 2;\n");
        return { structured: devResult(), sessionId: "s", costUsd: 0, numTurns: 1 };
      },
    };
    const id = await taskWithFiles();
    await runDevTask(id, deps(runner));

    expect(seen.png).toBe(true);
    expect(seen.csv).toBe("regle;valeur\nA;1\n");
    expect(seen.prompt).toContain(`\`${ATTACHMENTS_DIRNAME}/capture.png\``);

    const task = (await h.tasks.get(id))!;
    expect(task.error).toBeNull();
    expect(task.status).toBe("mr_created");
    expect(existsSync(path.join(task.worktree_path!, ATTACHMENTS_DIRNAME))).toBe(false); // supprimé dès la fin de l'agent
    expect(remoteFiles(BRANCH).sort()).toEqual(["app.js", "legacy.php"]); // seul le travail de l'agent a été poussé
    expect((await h.tasks.events(id)).map((e) => e.text)).toContain("Pièces jointes mises à disposition de l'agent : capture.png, regles.csv");
    expect(await store.list({ task: id })).toHaveLength(2); // les fichiers d'origine restent pour une reprise
  });

  it("sans pièce jointe : rien n'est posé et le prompt n'en parle pas", async () => {
    let dirExisted = true;
    let prompt = "";
    const runner: AgentRunner = {
      async run(req: AgentRequest) {
        dirExisted = existsSync(path.join(req.cwd, ATTACHMENTS_DIRNAME));
        prompt = req.prompt;
        writeFileSync(path.join(req.cwd, "app.js"), "export const x = 3;\n");
        return { structured: devResult(), sessionId: "s", costUsd: 0, numTurns: 1 };
      },
    };
    const id = await newTask();
    await runDevTask(id, deps(runner));
    expect(dirExisted).toBe(false);
    expect(prompt).not.toContain("Pièces jointes du développeur");
    expect((await h.tasks.get(id))!.status).toBe("mr_created");
  });

  it("si l'agent plante, les fichiers sont quand même supprimés du dossier de travail", async () => {
    let dirExisted = false;
    const runner: AgentRunner = {
      async run(req: AgentRequest) {
        dirExisted = existsSync(path.join(req.cwd, ATTACHMENTS_DIRNAME, "capture.png"));
        throw new Error("agent planté");
      },
    };
    const id = await taskWithFiles();
    await runDevTask(id, deps(runner));
    const task = (await h.tasks.get(id))!;
    expect(dirExisted).toBe(true);
    expect(task.status).toBe("error");
    expect(existsSync(path.join(task.worktree_path!, ATTACHMENTS_DIRNAME))).toBe(false);
    expect(h.remoteBranchSha(BRANCH)).toBe("");
  });

  it("un agent qui committe lui-même une pièce jointe malgré l'interdiction : push refusé, rien de publié", async () => {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.com", ...args], { cwd });
    const runner: AgentRunner = {
      async run(req: AgentRequest) {
        writeFileSync(path.join(req.cwd, "app.js"), "export const x = 4;\n");
        mkdirSync(path.join(req.cwd, ATTACHMENTS_DIRNAME), { recursive: true });
        writeFileSync(path.join(req.cwd, ATTACHMENTS_DIRNAME, "copie.png"), PNG);
        git(req.cwd, "add", "-f", "app.js", `${ATTACHMENTS_DIRNAME}/copie.png`);
        git(req.cwd, "commit", "-qm", "commit de l'agent");
        return { structured: devResult(), sessionId: "s", costUsd: 0, numTurns: 1 };
      },
    };
    const id = await taskWithFiles();
    await runDevTask(id, deps(runner));
    const task = (await h.tasks.get(id))!;
    expect(task.status).toBe("error");
    expect(task.error).toMatch(/Pièces jointes présentes parmi les fichiers modifiés/);
    expect(h.remoteBranchSha(BRANCH)).toBe(""); // rien n'a été poussé
    expect(h.connector.createdChangeRequests).toEqual([]);
  });
});
