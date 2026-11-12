import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Launcher } from "./cliRunner.js";
import type { AgentRequest } from "./runner.js";

/**
 * Utilisateur du conteneur d'agent :
 * - `host` : l'UID/GID de l'outil (Docker classique : les fichiers écrits appartiennent à l'outil) ;
 * - `root` : root du conteneur (Docker sans root : il correspond à l'utilisateur de l'outil sur l'hôte, alors que l'UID 1000 du conteneur
 *   serait un sous-UID qui ne peut pas écrire dans le dossier de travail) ;
 * - `auto` : `root` si le démon Docker est sans root, `host` sinon.
 */
export type ContainerUser = "auto" | "host" | "root";

/** Réglages de l'exécution des agents dans des conteneurs jetables (variables AGENT_* du `.env`). */
export interface DockerRuntime {
  /** Image qui contient la CLI Claude Code et les outils du projet (git, interpréteurs, gestionnaires de paquets). */
  image: string;
  /** Mémoire maximale d'un agent, au format Docker (ex. `1536m`). Le swap est interdit au-delà. */
  memory: string;
  /** Processeurs maximum d'un agent. */
  cpus: number;
  /** Nombre maximum de processus d'un agent (arrête une bombe de processus). */
  pids: number;
  /** Réseau Docker de l'agent, ou null pour le réseau par défaut. */
  network: string | null;
  /** Commande `docker` (ou un chemin). */
  dockerBin: string;
  /** Utilisateur du conteneur (voir `ContainerUser`). */
  containerUser: ContainerUser;
}

/** Dossier de travail de l'agent dans le conteneur. */
const WORKDIR = "/work";
/** Dossier personnel de l'agent dans le conteneur : mémoire vive seulement, perdu à la fin de la tâche. */
const AGENT_HOME = "/home/agent";

/**
 * Environnement du client `docker` (pas celui de l'agent) : de quoi joindre le démon et la clé API, que `docker run -e ANTHROPIC_API_KEY`
 * transmet au conteneur sans qu'elle apparaisse dans les arguments (visibles de tous par `ps`). Rien d'autre du processus de l'outil.
 * @param apiKey Clé API Anthropic de la tâche.
 * @returns L'environnement du client docker.
 */
export function dockerClientEnv(apiKey: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

/**
 * Arguments de `docker run` pour une tâche d'agent. Le conteneur est jetable et sans privilèges : système de fichiers en lecture seule,
 * aucune capacité Linux, pas d'élévation de droits, mémoire/processeurs/processus plafonnés, utilisateur sans droits. Il ne voit QUE le dossier
 * de travail de la tâche (monté sur /work) : ni la base, ni la clé maître, ni les autres dépôts ou personnes, ni l'environnement de l'outil.
 * @param runtime Réglages de l'exécution en conteneur.
 * @param req Tâche de l'agent (dossier de travail).
 * @param name Nom du conteneur, pour pouvoir l'arrêter.
 * @param cliArgs Arguments du programme lancé (par défaut ceux de la CLI Claude Code).
 * @param user Utilisateur du conteneur `uid:gid` : celui du processus de l'outil (Docker classique) ou `0:0` (Docker sans root), voir `resolveContainerUser`.
 * @param program Programme lancé dans le conteneur : la CLI Claude Code, sauf pour le diagnostic des conteneurs (`sh`).
 * @returns Les arguments de `docker`.
 * @throws Error Si le dossier de travail n'est pas un chemin absolu sûr.
 */
export function buildDockerArgs(
  runtime: DockerRuntime,
  req: Pick<AgentRequest, "cwd">,
  name: string,
  cliArgs: string[],
  user: string,
  program = "claude",
): string[] {
  // `--mount` sépare ses options par des virgules : un chemin qui en contient pourrait ajouter une option (monter autre chose)
  if (!path.isAbsolute(req.cwd) || /[,\n\r]/.test(req.cwd)) throw new Error(`Dossier de travail invalide pour le conteneur de l'agent : ${req.cwd}`);
  return [
    "run", "--rm", "-i",
    "--name", name,
    "--pull", "never", // l'image doit déjà exister : aucun téléchargement implicite au lancement d'une tâche
    "--read-only",
    "--tmpfs", "/tmp:rw,size=256m,mode=1777",
    "--tmpfs", `${AGENT_HOME}:rw,size=256m,uid=${user.split(":")[0]},gid=${user.split(":")[1]},mode=700`,
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--memory", runtime.memory,
    "--memory-swap", runtime.memory,
    "--cpus", String(runtime.cpus),
    "--pids-limit", String(runtime.pids),
    "--user", user,
    ...(runtime.network ? ["--network", runtime.network] : []),
    "--mount", `type=bind,src=${req.cwd},dst=${WORKDIR}`,
    "--workdir", WORKDIR,
    "-e", `HOME=${AGENT_HOME}`,
    "-e", "ANTHROPIC_API_KEY", // sans valeur : prise dans l'environnement du client docker
    runtime.image,
    program,
    ...cliArgs,
  ];
}

/**
 * Supprime un conteneur d'agent resté en vie (client docker tué, délai dépassé). Sans effet s'il n'existe plus ; n'échoue jamais.
 * @param dockerBin Commande `docker`.
 * @param name Nom du conteneur.
 * @returns Rien.
 */
export function removeContainer(dockerBin: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(dockerBin, ["rm", "-f", name], { env: dockerClientEnv(null), timeout: 20_000 }, () => resolve());
  });
}

