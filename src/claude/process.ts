import { spawn } from "node:child_process";
import type { AgentSettings } from "../settings/schema.js";

/** Paramètres d'exécution d'un agent (réglages du dashboard + chemin de la CLI). */
export interface AgentRunConfig {
  claudeBin: string;
  model: AgentSettings["model"];
  effort: AgentSettings["effort"];
  maxTurns: number;
  timeoutMs: number;
}

export function agentRunConfig(claudeBin: string, s: AgentSettings): AgentRunConfig {
  return { claudeBin, model: s.model, effort: s.effort, maxTurns: s.maxTurns, timeoutMs: s.timeoutMin * 60_000 };
}

/**
 * Environnement de la CLI : une clé API présente dans le shell passerait devant le login
 * d'abonnement, on l'écarte pour que ce soit toujours l'abonnement qui serve.
 */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
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

/** Lance un process, lui passe `stdin`, et notifie chaque ligne de stdout au fil de l'eau. */
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

    child.stdin.end(stdin);
  });
}
