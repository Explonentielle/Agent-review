import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ClaudeStatusProbe } from "../claude/status.js";
import { TERMINAL_COLS, TERMINAL_ROWS } from "./launch.js";
import { TerminalError, type TerminalHub, type TerminalLaunch } from "./session.js";

/** Ce que le serveur reçoit pour offrir le terminal Claude. */
export interface TerminalFeature {
  hub: TerminalHub;
  /** Prépare le lancement de la CLI ; lève TerminalError si le système ne le permet pas. */
  launch: () => Promise<TerminalLaunch>;
  /** État de la connexion de la CLI. */
  status: ClaudeStatusProbe;
}

export interface TerminalRouteOptions {
  feature: TerminalFeature;
  /** Vrai si la connexion par compte est configurée (sinon, l'outil sert un seul utilisateur local). */
  authEnabled: boolean;
  /** Qui fait la requête (espace et utilisateur) : sa session, ou l'utilisateur local sans connexion. */
  whoIs: (req: FastifyRequest) => { workspaceId: number; userId: number };
  /** Utilisateur propriétaire de l'installation : seul à pouvoir ouvrir le terminal. */
  ownerUserId: number;
  /** Convertit une erreur en réponse. */
  fail: (reply: FastifyReply, err: unknown, code?: number) => FastifyReply;
}

/** En-têtes qu'un reverse proxy ajoute : leur présence dit que la requête ne vient pas du tunnel local. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"];

const KEEPALIVE_MS = 15_000;

/**
 * Routes du terminal Claude et de l'état de la connexion Claude. Réservées au propriétaire de l'installation : la CLI tourne avec la
 * session Claude de la machine, qui n'est pas celle d'une autre personne. Sans connexion par compte, elles sont aussi refusées dès que la
 * requête passe par un reverse proxy (un terminal ne doit jamais être ouvert à Internet sans authentification).
 * @param app Serveur.
 * @param options Terminal, identité, et gestion des erreurs.
 * @returns Rien.
 */
export function registerTerminal(app: FastifyInstance, options: TerminalRouteOptions): void {
  const { feature, fail } = options;
  const keyOf = (req: FastifyRequest): string => {
    const who = options.whoIs(req);
    return `${who.workspaceId}:${who.userId}`;
  };

  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!options.authEnabled && PROXY_HEADERS.some((name) => req.headers[name] !== undefined)) {
      return void reply.code(403).send({ error: "Le terminal est refusé derrière un reverse proxy tant que la connexion par compte n'est pas configurée (variables AUTH_* du .env)." });
    }
    if (options.whoIs(req).userId !== options.ownerUserId) {
      return void reply.code(403).send({ error: "Le terminal est réservé au propriétaire de l'installation." });
    }
  };
  const route = { preHandler: guard };

  app.get<{ Querystring: { force?: string } }>("/api/claude/status", route, async (req) => {
    const status = await feature.status.get(req.query.force === "1");
    return { installed: status.installed, connected: status.connected, detail: status.detail, checkedAt: status.checkedAt };
  });

  app.get("/api/terminal", route, async (req) => {
    let available = true;
    let reason = "";
    try {
      await feature.launch();
    } catch (err) {
      available = false;
      reason = err instanceof Error ? err.message : String(err);
    }
    const session = feature.hub.get(keyOf(req));
    return { available, reason, active: session !== undefined, startedAt: session?.startedAt ?? null, cols: TERMINAL_COLS, rows: TERMINAL_ROWS };
  });

  app.post("/api/terminal/start", route, async (req, reply) => {
    try {
      const session = feature.hub.start(keyOf(req), await feature.launch());
      return { ok: true, id: session.id, cols: TERMINAL_COLS, rows: TERMINAL_ROWS };
    } catch (err) {
      return fail(reply, err, err instanceof TerminalError ? 400 : 500);
    }
  });

  app.post<{ Body: { data?: unknown } }>("/api/terminal/input", route, async (req, reply) => {
    try {
      const data = req.body?.data;
      if (typeof data !== "string") throw new TerminalError("Saisie manquante");
      const session = feature.hub.get(keyOf(req));
      if (!session) throw new TerminalError("Aucune session ouverte");
      session.write(data);
      return { ok: true };
    } catch (err) {
      return fail(reply, err, err instanceof TerminalError ? 400 : 500);
    }
  });

  app.post("/api/terminal/stop", route, async (req) => {
    const stopped = feature.hub.stop(keyOf(req));
    feature.status.forget();
    return { ok: true, stopped };
  });

  // Sortie en flux continu (Server-Sent Events) : chaque bloc d'octets est envoyé en base64, un caractère UTF-8 coupé entre deux blocs reste intact côté navigateur
  app.get("/api/terminal/stream", route, async (req, reply) => {
    const session = feature.hub.get(keyOf(req));
    if (!session) return reply.code(404).send({ error: "Aucune session ouverte" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders(); // Node garde les en-têtes jusqu'au premier octet : sans cela, un programme silencieux au départ laisserait le client en attente
    const send = (event: string, data: string) => res.write(`event: ${event}\ndata: ${data}\n\n`);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "data") return void send("data", event.data.toString("base64"));
      send("exit", String(event.code ?? ""));
      feature.status.forget();
      res.end();
    });
    const keepalive = setInterval(() => res.write(": ping\n\n"), KEEPALIVE_MS);
    req.raw.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
    return reply;
  });
}