/** Démons Docker déjà interrogés (clé : commande + cible du client) et leur mode. Seules les réponses réussies sont mémorisées. */
const rootlessByDaemon = new Map<string, boolean>();

/**
 * Interroge le démon Docker (`docker info`) : sa version et s'il tourne sans root (l'option de sécurité `rootless` est alors listée).
 * @param dockerBin Commande `docker`.
 * @returns La version du démon (« inconnue » si absente) et `rootless` à vrai si le démon est sans root.
 * @throws Error Si Docker ne répond pas (démon arrêté, commande introuvable).
 */
export async function readDockerInfo(dockerBin: string): Promise<{ version: string; rootless: boolean }> {
  const raw = await new Promise<string>((resolve, reject) => {
    execFile(dockerBin, ["info", "--format", "{{.ServerVersion}}|{{.SecurityOptions}}"], { env: dockerClientEnv(null), timeout: 20_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Impossible d'interroger Docker (${dockerBin} info) : ${(stderr.trim() || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
  const sep = raw.indexOf("|");
  return { version: (sep > 0 ? raw.slice(0, sep) : "").trim() || "inconnue", rootless: raw.includes("name=rootless") };
}

/**
 * Indique si le démon Docker tourne sans root. Le résultat est mémorisé par démon, sauf en cas d'échec.
 * @param dockerBin Commande `docker`.
 * @returns `true` si le démon est sans root.
 * @throws Error Si Docker ne répond pas (démon arrêté, commande introuvable).
 */
async function isRootlessDocker(dockerBin: string): Promise<boolean> {
  const key = `${dockerBin}|${process.env.DOCKER_HOST ?? ""}|${process.env.DOCKER_CONTEXT ?? ""}`;
  const known = rootlessByDaemon.get(key);
  if (known !== undefined) return known;
  const { rootless } = await readDockerInfo(dockerBin);
  rootlessByDaemon.set(key, rootless);
  return rootless;
}

/**
 * Utilisateur `uid:gid` du conteneur d'agent. Avec Docker sans root, l'utilisateur de l'outil est root DANS le conteneur : c'est la seule
 * correspondance qui lui permet d'écrire dans le dossier de travail (l'UID 1000 du conteneur serait un sous-UID de l'hôte). Sans danger,
 * car root du conteneur n'a alors aucun droit sur l'hôte et toutes ses capacités sont retirées.
 * @param setting Choix de l'utilisateur du conteneur (`AGENT_CONTAINER_USER`).
 * @param rootless Vrai si le démon Docker tourne sans root (ignoré quand le choix est explicite).
 * @returns `0:0` (Docker sans root) ou l'UID/GID du processus de l'outil.
 */
export function containerUserFor(setting: ContainerUser, rootless: boolean): string {
  return setting === "root" || (setting === "auto" && rootless) ? "0:0" : `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

/**
 * Utilisateur `uid:gid` du conteneur d'agent d'après le réglage, en interrogeant Docker seulement en mode `auto`.
 * @param runtime Réglages de l'exécution en conteneur.
 * @returns `0:0` (Docker sans root) ou l'UID/GID du processus de l'outil, voir `containerUserFor`.
 * @throws Error Si le mode est `auto` et que Docker ne répond pas.
 */
export async function resolveContainerUser(runtime: DockerRuntime): Promise<string> {
  const rootless = runtime.containerUser === "auto" ? await isRootlessDocker(runtime.dockerBin) : false;
  return containerUserFor(runtime.containerUser, rootless);
}

/**
 * Lanceur qui exécute la CLI Claude Code dans un conteneur jetable au lieu de la machine hôte (voir `buildDockerArgs`).
 * Réservé au mode clé API : l'abonnement de l'utilisateur vit dans son dossier personnel, qu'on ne monte pas dans un conteneur.
 * @param runtime Réglages de l'exécution en conteneur.
 * @param apiKey Clé API Anthropic transmise au conteneur par l'environnement du client docker.
 * @returns Le lanceur à donner à `CliRunner`.
 */
export function dockerLauncher(runtime: DockerRuntime, apiKey: string): Launcher {
  return async (req, cliArgs) => {
    const user = await resolveContainerUser(runtime);
    const name = `ra-agent-${randomBytes(6).toString("hex")}`;
    return {
      bin: runtime.dockerBin,
      args: buildDockerArgs(runtime, req, name, cliArgs, user),
      env: dockerClientEnv(apiKey),
      cleanup: () => removeContainer(runtime.dockerBin, name),
    };
  };
}
