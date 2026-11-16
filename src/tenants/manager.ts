import path from "node:path";
import type { Config } from "../config.js";
import { auditConnector, auditWorkspace } from "../connectors/audited.js";
import { createForges } from "../connectors/factory.js";
import { ForgeRegistry } from "../connectors/registry.js";
import { createAuditRepo, type AuditRepo } from "../db/audit.js";
import { createCostRepo } from "../db/costs.js";
import type { Db } from "../db/db.js";
import { createDevTaskRepo, type DevTaskRepo } from "../db/devTasks.js";
import { runDevTask, type DevDeps } from "../dev/pipeline.js";
import { errorMessage, log } from "../logger.js";
import { SerialQueue } from "../queue.js";
import { runReview, type PipelineDeps } from "../review/pipeline.js";
import { createReviewRepo } from "../db/reviews.js";
import type { SecretStore } from "../secrets/store.js";
import { applyVaultSecrets, createVault, type Vault } from "../secrets/vault.js";
import { createSettingsStore } from "../settings/store.js";
import { startReviewPoller } from "../triggers/reviewPoller.js";
import type { ConcurrencyLimiter } from "./limiter.js";

/** Tout ce que les routes du serveur utilisent pour servir UNE personne dans UN espace. */
export interface TenantDeps extends PipelineDeps {
  tasks: DevTaskRepo;
  /** Journal des écritures de cette personne sur les forges. */
  audit: AuditRepo;
  vault: Vault;
  enqueueReview: (reviewId: number) => void;
  enqueueDev: (taskId: number) => void;
  queueSize: () => number;
  /** Reconstruit les connexions aux forges de cette personne après un changement de jeton (sans redémarrer l'outil). */
  reload?: () => Promise<void>;
}

/** Une personne dans un espace, avec ses connexions aux forges, ses files et ses pollers. */
export interface Tenant {
  key: string;
  userId: number;
  workspaceId: number;
  deps: TenantDeps;
  /** Arrête ses pollers. Les tâches déjà lancées vont à leur terme. */
  stop(): void;
}

/** Qui sert le gestionnaire : une personne et son espace actif. */
export interface TenantContext {
  userId: number;
  workspaceId: number;
}

/** Points d'accroche remplaçables dans les tests : forges, pollers, pipelines, contrôle des jetons. */
export interface TenantHooks {
  createForges?: typeof createForges;
  startPoller?: typeof startReviewPoller;
  runReview?: typeof runReview;
  runDevTask?: typeof runDevTask;
  verifyGithubToken?: Parameters<typeof createVault>[3];
  verifyGitlabToken?: Parameters<typeof createVault>[4];
}

export interface TenantManagerOptions {
  db: Db;
  /** Configuration lue dans le `.env`. Elle n'est jamais modifiée. */
  config: Config;
  store: SecretStore;
  /** Utilisateur propriétaire : seul à utiliser les jetons et la clé API du `.env`. */
  ownerUserId: number;
  /** Limites de tâches simultanées, partagées par toutes les personnes. */
  limits: { review: ConcurrencyLimiter; dev: ConcurrencyLimiter };
  hooks?: TenantHooks;
}

/**
 * Exécution par personne et par espace. Chaque personne a SES connexions aux forges (jetons de son coffre), SES dépôts de données liés à son
 * espace, SES files et SES pollers ; seule la machine est partagée, avec une limite commune de tâches simultanées. Le propriétaire est le seul
 * à utiliser les jetons du `.env` : les autres partent d'une configuration vide de jetons et d'un dossier de données à part.
 */
export class TenantManager {
  private readonly tenants = new Map<string, Promise<Tenant>>();
  private readonly recovered = new Set<string>();

  constructor(private readonly options: TenantManagerOptions) {}

  /**
   * Retrouve la personne dans son espace, ou la démarre au premier appel.
   * @param ctx Personne et espace.
   * @returns L'exécution de cette personne.
   */
  get(ctx: TenantContext): Promise<Tenant> {
    const key = `${ctx.workspaceId}:${ctx.userId}`;
    let tenant = this.tenants.get(key);
    if (!tenant) {
      tenant = this.build(ctx, key);
      this.tenants.set(key, tenant);
      tenant.catch(() => this.tenants.delete(key)); // un démarrage raté n'est pas gardé : le prochain appel réessaie
    }
    return tenant;
  }

  /**
   * Arrête les pollers d'une personne et reconstruit ses connexions avec les jetons actuels de son coffre.
   * @param ctx Personne et espace.
   * @returns La nouvelle exécution.
   */
  async reload(ctx: TenantContext): Promise<Tenant> {
    const key = `${ctx.workspaceId}:${ctx.userId}`;
    const old = await this.tenants.get(key)?.catch(() => undefined);
    // La nouvelle exécution est construite d'abord : si elle échoue, l'ancienne continue de servir
    const next = await this.build(ctx, key);
    old?.stop();
    this.tenants.set(key, Promise.resolve(next));
    return next;
  }

