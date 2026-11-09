import { claudeEnv } from "../claude/process.js";
import type { Config } from "../config.js";
import type { Settings } from "../settings/schema.js";
import { CliRunner } from "./cliRunner.js";
import type { AgentRunner } from "./runner.js";

export { CliRunner, buildCliArgs, maskSecrets } from "./cliRunner.js";
export { ALWAYS_DENIED_TOOLS, type AgentEventKind, type AgentRequest, type AgentResult, type AgentRunner } from "./runner.js";

/**
 * Choisit l'exécuteur d'agent d'après les réglages (Paramètres > Modèles > Connexion à Claude) :
 * - `subscription` : la CLI Claude Code sur l'abonnement de l'utilisateur, toute clé du shell est écartée ;
 * - `api` : la même CLI, avec la clé ANTHROPIC_API_KEY du .env (facturation à l'usage). Mêmes outils,
 *   mêmes permissions, mêmes protections d'isolation : seule l'authentification change.
 */
export function createRunner(config: Config, settings: Settings): AgentRunner {
  if (settings.agentAuth === "api") {
    const key = config.anthropicApiKey;
    if (!key) throw new Error("Le mode « clé API » est activé dans les Paramètres, mais ANTHROPIC_API_KEY est absente du .env.");
    return new CliRunner(config.claudeBin, () => claudeEnv(key), [key]);
  }
  return new CliRunner(config.claudeBin);
}
