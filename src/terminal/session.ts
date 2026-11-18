import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { randomUUID } from "node:crypto";

/** Programme du terminal : jamais un shell, seulement la CLI `claude` (voir launch.ts). */
export interface TerminalLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface TerminalLimits {
  /** Une session sans saisie depuis ce délai est fermée. */
  idleMs: number;
  /** Durée de vie maximale d'une session. */
  maxMs: number;
  /** Sortie gardée pour qui se rattache en cours de route (octets). */
  backlogBytes: number;
  /** Taille maximale d'une saisie envoyée d'un coup. */
  maxInputChars: number;
}

export const DEFAULT_TERMINAL_LIMITS: TerminalLimits = { idleMs: 15 * 60_000, maxMs: 60 * 60_000, backlogBytes: 256 * 1024, maxInputChars: 4096 };

export type TerminalEvent = { type: "data"; data: Buffer } | { type: "exit"; code: number | null };

/** Erreur attendue du terminal (session absente, saisie trop longue, système non pris en charge) : répondue en 400. */
export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalError";
  }
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/**
 * Une session de terminal : un programme dont on lit la sortie en continu et à qui on envoie des touches.
 * La sortie récente est gardée pour qui se rattache (rechargement de la page). Elle se ferme seule après inactivité ou à l'échéance maximale.
 */
export class TerminalSession {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly listeners = new Set<(event: TerminalEvent) => void>();
  private backlog: Buffer[] = [];
  private backlogSize = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly maxTimer: NodeJS.Timeout;
  private exitCode: number | null = null;
  private ended = false;

  constructor(
    launch: TerminalLaunch,
    private readonly limits: TerminalLimits = DEFAULT_TERMINAL_LIMITS,
    spawnFn: SpawnFn = spawn as SpawnFn,
  ) {
    // Groupe de processus à part (hors Windows) : l'arrêt emporte aussi ce que la CLI a lancé
    this.child = spawnFn(launch.file, launch.args, { cwd: launch.cwd, env: launch.env, detached: process.platform !== "win32", windowsHide: true });
    this.child.stdout.on("data", (chunk: Buffer) => this.push(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.push(chunk));
    this.child.stdin.on("error", () => undefined);
    this.child.on("error", (err) => {
      this.push(Buffer.from(`\r\nImpossible de lancer le terminal : ${err.message}\r\n`));
      this.finish(null);
    });
    this.child.on("close", (code) => this.finish(code));
    this.maxTimer = setTimeout(() => this.stop(), limits.maxMs);
    this.maxTimer.unref();
    this.touch();
  }

  get alive(): boolean {
    return !this.ended;
  }

  /**
   * S'abonne à la sortie. La sortie déjà produite est envoyée tout de suite, d'un bloc.
   * @param listener Appelé pour chaque bloc de sortie, puis à la fin de la session.
   * @returns La fonction qui annule l'abonnement.
   */
  subscribe(listener: (event: TerminalEvent) => void): () => void {
    if (this.backlogSize > 0) listener({ type: "data", data: Buffer.concat(this.backlog) });
    if (this.ended) {
      listener({ type: "exit", code: this.exitCode });
      return () => undefined;
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Envoie des touches au programme.
   * @param data Texte saisi (touches, collage).
   * @throws TerminalError Si la session est terminée ou la saisie trop longue.
   */
  write(data: string): void {
    if (this.ended) throw new TerminalError("La session est terminée");
    if (data.length > this.limits.maxInputChars) throw new TerminalError(`Saisie trop longue (${this.limits.maxInputChars} caractères au plus)`);
    this.touch();
    this.child.stdin.write(data);
  }

  /** Arrête le programme (SIGTERM, puis SIGKILL s'il résiste). */
  stop(): void {
    if (this.ended) return;
    this.signal("SIGTERM");
    setTimeout(() => {
      if (!this.ended) this.signal("SIGKILL");
    }, 3000).unref();
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      /* déjà terminé */
    }
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.limits.idleMs);
    this.idleTimer.unref();
  }

  private push(chunk: Buffer): void {
    this.backlog.push(chunk);
    this.backlogSize += chunk.length;
    // Borné à l'octet près : on retire les plus vieux blocs, puis le début du premier bloc restant (un gros bloc ne dépasse pas la limite à lui seul)
    while (this.backlogSize > this.limits.backlogBytes && this.backlog.length > 0) {
      const excess = this.backlogSize - this.limits.backlogBytes;
      const oldest = this.backlog[0]!;
      if (oldest.length <= excess) {
        this.backlog.shift();
        this.backlogSize -= oldest.length;
      } else {
        this.backlog[0] = oldest.subarray(excess);
        this.backlogSize -= excess;
      }
    }
    for (const listener of this.listeners) listener({ type: "data", data: chunk });
  }

  private finish(code: number | null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    clearTimeout(this.idleTimer);
    clearTimeout(this.maxTimer);
    for (const listener of this.listeners) listener({ type: "exit", code });
    this.listeners.clear();
  }
}

/** Les sessions ouvertes, une par personne : en ouvrir une nouvelle ferme la précédente. */
export class TerminalHub {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly limits: TerminalLimits = DEFAULT_TERMINAL_LIMITS,
    private readonly spawnFn?: SpawnFn,
  ) {}

  /** Session ouverte de cette personne, ou undefined. */
  get(key: string): TerminalSession | undefined {
    const session = this.sessions.get(key);
    if (session && !session.alive) {
      this.sessions.delete(key);
      return undefined;
    }
    return session;
  }

  /**
   * Ouvre une session pour cette personne (la précédente est arrêtée).
   * @param key Personne (espace et utilisateur).
   * @param launch Programme à lancer.
   * @returns La session ouverte.
   */
  start(key: string, launch: TerminalLaunch): TerminalSession {
    this.sessions.get(key)?.stop();
    const session = new TerminalSession(launch, this.limits, this.spawnFn);
    this.sessions.set(key, session);
    return session;
  }

  /** Arrête la session de cette personne. @returns Vrai s'il y en avait une. */
  stop(key: string): boolean {
    const session = this.get(key);
    session?.stop();
    this.sessions.delete(key); // plus proposée tout de suite, même si le processus met un instant à mourir
    return session !== undefined;
  }

  /** Arrête toutes les sessions (arrêt de l'outil). */
  stopAll(): void {
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
  }
}