  /**
   * Démarre au lancement de l'outil le propriétaire et, si l'accès à plusieurs personnes est ouvert, toutes celles qui ont des jetons enregistrés
   * (leurs pollers doivent tourner même quand elles ne sont pas connectées).
   * @param owner Espace et utilisateur du propriétaire.
   * @param includeOthers Vrai si l'accès à plusieurs personnes est ouvert.
   * @returns Les exécutions démarrées.
   */
  async startKnown(owner: TenantContext, includeOthers: boolean): Promise<Tenant[]> {
    const contexts = [owner];
    if (includeOthers) {
      for (const other of await this.options.store.listOwners()) {
        if (!(other.userId === owner.userId && other.workspaceId === owner.workspaceId)) contexts.push(other);
      }
    }
    return Promise.all(contexts.map((ctx) => this.get(ctx)));
  }

  /** Arrête les pollers de tout le monde (arrêt de l'outil). */
  async stopAll(): Promise<void> {
    for (const tenant of await Promise.allSettled([...this.tenants.values()])) {
      if (tenant.status === "fulfilled") tenant.value.stop();
    }
  }

  /**
   * Construit l'exécution d'une personne.
   * @param ctx Personne et espace.
   * @param key Clé de cette personne dans le gestionnaire.
   * @returns L'exécution prête, pollers démarrés.
   */
  private async build(ctx: TenantContext, key: string): Promise<Tenant> {
    const { db, config: base, store, limits, hooks = {} } = this.options;
    const isOwner = ctx.userId === this.options.ownerUserId;
    // Hors propriétaire : aucun jeton ni clé du .env, et un dossier de données à part (copies de dépôts, dossiers de travail)
    const config: Config = isOwner
      ? { ...base }
      : { ...base, dataDir: path.join(base.dataDir, "tenants", `${ctx.workspaceId}-${ctx.userId}`), gitlab: null, github: null, anthropicApiKey: null };

    const vault = createVault(config, store, { workspaceId: ctx.workspaceId, userId: ctx.userId }, hooks.verifyGithubToken, hooks.verifyGitlabToken);
    await applyVaultSecrets(config, vault);

    let forges: ForgeRegistry;
    try {
      forges = await (hooks.createForges ?? createForges)(config, { allowEmpty: true });
    } catch (err) {
      if (isOwner) throw err; // le propriétaire a une configuration dans le .env : une erreur doit arrêter le démarrage
      log.warn("tenant.forges_failed", { userId: ctx.userId, error: errorMessage(err) });
      forges = await (hooks.createForges ?? createForges)({ ...config, gitlab: null, github: null }, { allowEmpty: true });
    }

    // Toute écriture sur une forge (MR, commentaire, approbation, label, branche poussée) laisse une trace au nom de cette personne
    const audit = createAuditRepo(db, ctx.workspaceId, ctx.userId);
    forges = new ForgeRegistry(
      forges.all().map((forge) => ({ ...forge, connector: auditConnector(forge.connector, audit), workspace: auditWorkspace(forge.workspace, audit, forge.connector.kind) })),
      { allowEmpty: true },
    );

    const reviews = createReviewRepo(db, ctx.workspaceId);
    const tasks = createDevTaskRepo(db, ctx.workspaceId);
    const settings = createSettingsStore(db, ctx.workspaceId);
    const costs = createCostRepo(db, ctx.workspaceId);

    const reviewDeps: PipelineDeps = { config, forges, costs, reviews, settings, tasks };
    const devDeps: DevDeps = { config, forges, costs, settings, tasks };
    // Deux files séparées : une review n'attend pas la fin d'une tâche de dev (et inversement) ; la limite commune borne la machine entière
    const reviewQueue = new SerialQueue((id) => limits.review.run(() => (hooks.runReview ?? runReview)(id, reviewDeps)));
    const devQueue = new SerialQueue((id) => limits.dev.run(() => (hooks.runDevTask ?? runDevTask)(id, devDeps)));

    // Reprise après un arrêt : reviews relancées, tâches dev passées en erreur (un agent coupé laisse un état incertain). Une seule fois par personne.
    if (!this.recovered.has(key)) {
      this.recovered.add(key);
      for (const row of await reviews.listInterrupted()) {
        await reviews.setStatus(row.id, "queued");
        reviewQueue.push(row.id);
      }
      for (const task of await tasks.listInterrupted()) {
        await tasks.update(task.id, { status: "error", error: "Interrompue par un redémarrage de l'outil. Rien n'a été poussé si la MR n'existe pas." });
      }
    }

    const stops = forges.all().map((forge) =>
      (hooks.startPoller ?? startReviewPoller)({
        connector: forge.connector,
        reviews,
        settings,
        username: forge.username,
        intervalMs: config.pollIntervalMs,
        enqueue: (id) => reviewQueue.push(id),
      }),
    );

    log.info("tenant.started", { userId: ctx.userId, workspaceId: ctx.workspaceId, forges: forges.all().map((f) => f.connector.kind) });
    return {
      key,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      deps: {
        ...reviewDeps,
        tasks,
        audit,
        vault,
        enqueueReview: (id) => reviewQueue.push(id),
        enqueueDev: (id) => devQueue.push(id),
        queueSize: () => reviewQueue.size + devQueue.size,
        reload: async () => void (await this.reload(ctx)),
      },
      stop: () => {
        for (const stop of stops) stop();
      },
    };
  }
}
