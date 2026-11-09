import { readFile } from "node:fs/promises";
import path from "node:path";
import { agentRunConfig, ProcessCancelledError } from "../claude/process.js";
import type { Config } from "../config.js";
import type { DevTaskRepo, DevTaskRow } from "../db/devTasks.js";
import type { GitlabClient } from "../gitlab/client.js";
import type { GitlabCurrentUser } from "../gitlab/types.js";
import { errorMessage, log } from "../logger.js";
import { loadSystemPrompt } from "../prompts.js";
import type { RepoWorkspace } from "../review/workspace.js";
import type { ProjectSettings, Settings } from "../settings/schema.js";
import type { SettingsStore } from "../settings/store.js";
import { buildDevPrompt, buildFollowupPrompt } from "./context.js";
import { DevResultSchema, runDevAgent, type DevEngineOutput, type DevResult } from "./engine.js";
import { assertBranchAllowed, isSecretFile, isSensitiveFile } from "./guard.js";
import { cleanCommitSubject, ensureDraftTitle, renderTemplate, slugify } from "./templates.js";

export interface DevDeps {
  config: Config;
  gitlab: GitlabClient;
  settings: SettingsStore;
  tasks: DevTaskRepo;
  workspace: RepoWorkspace;
}

/** Contexte commun aux deux modes (nouveau ticket, reprise de MR). */
interface RunContext {
  deps: DevDeps;
  task: DevTaskRow;
  settings: Settings;
  project: ProjectSettings;
  signal: AbortSignal;
  step: (text: string) => void;
}

/** Tâches en cours d'exécution, pour pouvoir les arrêter depuis le dashboard. */
const running = new Map<number, AbortController>();

export function cancelDevTask(taskId: number): boolean {
  const ctrl = running.get(taskId);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

/** `{worktree}` dans une commande autorisée = dossier de travail de l'agent (ex. à monter dans un conteneur de test). */
export function resolveCommands(commands: string[], worktree: string): string[] {
  return commands.map((c) => c.replaceAll("{worktree}", worktree));
}

/** Prompt système : base (dashboard ou fichier) + consignes + commandes autorisées + garde-fous. */
function loadDevSystemPrompt(settings: Settings, project: ProjectSettings, commands: string[]): Promise<string> {
  const block = commands.length
    ? `# Commandes autorisées sur ce projet\n\n${commands.map((c) => `- \`${c}\``).join("\n")}`
    : "# Commandes autorisées sur ce projet\n\nAucune : ne lance pas de tests, indique-le dans ton rapport.";
  return loadSystemPrompt("dev", {
    override: settings.systemPrompts.dev,
    instructions: settings.instructions.dev,
    project,
    extra: [block],
  });
}

/**
 * Exécute une tâche de l'agent dev :
 * - nouveau ticket : branche depuis la base → agent → contrôles → commit → push de CETTE branche → MR Draft ;
 * - reprise : branche de la MR telle que sur GitLab → agent avec tes consignes → contrôles → nouveau commit → push → commentaire sur la MR.
 * Le passage en Ready reste manuel.
 */
export async function runDevTask(taskId: number, deps: DevDeps): Promise<void> {
  const { tasks } = deps;
  const task = tasks.get(taskId);
  if (!task) return;

  const ctrl = new AbortController();
  running.set(taskId, ctrl);
  const step = (text: string) => tasks.addEvent(taskId, "step", text);

  try {
    const settings = deps.settings.get();
    const project = deps.settings.getProject(task.project_id);
    if (!project?.devEnabled) throw new Error("Projet non configuré pour l'agent dev (Paramètres > Projets)");

    tasks.update(taskId, { status: "running" });
    log.info("dev.start", { taskId, project: task.project_path, issue: task.issue_iid, mode: task.mode });

    const ctx: RunContext = { deps, task, settings, project, signal: ctrl.signal, step };
    if (task.mode === "followup") await runFollowup(ctx);
    else await runNewTicket(ctx);
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

async function runNewTicket(c: RunContext): Promise<void> {
  const { gitlab, tasks, workspace } = c.deps;
  const { task, settings, project, step } = c;
  tasks.update(task.id, { base_branch: project.baseBranch, target_branch: project.targetBranch });

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
    throw new Error(`La branche « ${branch} » existe déjà sur GitLab : supprime-la, ou utilise « Reprendre avec des consignes » sur la tâche qui l'a créée`);
  }

  const worktree = await workspace.createBranchWorktree(task.project_id, gproject.http_url_to_repo, project.baseBranch, branch);
  const baseSha = await workspace.headSha(worktree);
  tasks.update(task.id, { branch, worktree_path: worktree });
  step(`Branche ${branch} créée depuis ${project.baseBranch}`);

  if (settings.workflow.labelOnStart) {
    await gitlab.addIssueLabels(task.project_id, issue.iid, [settings.workflow.labelOnStart]);
    step(`Label « ${settings.workflow.labelOnStart} » posé sur le ticket`);
  }

  // --- Agent ---------------------------------------------------------------
  step("Agent lancé");
  const out = await runAgent(c, worktree, buildDevPrompt({
    project: gproject,
    issue,
    notes,
    baseBranch: project.baseBranch,
    branch,
    claudeMd: await readClaudeMd(worktree),
    extraInstructions: task.extra_instructions,
  }));
  if (out.result.status === "blocked") return markBlocked(c);

  // --- Commit + push ---------------------------------------------------------
  const changed = await commitAgentWork(c, worktree, baseSha, me, { iid: issue.iid, title: issue.title }, out.result);
  assertBranchAllowed(branch, { issueIid: issue.iid, forbidden }); // dernier point de contrôle avant le push
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

  tasks.update(task.id, { status: "mr_created", mr_iid: mr.iid, mr_url: mr.web_url, files_changed: changed.length });
  step(`MR Draft !${mr.iid} créée vers ${project.targetBranch}`);
  log.info("dev.done", { taskId: task.id, mr: mr.iid, files: changed.length, costUsd: out.costUsd });
}

