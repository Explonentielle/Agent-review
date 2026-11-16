import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRunner } from "../agent/index.js";
import type { AgentRunner } from "../agent/runner.js";
import { agentRunConfig } from "../claude/process.js";
import type { Config } from "../config.js";
import { log } from "../logger.js";
import { loadSystemPrompt } from "../prompts.js";
import { ScribeInputError, cleanIdea } from "../scribe/clean.js";
import { ScribeLimitError, createLimiter } from "../scribe/limiter.js";
import type { SettingsStore } from "../settings/store.js";
import { RoomDraftError, draftRoom, roomCatalogPrompt, roomExamplePrompt } from "./draft.js";
import { ROOMS_DIR } from "./routes.js";
import { loadRooms } from "./registry.js";
import type { Room } from "./schema.js";
import { MAX_ROOMS_PER_USER, RoomStoreError, createRoomStore, type Visibility } from "./userRooms.js";

/** Ce que les routes des salles d'utilisateurs empruntent au serveur. */
export interface UserRoomsContext {
  /** Dossier racine des salles (`<DATA_DIR>/rooms`), partagé par toutes les personnes de l'installation. */
  root: string;
  whoIs: (req: FastifyRequest) => { userId: number; workspaceId: number };
  userName: (userId: number) => Promise<string>;
  fail: (reply: FastifyReply, err: unknown, code?: number) => unknown;
  /** Dossier des salles livrées (remplaçable dans les tests). */
  shippedDir?: string;
  /** Réglages et configuration de la personne servie (résolus à chaque requête), pour l'agent générateur. */
  deps: { config: Config; settings: SettingsStore };
  /** Exécuteur d'agent imposé (tests). Absent : celui des réglages de la personne. */
  runner?: AgentRunner | undefined;
}

/** Plafond de salles générées par personne et par heure (chaque génération peut coûter plusieurs essais). */
export const DRAFTS_PER_HOUR = 12;

interface RoomView {
  room: Room;
  owner: { id: number; name: string };
  visibility: Visibility;
  mine: boolean;
  updatedAt: string;
}

/**
 * Routes des salles que les personnes créent : les voir (les leurs et celles que l'équipe partage), en garder une, changer qui la voit, la supprimer.
 * Une salle est privée par défaut. Tout ce qui est reçu est revalidé par `validateRoom` ; l'auteur, l'identifiant et les portes sont imposés par le stockage.
 * @param app Serveur.
 * @param ctx Dépendances du serveur.
 */
export function registerUserRooms(app: FastifyInstance, ctx: UserRoomsContext): void {
  const limiter = createLimiter();
  const storeFor = (req: FastifyRequest) => {
    const who = ctx.whoIs(req);
    return { store: createRoomStore(ctx.root, who.workspaceId), userId: who.userId };
  };
  const failRoom = (reply: FastifyReply, err: unknown) => {
    if (err instanceof RoomStoreError) return reply.code(err.status).send({ error: err.message, errors: err.errors });
    return ctx.fail(reply, err);
  };
  const body = (req: FastifyRequest): Record<string, unknown> => (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {});
  const visibilityOf = (value: unknown): Visibility | undefined => (value === undefined ? undefined : (value as Visibility));

  /**
   * Fait créer une salle (et son jeu) par un agent sans outil, à partir de la description de la personne. Rien n'est gardé : la proposition est
   * contrôlée par le code (forme, jouabilité, recherche automatique d'une victoire), puis la personne la visite avant de la garder.
   */
  app.post("/api/rooms/draft", async (req, reply) => {
    try {
      const idea = cleanIdea(body(req).idea);
      limiter.take(`${ctx.whoIs(req).userId}:room-draft`, DRAFTS_PER_HOUR, "salles générées");
      const settings = await ctx.deps.settings.get();
      const systemPrompt = await loadSystemPrompt("rooms", { override: "", instructions: "", project: null, extra: [roomCatalogPrompt(), await roomExamplePrompt()].filter(Boolean) });
      const engine = { ...agentRunConfig(settings.review), maxTurns: 3, timeoutMs: 4 * 60_000 };
      const runner = ctx.runner ?? createRunner(ctx.deps.config, settings);
      const out = await draftRoom({ idea, systemPrompt, engine, runner });
      log.info("rooms.draft", { attempts: out.attempts, solved: out.solved, costUsd: out.costUsd });
      return { room: out.room, notes: out.notes, attempts: out.attempts, solved: out.solved, warnings: out.warnings, costUsd: out.costUsd };
    } catch (err) {
      if (err instanceof ScribeInputError) return reply.code(400).send({ error: err.message });
      if (err instanceof ScribeLimitError) return reply.code(429).send({ error: err.message });
      if (err instanceof RoomDraftError) return reply.code(502).send({ error: err.message, errors: err.problems });
      return ctx.fail(reply, err);
    }
  });

  /** Les salles que cette personne peut visiter, avec leur auteur. */
  app.get("/api/user-rooms", async (req, reply) => {
    try {
      const { store, userId } = storeFor(req);
      const stored = await store.list(userId);
      const names = new Map<number, string>();
      for (const s of stored) if (!names.has(s.meta.ownerId)) names.set(s.meta.ownerId, await ctx.userName(s.meta.ownerId));
      const rooms: RoomView[] = stored.map((s) => ({ room: s.room, owner: { id: s.meta.ownerId, name: names.get(s.meta.ownerId) ?? "" }, visibility: s.meta.visibility, mine: s.meta.ownerId === userId, updatedAt: s.meta.updatedAt }));
      return { rooms, mine: await store.count(userId), max: MAX_ROOMS_PER_USER };
    } catch (err) {
      return failRoom(reply, err);
    }
  });

  /** Garde une salle (nouvelle, ou une mise à jour avec `id`). Privée par défaut. */
  app.post("/api/user-rooms", async (req, reply) => {
    try {
      const { store, userId } = storeFor(req);
      const b = body(req);
      const shipped = new Set((await loadRooms(ctx.shippedDir ?? ROOMS_DIR)).rooms.map((r) => r.id));
      const options: { visibility?: Visibility; id?: string } = {};
      const visibility = visibilityOf(b.visibility);
      if (visibility !== undefined) options.visibility = visibility;
      if (typeof b.id === "string") options.id = b.id;
      const saved = await store.save(userId, b.room, options, shipped);
      return { id: saved.room.id, room: saved.room, visibility: saved.meta.visibility };
    } catch (err) {
      return failRoom(reply, err);
    }
  });

  /** Change qui voit la salle : seul son auteur le peut. */
  app.post<{ Params: { id: string } }>("/api/user-rooms/:id/visibility", async (req, reply) => {
    try {
      const { store, userId } = storeFor(req);
      const saved = await store.setVisibility(userId, req.params.id, body(req).visibility as Visibility);
      return { id: saved.room.id, visibility: saved.meta.visibility };
    } catch (err) {
      return failRoom(reply, err);
    }
  });

  /** Supprime une salle : seul son auteur le peut. */
  app.post<{ Params: { id: string } }>("/api/user-rooms/:id/delete", async (req, reply) => {
    try {
      const { store, userId } = storeFor(req);
      await store.remove(userId, req.params.id);
      return { ok: true };
    } catch (err) {
      return failRoom(reply, err);
    }
  });
}
