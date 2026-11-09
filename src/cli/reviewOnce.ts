/**
 * Lance une review à la main sur une MR précise, sans poller ni dashboard.
 * Usage : npm run review:once -- <url de la MR>
 *     ou npm run review:once -- <projectId> <mrIid>
 * Rien n'est posté sur GitLab (mode ombre forcé) : le résultat est affiché et enregistré en base,
 * visible ensuite dans le dashboard.
 */
import path from "node:path";
import { loadConfig } from "../config.js";
import { GitlabConnector } from "../connectors/gitlab.js";
import { createCostRepo } from "../db/costs.js";
import { openDb } from "../db/index.js";
import { createReviewRepo } from "../db/reviews.js";
import { runReview } from "../review/pipeline.js";
import { RepoWorkspace } from "../review/workspace.js";
import { createSettingsStore } from "../settings/store.js";

const args = process.argv.slice(2);
const usage = "Usage : npm run review:once -- <url de la MR>   (ou <projectId> <mrIid>)";

const config = loadConfig();
const db = await openDb({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
const reviews = createReviewRepo(db);
const settings = createSettingsStore(db);
const connector = GitlabConnector.fromConfig(config.gitlab);
const git = connector.gitCredentials();
const workspace = new RepoWorkspace(path.join(config.dataDir, "repos"), git.token, git.username);

async function resolveTarget(): Promise<{ projectId: number; mrIid: number }> {
  const [first, second] = args;
  const fromUrl = first ? await connector.resolveChangeRequestUrl(first) : null;
  if (fromUrl) return { projectId: fromUrl.projectId, mrIid: fromUrl.iid };
  if (first && second && /^\d+$/.test(first) && /^\d+$/.test(second)) return { projectId: Number(first), mrIid: Number(second) };
  console.error(usage);
  process.exit(1);
}

const { projectId, mrIid } = await resolveTarget();
const mr = await connector.getChangeRequest(projectId, mrIid);
const project = await connector.getProject(mr.projectId);

const id =
  (await reviews.insertIfNew({
    projectId: mr.projectId,
    projectPath: project.path,
    mrIid: mr.iid,
    mrTitle: mr.title,
    mrUrl: mr.url,
    author: mr.author.name,
    headSha: mr.headSha,
  })) ?? (await reviews.list()).find((r) => r.project_id === mr.projectId && r.mr_iid === mr.iid && r.head_sha === mr.headSha)?.id;

if (id === undefined) throw new Error("Impossible de créer la review");

console.log(`Review de ${project.path} !${mr.iid} en cours (quelques minutes)...`);
await runReview(id, { config, connector, costs: createCostRepo(db), reviews, workspace, settings, forceShadow: true });

const row = await reviews.get(id);
console.log(JSON.stringify({ status: row?.status, reasons: row?.decision_reasons ? JSON.parse(row.decision_reasons) : [], cost: row?.cost_usd, error: row?.error }, null, 2));
if (row?.result_json) console.log(JSON.stringify(JSON.parse(row.result_json), null, 2));
await db.close();
