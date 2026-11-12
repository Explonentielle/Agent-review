import { spawn } from "node:child_process";
import type { AgentSettings } from "../settings/schema.js";

/** Paramètres d'exécution d'un agent (réglages du dashboard). */
export interface AgentRunConfig {
  model: AgentSettings["model"];
  effort: AgentSettings["effort"];
  maxTurns: number;
  timeoutMs: number;
}

export function agentRunConfig(s: AgentSettings): AgentRunConfig {
  return { model: s.model, effort: s.effort, maxTurns: s.maxTurns, timeoutMs: s.timeoutMin * 60_000 };
}

/** Variables du processus de l'outil que l'agent reçoit : de quoi lancer des commandes et joindre le réseau, rien de plus. */
const AGENT_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "NO_COLOR", "TZ", "TMPDIR", "TMP", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
]);
const AGENT_ENV_PREFIXES = ["LC_", "XDG_", "CLAUDE_", "ANTHROPIC_"];
/** Un nom qui ressemble à un secret n'est jamais transmis, même sous un préfixe autorisé... */
const SECRET_LOOKING = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
/** ... sauf la connexion à l'abonnement de l'utilisateur, dont la CLI a besoin. */
const AGENT_ENV_SECRETS_ALLOWED = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * Environnement de la CLI, filtré : seules les variables utiles à une commande passent (liste ci-dessus). Les jetons de forge, la clé maître des
 * secrets, l'adresse de la base et les secrets OAuth du `.env` n'y sont donc jamais : une commande lancée par l'agent (tests d'un projet,
 * script d'un dépôt piégé) qui affiche son environnement ne les voit pas. Ce n'est pas une isolation : un processus du même utilisateur peut
 * lire l'environnement du processus parent (`/proc`). Seuls des conteneurs par personne (lot D) l'empêchent.
 * Sans `apiKey` (mode abonnement), toute clé présente dans le shell est écartée : elle passerait devant le login d'abonnement et ferait
 * facturer l'API sans que tu l'aies demandé. Avec `apiKey` (mode clé API, choisi dans les réglages), seule cette clé est transmise.
 * Un jeton d'authentification de session (ANTHROPIC_AUTH_TOKEN) n'est jamais transmis.
 * @param apiKey Clé API Anthropic du mode « clé API », ou absente en mode abonnement.
 * @returns L'environnement du processus de l'agent.
 */
export function claudeEnv(apiKey?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const allowed = AGENT_ENV_NAMES.has(name) || AGENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (allowed && (!SECRET_LOOKING.test(name) || AGENT_ENV_SECRETS_ALLOWED.has(name))) env[name] = value;
  }
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class ProcessCancelledError extends Error {
  constructor() {
    super("Annulé");
    this.name = "ProcessCancelledError";
  }
}

/**
 * Lance un process, lui passe `stdin`, et notifie chaque ligne de stdout au fil de l'eau.
 * @param bin Programme à lancer.
 * @param args Arguments du programme.
 * @param stdin Texte écrit sur l'entrée du programme, puis fermée. Un programme qui se termine sans le lire n'est pas une erreur ici.
 * @param opts Dossier courant, environnement, délai maximum, notification des lignes de sortie et signal d'annulation.
 * @returns Sortie standard, sortie d'erreur et code de sortie.
 * @throws ProcessCancelledError Si la tâche est annulée.
 * @throws Error Si le programme ne peut pas être lancé ou dépasse le délai maximum.
 */
export function runProcess(
  bin: string,
  args: string[],
  stdin: string,
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    onStdoutLine?: (line: string) => void;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ProcessCancelledError());

    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    // SIGINT laisse Claude Code terminer proprement le tour en cours
    const onAbort = () => {
      cancelled = true;
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!opts.onStdoutLine) return;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) opts.onStdoutLine(line);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const finish = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      finish();
      reject(new Error(`Impossible de lancer Claude Code (${bin}) : ${err.message}`));
    });
    child.on("close", (exitCode) => {
      finish();
      if (pending.trim() && opts.onStdoutLine) opts.onStdoutLine(pending);
      if (cancelled) reject(new ProcessCancelledError());
      else if (timedOut) reject(new Error(`Agent interrompu après ${Math.round(opts.timeoutMs / 60_000)} min (délai maximum réglé dans les Paramètres)`));
      else resolve({ stdout, stderr, exitCode });
    });

    // Un programme qui se termine sans lire son entrée (docker qui échoue tout de suite) fait échouer l'écriture : l'échec se lit dans son code et son stderr
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}