async function runFollowup(c: RunContext): Promise<void> {
  const { gitlab, tasks, workspace } = c.deps;
  const { task, project, step } = c;
  const instructions = task.extra_instructions?.trim();
  if (!task.branch || !task.mr_iid || !instructions) throw new Error("Reprise incomplète : branche, MR ou consignes manquantes");
  const branch = task.branch;
  const targetBranch = task.target_branch || project.targetBranch;

  const [gproject, issue, mr, mrNotes, me, protectedBranches] = await Promise.all([
    gitlab.getProject(task.project_id),
    gitlab.getIssue(task.project_id, task.issue_iid),
    gitlab.getMergeRequest(task.project_id, task.mr_iid),
    gitlab.getMergeRequestNotes(task.project_id, task.mr_iid),
    gitlab.getCurrentUser(),
    gitlab.getProtectedBranches(task.project_id),
  ]);
  if (!issue) throw new Error(`Ticket #${task.issue_iid} introuvable`);
  if (mr.state !== "opened") throw new Error(`La MR !${mr.iid} n'est plus ouverte (${mr.state}) : reprise impossible`);
  if (mr.source_branch !== branch) throw new Error(`La MR !${mr.iid} ne part plus de « ${branch} » mais de « ${mr.source_branch} »`);

  const forbidden = [project.baseBranch, project.targetBranch, targetBranch, ...protectedBranches.map((b) => b.name)];
  assertBranchAllowed(branch, { issueIid: issue.iid, forbidden });

  // --- Branche existante, à jour avec GitLab ---------------------------------
  await workspace.fetchBranch(task.project_id, gproject.http_url_to_repo, targetBranch); // pour `git diff origin/<cible>...HEAD`
  const worktree = await workspace.checkoutExistingBranch(task.project_id, gproject.http_url_to_repo, branch);
  const baseSha = await workspace.headSha(worktree);
  tasks.update(task.id, { worktree_path: worktree });
  step(`Branche ${branch} récupérée depuis GitLab (${baseSha.slice(0, 8)})`);

  // --- Agent ---------------------------------------------------------------
  const parent = task.parent_id ? tasks.get(task.parent_id) : undefined;
  step("Agent lancé (reprise)");
  const out = await runAgent(c, worktree, buildFollowupPrompt({
    project: gproject,
    issue,
    mr,
    mrNotes,
    previousReport: parseReport(parent?.result_json ?? null),
    branch,
    targetBranch,
    claudeMd: await readClaudeMd(worktree),
    instructions,
  }));
  if (out.result.status === "blocked") return markBlocked(c);

  // --- Nouveau commit + push (fast-forward, jamais de --force) ---------------
  const changed = await commitAgentWork(c, worktree, baseSha, me, { iid: issue.iid, title: issue.title }, out.result);
  assertBranchAllowed(branch, { issueIid: issue.iid, forbidden });
  await workspace.pushBranch(worktree, branch);
  step(`Nouveau commit poussé sur ${branch}`);

  await gitlab.createMergeRequestNote(task.project_id, mr.iid, formatFollowupNote(instructions, out.result, changed));
  tasks.update(task.id, { status: "mr_updated", files_changed: changed.length });
  step(`MR !${mr.iid} mise à jour, commentaire ajouté avec le rapport de la reprise`);
  log.info("dev.followup_done", { taskId: task.id, mr: mr.iid, files: changed.length, costUsd: out.costUsd });
}

