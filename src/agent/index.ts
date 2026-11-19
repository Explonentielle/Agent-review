import { claudeEnv } from "../claude/process.js";
import type { Config } from "../config.js";
import type { ProjectSettings, Settings } from "../settings/schema.js";
import { CliRunner } from "./cliRunner.js";
import { dockerLauncher } from "./dockerRunner.js";
import { imageFor } from "./imageName.js";
import type { AgentRunner } from "./runner.js";

export { CliRunner, buildCliArgs, maskSecrets } from "./cliRunner.js";
export { ALWAYS_DENIED_TOOLS, type AgentEventKind, type AgentRequest, type AgentResult, type AgentRunner } from "./runner.js";

/**
 * Choisit l'exécuteur d'agent d'après les réglages (Paramètres > Modèles > Connexion à Claude) :
 * - `subscription` : la CLI Claude Code sur l'abonnement de la personne, toute clé du shell est écartée ;
 * - `api` : la même CLI, avec la clé API Anthropic de la personne (facturation à l'usage). Mêmes outils,
 *   mêmes permissions, mêmes protections d'isolation : seule l'authentification change.
 * Avec AGENT_RUNTIME=docker, l'agent tourne dans un conteneur jetable qui ne voit que son dossier de travail. Il reçoit seulement les identifiants
 * de la personne : sa clé API, ou en mode abonnement son jeton d'abonnement (`claude setup-token`), jamais le dossier personnel de la machine.
 * Sans ce jeton, la tâche est refusée plutôt que de retomber en silence sur la machine, ce qui défairait l'isolation demandée.
 * En mode conteneur, l'image est celle du projet s'il en a choisi une (parmi les images autorisées du .env), sinon l'image par défaut.
 * @param config Configuration de la personne (exécution des agents, clé API, jeton d'abonnement).
 * @param settings Réglages de la personne (mode de connexion à Claude).
 * @param project Réglages du projet de la tâche (son image d'agent), ou null s'il n'est pas configuré.
 * @returns L'exécuteur d'agent.
 * @throws Error Si la clé API ou, en conteneur, le jeton d'abonnement manque, ou si l'image du projet n'est pas autorisée.
 */
export function createRunner(config: Config, settings: Settings, project: Pick<ProjectSettings, "agentImage"> | null = null): AgentRunner {
  const runtime = config.agentRuntime;
  if (settings.agentAuth === "api") {
    const key = config.anthropicApiKey;
    if (!key) throw new Error("Le mode « clé API » est activé dans les Paramètres, mais aucune clé API Anthropic n'est définie (Paramètres > Connexion, ou ANTHROPIC_API_KEY du .env).");
    const launcher = runtime.mode === "docker" ? dockerLauncher({ ...runtime, image: imageFor(runtime, project?.agentImage) }, { apiKey: key }) : undefined;
    return new CliRunner(config.claudeBin, () => claudeEnv(key), [key], launcher);
  }
  if (runtime.mode === "docker") {
    const token = config.claudeOauthToken;
    if (!token) {
      throw new Error("Le mode « abonnement » en conteneur demande ton jeton d'abonnement : lance « claude setup-token » sur ton poste, puis colle le jeton dans Paramètres > Connexion.");
    }
    return new CliRunner(config.claudeBin, undefined, [token], dockerLauncher({ ...runtime, image: imageFor(runtime, project?.agentImage) }, { oauthToken: token }));
  }
  return new CliRunner(config.claudeBin);
}
