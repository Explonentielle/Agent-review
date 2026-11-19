import { execFile } from "node:child_process";

/** État de la connexion de la CLI Claude Code (abonnement ou clé), tel que la CLI le dit elle-même. */
export interface ClaudeStatus {
  /** Faux si la CLI `claude` est introuvable sur la machine. */
  installed: boolean;
  /** Vrai si `claude auth status` répond que la CLI est connectée. */
  connected: boolean;
  /** Texte court de la CLI (compte, mode de connexion), sans séquences de couleur. */
  detail: string;
  /** Instant du contrôle (ms depuis 1970). */
  checkedAt: number;
}

export interface StatusRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Vrai si le programme n'existe pas. */
  missing: boolean;
}

/** Lance la CLI pour lire son état. Remplaçable dans les tests. */
export type StatusRunner = (bin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<StatusRunResult>;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_DETAIL = 300;

const runWithExecFile: StatusRunner = (bin, args, env) =>
  new Promise((resolve) => {
    execFile(bin, args, { env, timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", missing: true });
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), missing: false });
    });
  });

/**
 * Sonde de l'état de connexion de Claude, avec une mémoire courte : le dashboard l'interroge souvent, la CLI ne doit pas être relancée à chaque fois.
 * @param bin Programme `claude`.
 * @param env Fournit l'environnement de la CLI (filtré : jamais les secrets de l'outil).
 * @param run Lanceur de la CLI (réel par défaut).
 * @param ttlMs Durée pendant laquelle un résultat sert encore.
 * @param now Horloge (ms).
 * @returns `get` : l'état courant, `force` pour ignorer la mémoire.
 */
export function createClaudeStatusProbe(bin: string, env: () => NodeJS.ProcessEnv, run: StatusRunner = runWithExecFile, ttlMs = 30_000, now: () => number = Date.now) {
  let cached: ClaudeStatus | null = null;
  let pending: Promise<ClaudeStatus> | null = null;

  const check = async (): Promise<ClaudeStatus> => {
    const result = await run(bin, ["auth", "status", "--text"], env());
    const text = `${result.stdout}\n${result.stderr}`.replace(ANSI, "").trim().replace(/\s+/g, " ").slice(0, MAX_DETAIL);
    const status: ClaudeStatus = { installed: !result.missing, connected: !result.missing && result.code === 0, detail: result.missing ? "" : text, checkedAt: now() };
    cached = status;
    return status;
  };

  return {
    async get(force = false): Promise<ClaudeStatus> {
      if (!force && cached && now() - cached.checkedAt < ttlMs) return cached;
      pending ??= check().finally(() => {
        pending = null;
      });
      return pending;
    },
    /** Oublie le dernier résultat (après une session de terminal, la connexion a pu changer). */
    forget(): void {
      cached = null;
    },
  };
}

export type ClaudeStatusProbe = ReturnType<typeof createClaudeStatusProbe>;

/**
 * Sonde d'état pour les agents en conteneur : la CLI n'est pas lancée sur la machine, la connexion est celle du jeton d'abonnement transmis aux
 * conteneurs. L'état se déduit de la présence du jeton, sans lancer de processus : il n'est pas vérifié auprès d'Anthropic.
 * @param hasToken Dit si un jeton d'abonnement est défini pour la personne (relu à chaque appel : il peut changer dans le dashboard).
 * @param now Horloge (ms).
 * @returns Une sonde de même forme que celle de `createClaudeStatusProbe`.
 */
export function createDeclaredStatusProbe(hasToken: () => boolean, now: () => number = Date.now): ClaudeStatusProbe {
  return {
    async get(): Promise<ClaudeStatus> {
      const connected = hasToken();
      const detail = connected
        ? "Jeton d'abonnement défini, transmis aux conteneurs des agents (non vérifié auprès d'Anthropic)."
        : "Aucun jeton d'abonnement : lance « claude setup-token » sur ton poste, puis colle le jeton dans Paramètres > Connexion.";
      return { installed: true, connected, detail, checkedAt: now() };
    },
    forget: () => undefined,
  };
}