// --- Étapes communes ---------------------------------------------------------

async function runAgent(c: RunContext, worktree: string, prompt: string): Promise<DevEngineOutput> {
  const { tasks } = c.deps;
  const commands = resolveCommands(c.project.allowedCommands, worktree);
  const out = await runDevAgent({
    cwd: worktree,
    systemPrompt: await loadDevSystemPrompt(c.settings, c.project, commands),
    prompt,
    engine: agentRunConfig(c.deps.config.claudeBin, c.settings.dev),
    allowedCommands: commands,
    signal: c.signal,
    onEvent: (kind, text) => tasks.addEvent(c.task.id, kind, text),
    onSession: (sessionId) => tasks.update(c.task.id, { session_id: sessionId }),
  });
  tasks.update(c.task.id, { result_json: JSON.stringify(out.result), cost_usd: out.costUsd, num_turns: out.numTurns });
  return out;
}

function markBlocked(c: RunContext): void {
  c.deps.tasks.update(c.task.id, { status: "blocked" });
  c.step("L'agent s'est arrêté : il a besoin d'informations. Rien n'a été poussé.");
}

/** Contrôles avant push puis commit unique de l'outil. Retourne les fichiers modifiés. */
async function commitAgentWork(
  c: RunContext,
  worktree: string,
  baseSha: string,
  me: GitlabCurrentUser,
  issue: { iid: number; title: string },
  result: DevResult,
): Promise<string[]> {
  const { workspace } = c.deps;
  if (await workspace.foldAgentCommits(worktree, baseSha)) {
    c.step("L'agent avait committé lui-même : ses commits sont repliés dans le commit de l'outil");
  }
  const changed = await workspace.changedFiles(worktree);
  if (changed.length === 0) throw new Error("L'agent n'a modifié aucun fichier");
  const secrets = changed.filter(isSecretFile);
  if (secrets.length > 0) {
    throw new Error(`Fichiers sensibles modifiés (${secrets.join(", ")}) : push refusé. Le travail reste dans le dossier local.`);
  }

  const commitMessage = renderTemplate(c.settings.templates.commit, {
    iid: issue.iid,
    title: issue.title,
    summary: cleanCommitSubject(result.commit_message, issue.title),
  });
  await workspace.commitAll(worktree, commitMessage, { name: me.name, email: me.commit_email || me.email || me.public_email || `${me.username}@users.noreply` });
  c.step(`Commit : ${commitMessage} (${changed.length} fichier(s))`);
  return changed;
}

/** CLAUDE.md du dépôt (non chargé automatiquement à cause de --safe-mode). */
function readClaudeMd(worktree: string): Promise<string> {
  return readFile(path.join(worktree, "CLAUDE.md"), "utf8").catch(() => "");
}

function parseReport(json: string | null): DevResult | null {
  if (!json) return null;
  const parsed = DevResultSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : null;
}

// --- Textes publiés sur GitLab -------------------------------------------------

/** Tests, fichiers sensibles, points à vérifier, questions : commun à la MR et aux commentaires de reprise. */
function reportBody(result: DevResult, changedFiles: string[]): string[] {
  const lines: string[] = [];
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
  return lines;
}

/** Section ajoutée à la description de la MR. */
export function formatDevReport(result: DevResult, changedFiles: string[]): string {
  return ["---", "🤖 **Développé par un agent IA**, à relire avant de passer la MR en Ready.", "", ...reportBody(result, changedFiles)].join("\n").trim();
}

/** Commentaire posté sur la MR après une reprise. */
export function formatFollowupNote(instructions: string, result: DevResult, changedFiles: string[]): string {
  return [
    "🤖 **Reprise par un agent IA** : nouveau commit sur cette MR, à relire.",
    "",
    "**Consignes :**",
    ...instructions.split("\n").map((l) => `> ${l}`),
    "",
    `**Ce qui a changé :** ${result.summary}`,
    "",
    ...reportBody(result, changedFiles),
  ].join("\n").trim();
}
