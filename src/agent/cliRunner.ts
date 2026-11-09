import { ProcessCancelledError, claudeEnv, runProcess } from "../claude/process.js";
import { describeMessage } from "./events.js";
import { ALWAYS_DENIED_TOOLS, type AgentRequest, type AgentResult, type AgentRunner } from "./runner.js";

/** Message du flux de la CLI (`--output-format json` ou `stream-json`). */
interface CliMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
}

/**
 * Arguments de la CLI. Les protections qui isolent l'agent du dépôt qu'il lit sont écrites ici et
 * non dans la requête, pour qu'aucun appelant ne puisse les retirer :
 * - `--safe-mode` coupe CLAUDE.md, hooks, plugins, skills et MCP du dépôt (sans lui, une MR piégée
 *   pourrait exécuter des commandes via `.claude/settings.json`) ;
 * - `--strict-mcp-config` sans configuration MCP = aucun serveur MCP ;
 * - `dontAsk` et aucune invite : tout ce qui n'est pas autorisé explicitement est refusé.
 */
export function buildCliArgs(req: AgentRequest): string[] {
  const denied = [...new Set([...ALWAYS_DENIED_TOOLS, ...req.disallowedTools])];
  return [
    "-p",
    "--output-format", req.stream ? "stream-json" : "json",
    ...(req.stream ? ["--verbose"] : []),
    "--json-schema", JSON.stringify(req.outputSchema),
    "--model", req.model,
    "--effort", req.effort,
    "--max-turns", String(req.maxTurns),
    "--append-system-prompt", req.systemPrompt,
    "--tools", req.tools.join(","),
    // Une règle par argument : une virgule dans une règle (ex. une commande) ne la casse pas
    "--allowedTools", ...req.allowedTools,
    "--disallowedTools", ...denied,
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--safe-mode",
    "--strict-mcp-config",
    ...(req.persistSession ? [] : ["--no-session-persistence"]),
  ];
}

/** Remplace chaque secret par un repère : une clé ne doit apparaître ni dans une erreur, ni dans le journal. */
export function maskSecrets(text: string, secrets: string[]): string {
  return secrets.reduce((out, s) => (s ? out.replaceAll(s, "[clé masquée]") : out), text);
}

/**
 * Exécute l'agent avec la CLI Claude Code (`claude -p`). L'authentification dépend de
 * l'environnement fourni : abonnement de l'utilisateur (`claudeEnv()`), ou clé API (`claudeEnv(clé)`).
 * Les `secrets` (la clé API) sont masqués dans les erreurs et dans le journal.
 */
export class CliRunner implements AgentRunner {
  constructor(
    private readonly bin: string,
    private readonly env: () => NodeJS.ProcessEnv = claudeEnv,
    private readonly secrets: string[] = [],
  ) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    try {
      return await this.execute(req);
    } catch (err) {
      if (err instanceof ProcessCancelledError || !(err instanceof Error) || this.secrets.length === 0) throw err;
      throw new Error(maskSecrets(err.message, this.secrets));
    }
  }

  private async execute(rawReq: AgentRequest): Promise<AgentResult> {
    const req: AgentRequest = this.secrets.length
      ? { ...rawReq, onEvent: rawReq.onEvent && ((kind, text) => rawReq.onEvent?.(kind, maskSecrets(text, this.secrets))) }
      : rawReq;
    let final: CliMessage | null = null;
    let sessionId: string | null = null;

    const onStdoutLine = req.stream
      ? (line: string) => {
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line) as Record<string, unknown>;
          } catch {
            return;
          }
          if (typeof msg.session_id === "string" && msg.session_id !== sessionId) {
            sessionId = msg.session_id;
            req.onSession?.(sessionId);
          }
          if (msg.type === "result") final = msg as CliMessage;
          if (req.onEvent) for (const ev of describeMessage(msg, req.cwd)) req.onEvent(ev.kind, ev.text);
        }
      : undefined;

    const { stdout, stderr, exitCode } = await runProcess(this.bin, buildCliArgs(req), req.prompt, {
      cwd: req.cwd,
      env: this.env(),
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onStdoutLine,
    });

    const payload = req.stream ? final : parseCliOutput(stdout);
    if (!payload) {
      throw new Error(
        req.stream
          ? "Claude Code s'est arrêté sans résultat final"
          : `Sortie de Claude Code illisible (code ${exitCode}) : ${(stderr || stdout).slice(0, 800)}`,
      );
    }
    if (payload.is_error || payload.subtype !== "success" || payload.structured_output == null) {
      throw new Error(`Claude Code a échoué (${payload.subtype ?? "inconnu"}) : ${String(payload.result ?? stderr).slice(0, 800)}`);
    }

    return {
      structured: payload.structured_output,
      sessionId: sessionId ?? payload.session_id ?? null,
      costUsd: typeof payload.total_cost_usd === "number" ? payload.total_cost_usd : null,
      numTurns: typeof payload.num_turns === "number" ? payload.num_turns : null,
    };
  }
}

/** Objet résultat unique ; tolère aussi un tableau d'événements (mode verbose). */
function parseCliOutput(stdout: string): CliMessage | null {
  try {
    const data = JSON.parse(stdout) as CliMessage | CliMessage[];
    if (Array.isArray(data)) return data.findLast((m) => m.type === "result") ?? null;
    return data;
  } catch {
    return null;
  }
}
