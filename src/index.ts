import { loadConfig, type Config } from "./config.js";
import { createAccountRepo } from "./db/accounts.js";
import { createDevTaskRepo } from "./db/devTasks.js";
import { openDb } from "./db/index.js";
import { createReviewRepo } from "./db/reviews.js";
import { createForges } from "./connectors/factory.js";
import { createCostRepo } from "./db/costs.js";
import { runDevTask } from "./dev/pipeline.js";
import { errorMessage, initFileLogging, log, registerSecret } from "./logger.js";
import { SerialQueue } from "./queue.js";
import { runReview, type PipelineDeps } from "./review/pipeline.js";
import { resolveKeyring } from "./secrets/masterKey.js";
import { createSecretStore, hasAnySecret } from "./secrets/store.js";
import { applyVaultSecrets, createVault } from "./secrets/vault.js";
import { buildServer } from "./server/app.js";
import { createSettingsStore } from "./settings/store.js";
import { startReviewPoller } from "./triggers/reviewPoller.js";

/**
 * Déclare au journal les secrets du `.env` pour qu'ils n'y apparaissent jamais, même dans un message d'erreur.
 * @param config Configuration lue dans le `.env`.
 * @returns Rien.
 */
function registerEnvSecrets(config: Config): void {
  const secrets = [config.gitlab?.token, config.github?.token, config.anthropicApiKey, config.planio?.apiKey, config.secrets.masterKey, ...config.secrets.previousKeys];
  if (config.databaseUrl) secrets.push(decodeURIComponent(new URL(config.databaseUrl).password));
  for (const secret of secrets) registerSecret(secret);
}

async function main(): Promise<void> {
  const config = loadConfig();
  initFileLogging(config.dataDir);
  registerEnvSecrets(config);

  const db = await openDb({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
  // Sans connexion, tout se passe dans l'espace de l'utilisateur local : les dépôts de données y sont liés
  const local = await createAccountRepo(db).localContext();
  const reviews = createReviewRepo(db, local.workspaceId);
  const tasks = createDevTaskRepo(db, local.workspaceId);
  const settings = createSettingsStore(db, local.workspaceId);

  // Coffre à secrets : jeton GitHub et clé API saisis dans le dashboard, complètent ceux du .env (qui reste prioritaire)
  const keyring = await resolveKeyring({
    masterKey: config.secrets.masterKey,
    previousKeys: config.secrets.previousKeys,
    dataDir: config.dataDir,
    serverMode: config.databaseUrl !== null,
    hasSecrets: () => hasAnySecret(db),
  });
  const vault = createVault(config, createSecretStore(db, keyring), { workspaceId: local.workspaceId, userId: local.userId });
  try {
    // Après une rotation de la clé maître, les secrets chiffrés par une ancienne clé passent à la nouvelle (sinon : rien à faire)
    const rewrapped = await vault.store.reencryptAll();
    if (rewrapped > 0) log.info("secrets.reencrypted", { count: rewrapped });
  } catch (err) {
    log.warn("secrets.reencrypt_failed", { error: errorMessage(err) });
  }
  await applyVaultSecrets(config, vault);

  const forges = await createForges(config);

  const costs = createCostRepo(db, local.workspaceId);

  const deps: PipelineDeps = { config, forges, costs, reviews, settings };
  // Deux files séparées : une review n'attend pas la fin d'une tâche de dev (et inversement)
  const reviewQueue = new SerialQueue((id) => runReview(id, deps));
  const devQueue = new SerialQueue((id) => runDevTask(id, { config, forges, costs, settings, tasks }));

  // Reviews interrompues : relancées. Tâches dev interrompues : pas de reprise automatique
  // (un agent coupé en plein travail laisse un état incertain), elles passent en erreur.
  for (const row of await reviews.listInterrupted()) {
    await reviews.setStatus(row.id, "queued");
    reviewQueue.push(row.id);
  }
  for (const task of await tasks.listInterrupted()) {
    await tasks.update(task.id, { status: "error", error: "Interrompue par un redémarrage de l'outil. Rien n'a été poussé si la MR n'existe pas." });
  }

  // Un poller par forge : chacun détecte les demandes de fusion où l'utilisateur est relecteur chez elle
  const stopPollers = forges.all().map((forge) =>
    startReviewPoller({
      connector: forge.connector,
      reviews,
      username: forge.username,
      intervalMs: config.pollIntervalMs,
      enqueue: (id) => reviewQueue.push(id),
    }),
  );

  const server = buildServer({
    ...deps,
    tasks,
    vault,
    enqueueReview: (id) => reviewQueue.push(id),
    enqueueDev: (id) => devQueue.push(id),
    queueSize: () => reviewQueue.size + devQueue.size,
  });
  await server.listen({ host: config.server.host, port: config.server.port });

  log.info("app.started", { dashboard: `http://localhost:${config.server.port}`, actionMode: (await settings.get()).actionMode });

  const shutdown = async () => {
    for (const stop of stopPollers) stop();
    await server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
