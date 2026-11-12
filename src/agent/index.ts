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
 * - `subscription` : la CLI Claude Code sur l'abonnement de l'utilisateur, toute clé du shell est écartée ;
 * - `api` : la même CLI, avec la clé ANTHROPIC_API_KEY du .env (facturation à l'usage). Mêmes outils,
 *   mêmes permissions, mêmes protections d'isolation : seule l'authentification change.
 * Avec AGENT_RUNTIME=docker, l'agent tourne dans un conteneur jetable qui ne voit que son dossier de travail. Cela exige le mode clé API :
 * l'abonnement vit dans le dossier personnel de l'utilisateur, qu'on ne monte pas dans un conteneur. Le mode abonnement est alors refusé
 * plutôt que de retomber en silence sur la machine, ce qui défairait l'isolation demandée.
 * En mode conteneur, l'image est celle du projet s'il en a choisi une (parmi les images autorisées du .env), sinon l'image par défaut.
 * @param config Configuration de la machine (exécution des agents, clé API).
 * @param settings Réglages de la personne (mode de connexion à Claude).
 * @param project Réglages du projet de la tâche (son image d'agent), ou null s'il n'est pas configuré.
 * @returns L'exécuteur d'agent.
 * @throws Error Si le mode ne convient pas à l'exécution choisie, si la clé API manque, ou si l'image du projet n'est pas autorisée.
 */
export function createRunner(config: Config, settings: Settings, project: Pick<ProjectSettings, "agentImage"> | null = null): AgentRunner {
  if (settings.agentAuth === "api") {
    const key = config.anthropicApiKey;
    if (!key) throw new Error("Le mode « clé API » est activé dans les Paramètres, mais ANTHROPIC_API_KEY est absente du .env.");
    const runtime = config.agentRuntime;
    const launcher = runtime.mode === "docker" ? dockerLauncher({ ...runtime, image: imageFor(runtime, project?.agentImage) }, key) : undefined;
    return new CliRunner(config.claudeBin, () => claudeEnv(key), [key], launcher);
  }
  if (config.agentRuntime.mode === "docker") {
    throw new Error("AGENT_RUNTIME=docker exige le mode « clé API » (Paramètres > Modèles) : l'abonnement ne peut pas être monté dans un conteneur.");
  }
  return new CliRunner(config.claudeBin);
}
