import { readFile } from "node:fs/promises";
import path from "node:path";
import { agentRunConfig, ProcessCancelledError } from "../claude/process.js";
import type { Config } from "../config.js";
import type { DevTaskRepo } from "../db/devTasks.js";
import type { GitlabClient } from "../gitlab/client.js";
import { errorMessage, log } from "../logger.js";
import { PROJECT_ROOT } from "../paths.js";
import type { RepoWorkspace } from "../review/workspace.js";
import type { ProjectSettings } from "../settings/schema.js";
import type { SettingsStore } from "../settings/store.js";
import { buildDevPrompt } from "./context.js";
import { runDevAgent, type DevResult } from "./engine.js";
import { assertBranchAllowed, isSecretFile, isSensitiveFile } from "./guard.js";
import { cleanCommitSubject, ensureDraftTitle, renderTemplate, slugify } from "./templates.js";

export interface DevDeps {
  config: Config;
  gitlab: GitlabClient;
  settings: SettingsStore;
  tasks: DevTaskRepo;
  workspace: RepoWorkspace;
}

/** Tâches en cours d'exécution, pour pouvoir les arrêter depuis le dashboard. */
const running = new Map<number, AbortController>();

export function cancelDevTask(taskId: number): boolean {
  const ctrl = running.get(taskId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

async function loadDevSystemPrompt(project: ProjectSettings): Promise<string> {
  const [base, perso] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, "prompts", "dev-system.md"), "utf8"),
    readFile(path.join(PROJECT_ROOT, "prompts", "dev-instructions-perso.md"), "utf8").catch(() => ""),
  ]);
  const parts = [base];
  if (perso.trim()) parts.push(`# Consignes générales du développeur\n\n${perso}`);
  if (project.instructions.trim()) parts.push(`# Consignes propres au projet ${project.path}\n\n${project.instructions}`);
  parts.push(
    project.allowedCommands.length
      ? `# Commandes autorisées sur ce projet\n\n${project.allowedCommands.map((c) => `- \`${c}\``).join("\n")}`
      : "# Commandes autorisées sur ce projet\n\nAucune : ne lance pas de tests, indique-le dans ton rapport.",
  );
  return parts.join("\n\n");
}

/**
 * Traite un ticket de bout en bout :
 * branche depuis la base → agent → contrôles → commit → push de CETTE branche uniquement → MR Draft.
 * Le passage en Ready (et donc en « Validation technique » côté timelog) reste manuel.
 */
export async function runDevTask(taskId: number, deps: DevDeps): Promise<void> {
  const { gitlab, tasks, workspace } = deps;
  const task = tasks.get(taskId);
  if (!task) return;

  const ctrl = new AbortController();
  running.set(taskId, ctrl);
  const step = (text: string) => tasks.addEvent(taskId, "step", text);

  try {
    const settings = deps.settings.get();
    const project = deps.settings.getProject(task.project_id);
    if (!project?.devEnabled) throw new Error("Projet non configuré pour l'agent dev (Paramètres > Projets)");

    tasks.update(taskId, { status: "running", base_branch: project.baseBranch, target_branch: project.targetBranch });
    log.info("dev.start", { taskId, project: task.project_path, issue: task.issue_iid });

    const [gproject, issue, notes, me, protectedBranches] = await Promise.all([
      gitlab.getProject(task.project_id),
      gitlab.getIssue(task.project_id, task.issue_iid),
      gitlab.getIssueNotes(task.project_id, task.issue_iid),
      gitlab.getCurrentUser(),
      gitlab.getProtectedBranches(task.project_id),
    ]);
    if (!issue) throw new Error(`Ticket #${task.issue_iid} introuvable`);

    // --- Branche -------------------------------------------------------------
    const branch = renderTemplate(settings.templates.branch, { iid: issue.iid, title: issue.title, slug: slugify(issue.title) });
    const forbidden = [project.baseBranch, project.targetBranch, ...protectedBranches.map((b) => b.name)];
    assertBranchAllowed(branch, { issueIid: issue.iid, forbidden });
    if (await gitlab.branchExists(task.project_id, branch)) {
      throw new Error(`La branche « ${branch} » existe déjà sur GitLab : supprime-la ou termine le travail en cours dessus`);
    }

    const worktree = await workspace.createBranchWorktree(task.project_id, gproject.http_url_to_repo, project.baseBranch, branch);
    const baseSha = await workspace.headSha(worktree);
    tasks.update(taskId, { branch, worktree_path: worktree });
    step(`Branche ${branch} créée depuis ${project.baseBranch}`);

    if (settings.workflow.labelOnStart) {
      await gitlab.addIssueLabels(task.project_id, issue.iid, [settings.workflow.labelOnStart]);
      step(`Label « ${settings.workflow.labelOnStart} » posé sur le ticket`);
    }

    // --- Agent ---------------------------------------------------------------
    const claudeMd = await readFile(path.join(worktree, "CLAUDE.md"), "utf8").catch(() => "");
    step("Agent lancé");
    const out = await runDevAgent({
      cwd: worktree,
      systemPrompt: await loadDevSystemPrompt(project),
      prompt: buildDevPrompt({
        project: gproject,
        issue,
        notes,
        baseBranch: project.baseBranch,
        branch,
        claudeMd,
        extraInstructions: task.extra_instructions,
      }),
      engine: agentRunConfig(deps.config.claudeBin, settings.dev),
      allowedCommands: project.allowedCommands,
      signal: ctrl.signal,
      onEvent: (kind, text) => tasks.addEvent(taskId, kind, text),
      onSession: (sessionId) => tasks.update(taskId, { session_id: sessionId }),
    });
    tasks.update(taskId, { result_json: JSON.stringify(out.result), cost_usd: out.costUsd, num_turns: out.numTurns });

    if (out.result.status === "blocked") {
      tasks.update(taskId, { status: "blocked" });
      step("L'agent s'est arrêté : il a besoin d'informations. Rien n'a été poussé.");
      return;
    }

    // --- Contrôles avant push ------------------------------------------------
    if (await workspace.foldAgentCommits(worktree, baseSha)) {
      step("L'agent avait committé lui-même : ses commits sont repliés dans le commit de l'outil");
    }
    const changed = await workspace.changedFiles(worktree);
    if (changed.length === 0) throw new Error("L'agent n'a modifié aucun fichier");
    const secrets = changed.filter(isSecretFile);
    if (secrets.length > 0) {
      throw new Error(`Fichiers sensibles modifiés (${secrets.join(", ")}) : push refusé. Le travail reste dans le dossier local.`);
    }

    const commitMessage = renderTemplate(settings.templates.commit, {
      iid: issue.iid,
      title: issue.title,
      summary: cleanCommitSubject(out.result.commit_message, issue.title),
    });
    await workspace.commitAll(worktree, commitMessage, { name: me.name, email: me.commit_email || me.email || me.public_email || `${me.username}@users.noreply` });
    step(`Commit : ${commitMessage} (${changed.length} fichier(s))`);

    // Revérifié juste avant le push : c'est le dernier point de contrôle
    assertBranchAllowed(branch, { issueIid: issue.iid, forbidden });
    await workspace.pushBranch(worktree, branch);
    step(`Branche ${branch} poussée`);

    // --- MR Draft ------------------------------------------------------------
    const vars = { iid: issue.iid, title: issue.title, summary: out.result.summary };
    const mr = await gitlab.createMergeRequest(task.project_id, {
      source_branch: branch,
      target_branch: project.targetBranch,
      title: ensureDraftTitle(renderTemplate(settings.templates.mrTitle, vars)),
      description: [renderTemplate(settings.templates.mrDescription, vars), formatDevReport(out.result, changed)].filter(Boolean).join("\n\n"),
      assignee_id: me.id,
      remove_source_branch: true,
    });

    tasks.update(taskId, { status: "mr_created", mr_iid: mr.iid, mr_url: mr.web_url, files_changed: changed.length });
    step(`MR Draft !${mr.iid} créée vers ${project.targetBranch}`);
    log.info("dev.done", { taskId, mr: mr.iid, files: changed.length, costUsd: out.costUsd });
  } catch (err) {
    if (err instanceof ProcessCancelledError || ctrl.signal.aborted) {
      tasks.update(taskId, { status: "cancelled" });
      step("Tâche arrêtée. Rien n'a été poussé.");
    } else {
      log.error("dev.error", { taskId, error: errorMessage(err) });
      tasks.update(taskId, { status: "error", error: errorMessage(err) });
      tasks.addEvent(taskId, "error", errorMessage(err));
    }
  } finally {
    running.delete(taskId);
  }
}

/** Section ajoutée à la description de la MR. */
export function formatDevReport(result: DevResult, changedFiles: string[]): string {
  const lines = ["---", "🤖 **Développé par un agent IA**, à relire avant de passer la MR en Ready.", ""];

  const sensitive = changedFiles.filter(isSensitiveFile);
  if (sensitive.length > 0) {
    lines.push(`⚠️ **Fichiers sensibles modifiés** (relecture attentive) : ${sensitive.map((f) => `\`${f}\``).join(", ")}`, "");
  }
  lines.push("**Tests :** " + result.tests, "");
  if (result.notes_for_reviewer.length > 0) {
    lines.push("**Points à vérifier :**", ...result.notes_for_reviewer.map((n) => `- ${n}`), "");
  }
  if (result.questions.length > 0) {
    lines.push("**Questions ouvertes :**", ...result.questions.map((q) => `- ${q}`), "");
  }
  return lines.join("\n").trim();
}
