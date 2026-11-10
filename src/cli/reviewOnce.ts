/**
 * Lance une review à la main sur une MR précise, sans poller ni dashboard.
 * Usage : npm run review:once -- <url de la MR ou de la PR>
 *     ou npm run review:once -- <projectId> <mrIid>   (forge GitLab, ou la seule forge configurée)
 * Rien n'est posté sur la forge (mode ombre forcé) : le résultat est affiché et enregistré en base,
 * visible ensuite dans le dashboard.
 */
import { loadConfig } from "../config.js";
import { createForges } from "../connectors/factory.js";
import { DEFAULT_FORGE } from "../connectors/forges.js";
import type { Forge } from "../connectors/registry.js";
import { createAccountRepo } from "../db/accounts.js";
import { createCostRepo } from "../db/costs.js";
import { openDb } from "../db/index.js";
import { createReviewRepo } from "../db/reviews.js";
import { runReview } from "../review/pipeline.js";
import { createSettingsStore } from "../settings/store.js";

const args = process.argv.slice(2);
const usage = "Usage : npm run review:once -- <url de la MR ou de la PR>   (ou <projectId> <mrIid>)";

const config = loadConfig();
const db = await openDb({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
const local = await createAccountRepo(db).localContext(); // sans connexion : l'espace de l'utilisateur local
const reviews = createReviewRepo(db, local.workspaceId);
const settings = createSettingsStore(db, local.workspaceId);
const forges = await createForges(config);

async function resolveTarget(): Promise<{ forge: Forge; projectId: number; mrIid: number }> {
  const [first, second] = args;
  if (first) {
    for (const forge of forges.all()) {
      const fromUrl = await forge.connector.resolveChangeRequestUrl(first);
      if (fromUrl) return { forge, projectId: fromUrl.projectId, mrIid: fromUrl.iid };
    }
  }
  if (first && second && /^\d+$/.test(first) && /^\d+$/.test(second)) {
    const forge = forges.has(DEFAULT_FORGE) ? forges.get(DEFAULT_FORGE) : forges.all()[0]!;
    return { forge, projectId: Number(first), mrIid: Number(second) };
  }
  console.error(usage);
  process.exit(1);
}

const { forge, projectId, mrIid } = await resolveTarget();
const { connector } = forge;
const mr = await connector.getChangeRequest(projectId, mrIid);
const project = await connector.getProject(mr.projectId);

const id =
  (await reviews.insertIfNew({
    source: connector.kind,
    projectId: mr.projectId,
    projectPath: project.path,
    mrIid: mr.iid,
    mrTitle: mr.title,
    mrUrl: mr.url,
    author: mr.author.name,
    headSha: mr.headSha,
  })) ?? (await reviews.list()).find((r) => r.source === connector.kind && r.project_id === mr.projectId && r.mr_iid === mr.iid && r.head_sha === mr.headSha)?.id;

if (id === undefined) throw new Error("Impossible de créer la review");

console.log(`Review de ${project.path} !${mr.iid} en cours (quelques minutes)...`);
await runReview(id, { config, forges, costs: createCostRepo(db, local.workspaceId), reviews, settings, forceShadow: true });

const row = await reviews.get(id);
console.log(JSON.stringify({ status: row?.status, reasons: row?.decision_reasons ? JSON.parse(row.decision_reasons) : [], cost: row?.cost_usd, error: row?.error }, null, 2));
if (row?.result_json) console.log(JSON.stringify(JSON.parse(row.result_json), null, 2));
await db.close();
