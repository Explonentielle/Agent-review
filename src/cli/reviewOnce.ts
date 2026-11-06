/**
 * Lance une review à la main sur une MR précise, sans poller ni dashboard.
 * Usage : npm run review:once -- <url de la MR>
 *     ou npm run review:once -- <projectId> <mrIid>
 * Rien n'est posté sur GitLab (mode ombre forcé) : le résultat est affiché et enregistré en base,
 * visible ensuite dans le dashboard.
 */
import path from "node:path";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { createReviewRepo } from "../db/reviews.js";
import { GitlabClient } from "../gitlab/client.js";
import { runReview } from "../review/pipeline.js";
import { RepoWorkspace } from "../review/workspace.js";
import { createSettingsStore } from "../settings/store.js";

const args = process.argv.slice(2);
const usage = "Usage : npm run review:once -- <url de la MR>   (ou <projectId> <mrIid>)";

const config = loadConfig();
const db = openDb(config.dataDir);
const reviews = createReviewRepo(db);
const settings = createSettingsStore(db);
const gitlab = new GitlabClient(config.gitlab.url, config.gitlab.token);
const workspace = new RepoWorkspace(path.join(config.dataDir, "repos"), config.gitlab.token);

async function resolveTarget(): Promise<{ projectId: number; mrIid: number }> {
  const [first, second] = args;
  const fromUrl = first?.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (fromUrl) {
    const project = await gitlab.getProjectByPath(fromUrl[1]!);
    return { projectId: project.id, mrIid: Number(fromUrl[2]) };
  }
  if (first && second && /^\d+$/.test(first) && /^\d+$/.test(second)) return { projectId: Number(first), mrIid: Number(second) };
  console.error(usage);
  process.exit(1);
}

const { projectId, mrIid } = await resolveTarget();
const mr = await gitlab.getMergeRequest(projectId, mrIid);
const project = await gitlab.getProject(mr.project_id);

const id =
  reviews.insertIfNew({
    projectId: mr.project_id,
    projectPath: project.path_with_namespace,
    mrIid: mr.iid,
    mrTitle: mr.title,
    mrUrl: mr.web_url,
    author: mr.author.name,
    headSha: mr.sha,
  }) ?? reviews.list().find((r) => r.project_id === mr.project_id && r.mr_iid === mr.iid && r.head_sha === mr.sha)?.id;

if (id === undefined) throw new Error("Impossible de créer la review");

console.log(`Review de ${project.path_with_namespace} !${mr.iid} en cours (quelques minutes)...`);
await runReview(id, { config, gitlab, reviews, workspace, settings, forceShadow: true });

const row = reviews.get(id);
console.log(JSON.stringify({ status: row?.status, reasons: row?.decision_reasons ? JSON.parse(row.decision_reasons) : [], cost: row?.cost_usd, error: row?.error }, null, 2));
if (row?.result_json) console.log(JSON.stringify(JSON.parse(row.result_json), null, 2));
db.close();
