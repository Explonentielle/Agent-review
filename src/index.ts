import { createAuthRuntime } from "./auth/runtime.js";
import { claudeEnv } from "./claude/process.js";
import { createClaudeStatusProbe } from "./claude/status.js";
import { loadConfig, type Config } from "./config.js";
import { createAccountRepo } from "./db/accounts.js";
import { openDb } from "./db/index.js";
import { errorMessage, initFileLogging, log, registerSecret } from "./logger.js";
import { resolveKeyring } from "./secrets/masterKey.js";
import { createSecretStore, hasAnySecret } from "./secrets/store.js";
import { buildServer } from "./server/app.js";
import { ConcurrencyLimiter } from "./tenants/limiter.js";
import { TenantManager } from "./tenants/manager.js";
import { claudeTerminalLaunch } from "./terminal/launch.js";
import { TerminalHub } from "./terminal/session.js";

/**
 * Déclare au journal les secrets du `.env` pour qu'ils n'y apparaissent jamais, même dans un message d'erreur.
 * @param config Configuration lue dans le `.env`.
 * @returns Rien.
 */
function registerEnvSecrets(config: Config): void {
  const secrets = [
    config.gitlab?.token,
    config.github?.token,
    config.anthropicApiKey,
    config.planio?.apiKey,
    config.secrets.masterKey,
    ...config.secrets.previousKeys,
    config.auth?.gitlab?.clientSecret,
    config.auth?.github?.clientSecret,
    config.auth?.mail?.apiKey,
  ];
  if (config.databaseUrl) secrets.push(decodeURIComponent(new URL(config.databaseUrl).password));
  for (const secret of secrets) registerSecret(secret);
}

async function main(): Promise<void> {
  const config = loadConfig();
  initFileLogging(config.dataDir);
  registerEnvSecrets(config);

  const db = await openDb({ dataDir: config.dataDir, databaseUrl: config.databaseUrl });
  const accounts = createAccountRepo(db);
  // Sans connexion, tout se passe dans l'espace de l'utilisateur local, propriétaire de l'installation
  const local = await accounts.localContext();

  // Coffre à secrets : jetons de forge et clé API saisis dans le dashboard, complètent ceux du .env (qui reste prioritaire pour le propriétaire)
  const keyring = await resolveKeyring({
    masterKey: config.secrets.masterKey,
    previousKeys: config.secrets.previousKeys,
    dataDir: config.dataDir,
    serverMode: config.databaseUrl !== null,
    hasSecrets: () => hasAnySecret(db),
  });
  const store = createSecretStore(db, keyring);
  try {
    // Après une rotation de la clé maître, les secrets chiffrés par une ancienne clé passent à la nouvelle (sinon : rien à faire)
    const rewrapped = await store.reencryptAll();
    if (rewrapped > 0) log.info("secrets.reencrypted", { count: rewrapped });
  } catch (err) {
    log.warn("secrets.reencrypt_failed", { error: errorMessage(err) });
  }

  // Connexion par compte de forge : seulement si une application OAuth est configurée dans le .env, sinon l'outil sert l'utilisateur local
  const auth = config.auth ? createAuthRuntime(config.auth, db, accounts) : undefined;
  if (auth) {
    const purge = () => {
      void auth.sessions.purgeExpired().catch((err: unknown) => log.warn("auth.purge_failed", { error: errorMessage(err) }));
      void auth.password?.tokens.purge().catch((err: unknown) => log.warn("auth.purge_failed", { error: errorMessage(err) }));
    };
    purge();
    setInterval(purge, 3_600_000).unref();
    log.info("auth.enabled", { providers: [...auth.providers.keys()], password: Boolean(auth.password), signup: auth.policy.signup, owner: auth.policy.owner, multiUser: auth.policy.multiUser });
  }

  // Chaque personne a ses connexions aux forges, ses files et ses pollers ; la machine est partagée, avec une limite commune d'agents simultanés
  const manager = new TenantManager({
    db,
    config,
    store,
    ownerUserId: local.userId,
    limits: { review: new ConcurrencyLimiter(config.maxConcurrentAgents), dev: new ConcurrencyLimiter(config.maxConcurrentAgents) },
  });
  const [owner] = await manager.startKnown(local, auth?.policy.multiUser ?? false);

  // Terminal Claude du navigateur : la CLI seule, avec l'environnement filtré des agents (jamais les secrets de l'outil)
  const terminalHub = new TerminalHub();
  const terminal = {
    hub: terminalHub,
    launch: () => claudeTerminalLaunch({ claudeBin: config.claudeBin, env: claudeEnv(), cwd: config.dataDir }),
    status: createClaudeStatusProbe(config.claudeBin, () => claudeEnv()),
  };

  const server = buildServer({
    ...owner!.deps,
    accounts,
    local,
    auth,
    terminal,
    // Avec ou sans connexion : chaque requête est servie avec les connexions actuelles de la personne, même après une reconstruction
    tenants: async (who) => (await manager.get(who)).deps,
    // Quelqu'un quitte l'espace : ses détecteurs s'arrêtent et ses jetons de cet espace sont effacés (il ne doit rien garder d'un espace qui n'est plus le sien)
    onMemberRemoved: async (who) => {
      await manager.drop(who);
      for (const secret of await store.list(who)) await store.delete(who, secret.name);
    },
  });
  await server.listen({ host: config.server.host, port: config.server.port });

  log.info("app.started", { dashboard: `http://localhost:${config.server.port}`, actionMode: (await owner!.deps.settings.get()).actionMode });

  const shutdown = async () => {
    terminalHub.stopAll();
    await manager.stopAll();
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
