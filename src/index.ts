import path from "node:path";
import { loadConfig } from "./config.js";
import { createDevTaskRepo } from "./db/devTasks.js";
import { openDb } from "./db/index.js";
import { createReviewRepo } from "./db/reviews.js";
import { runDevTask } from "./dev/pipeline.js";
import { GitlabClient } from "./gitlab/client.js";
import { initFileLogging, log } from "./logger.js";
import { SerialQueue } from "./queue.js";
import { runReview, type PipelineDeps } from "./review/pipeline.js";
import { RepoWorkspace } from "./review/workspace.js";
import { buildServer } from "./server/app.js";
import { createSettingsStore } from "./settings/store.js";
import { startGitlabPoller } from "./triggers/gitlabPoller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  initFileLogging(config.dataDir);

  const db = openDb(config.dataDir);
  const reviews = createReviewRepo(db);
  const tasks = createDevTaskRepo(db);
  const settings = createSettingsStore(db);
  const gitlab = new GitlabClient(config.gitlab.url, config.gitlab.token);
  const workspace = new RepoWorkspace(path.join(config.dataDir, "repos"), config.gitlab.token);

  const deps: PipelineDeps = { config, gitlab, reviews, workspace, settings };
  // Deux files séparées : une review n'attend pas la fin d'une tâche de dev (et inversement)
  const reviewQueue = new SerialQueue((id) => runReview(id, deps));
  const devQueue = new SerialQueue((id) => runDevTask(id, { config, gitlab, settings, tasks, workspace }));

  // Reviews interrompues : relancées. Tâches dev interrompues : pas de reprise automatique
  // (un agent coupé en plein travail laisse un état incertain), elles passent en erreur.
  for (const row of reviews.listInterrupted()) {
    reviews.setStatus(row.id, "queued");
    reviewQueue.push(row.id);
  }
  for (const task of tasks.listInterrupted()) {
    tasks.update(task.id, { status: "error", error: "Interrompue par un redémarrage de l'outil. Rien n'a été poussé si la MR n'existe pas." });
  }

  const stopPoller = startGitlabPoller({
    gitlab,
    reviews,
    username: config.gitlab.username,
    intervalMs: config.gitlab.pollIntervalMs,
    enqueue: (id) => reviewQueue.push(id),
  });

  const server = buildServer({
    ...deps,
    tasks,
    enqueueReview: (id) => reviewQueue.push(id),
    enqueueDev: (id) => devQueue.push(id),
    queueSize: () => reviewQueue.size + devQueue.size,
  });
  await server.listen({ host: config.server.host, port: config.server.port });

  log.info("app.started", { dashboard: `http://localhost:${config.server.port}`, actionMode: settings.get().actionMode });

  const shutdown = async () => {
    stopPoller();
    await server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
