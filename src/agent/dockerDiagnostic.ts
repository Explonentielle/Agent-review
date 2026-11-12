import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { buildDockerArgs, containerUserFor, dockerClientEnv, readDockerInfo, removeContainer } from "./dockerRunner.js";

/** Un contrôle du diagnostic des conteneurs d'agents. */
export interface RuntimeCheck {
  /** Identifiant stable du contrôle. */
  id: "auth" | "docker" | "image" | "write" | "isolation" | "limits" | "claude";
  /** Ce qui est contrôlé, en quelques mots. */
  label: string;
  ok: boolean;
  /** Résultat en clair : ce qui a été constaté et, en cas d'échec, quoi faire. */
  detail: string;
}

/** Résultat du diagnostic : `ok` est vrai quand tous les contrôles passent (toujours vrai hors du mode conteneur, où rien n'est à contrôler). */
export interface RuntimeDiagnostic {
  mode: "host" | "docker";
  ok: boolean;
  checks: RuntimeCheck[];
}

/** Ce que le diagnostic doit savoir de la personne et de la machine. */
export interface RuntimeContext {
  /** Dossier de données : le conteneur d'essai y monte un dossier temporaire, comme pour un vrai dossier de travail. */
  dataDir: string;
  agentAuth: "subscription" | "api";
  /** Vrai si une clé API Anthropic est définie pour cette personne. */
  apiKeyConfigured: boolean;
}

/** Réponse d'une commande docker : jamais une exception, pour que chaque contrôle décrive lui-même l'échec. */
interface DockerOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Message d'erreur de lancement ou de délai dépassé, vide si la commande a réussi. */
  error: string;
}

/**
 * Script lancé dans le conteneur d'essai : une ligne `clé=valeur` par constat (écriture dans /work, racine en lecture seule, utilisateur,
 * plafonds de mémoire et de processus, capacités Linux, élévation de droits). Les fichiers de cgroup v2, avec repli sur la v1.
 */
const PROBE_SCRIPT = [
  "if touch /work/.ra-diagnostic 2>/dev/null && rm /work/.ra-diagnostic; then echo write=ok; else echo write=ko; fi",
  "if touch /usr/.ra-diagnostic 2>/dev/null; then rm -f /usr/.ra-diagnostic; echo root=ko; else echo root=ok; fi",
  "echo user=$(id -u):$(id -g)",
  "echo mem=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)",
  "echo pids=$(cat /sys/fs/cgroup/pids.max 2>/dev/null || cat /sys/fs/cgroup/pids/pids.max 2>/dev/null)",
  "echo caps=$(grep CapEff /proc/self/status | cut -f2)",
  "echo nnp=$(grep NoNewPrivs /proc/self/status | cut -f2)",
].join("\n");

/**
 * Lance une commande docker et rend sa sortie, sans jamais lever d'exception.
 * @param dockerBin Commande `docker`.
 * @param args Arguments de la commande.
 * @param timeoutMs Délai maximum avant d'arrêter la commande.
 * @returns La sortie de la commande et, en cas d'échec, la raison.
 */
function runDocker(dockerBin: string, args: string[], timeoutMs: number): Promise<DockerOutput> {
  return new Promise((resolve) => {
    const child = execFile(dockerBin, args, { env: dockerClientEnv(null), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err as { killed?: boolean }).killed);
      resolve({ ok: !err, stdout, stderr, error: err ? (timedOut ? `délai de ${Math.round(timeoutMs / 1000)} s dépassé` : err.message.slice(0, 300)) : "" });
    });
    child.stdin?.end(); // `docker run -i` : aucune entrée à attendre
  });
}

/**
 * Convertit une mémoire au format Docker en octets.
 * @param value Mémoire au format `AGENT_MEMORY` (ex. `1536m`, `2g`).
 * @returns Le nombre d'octets, ou `null` si le format n'est pas reconnu.
 */
function memoryBytes(value: string): number | null {
  const m = /^(\d+)([bkmg])$/i.exec(value);
  if (!m) return null;
  const unit = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "b" | "k" | "m" | "g"];
  return Number(m[1]) * unit;
}

/**
 * Lit les lignes `clé=valeur` écrites par le script d'essai.
 * @param stdout Sortie du script.
 * @returns Les constats par clé.
 */
function parseProbe(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Compare un plafond lu dans le conteneur à celui demandé.
 * @param label Ressource contrôlée (« mémoire », « processus »).
 * @param read Valeur lue dans le cgroup du conteneur (`max` ou vide quand Docker n'a pas appliqué le plafond).
 * @param expected Plafond demandé.
 * @param unit Unité, pour le message.
 * @returns `null` si le plafond est appliqué, sinon la description du problème.
 */
function limitFault(label: string, read: string | undefined, expected: number, unit: string): string | null {
  if (read === undefined || read === "" || read === "max") return `${label} : plafond ignoré par Docker (lu : ${read || "indisponible"}, attendu : ${expected} ${unit})`;
  if (Number(read) !== expected) return `${label} : lu ${read} ${unit}, attendu ${expected} ${unit}`;
  return null;
}

/**
 * Vérifie que les agents peuvent tourner en conteneur sur cette machine, avec les mêmes options qu'une vraie tâche : le mode de connexion,
 * Docker, l'image, puis un conteneur d'essai (écriture dans le dossier de travail, isolation, plafonds de ressources) et la CLI Claude Code.
 * Les contrôles qui dépendent d'un échec précédent (Docker injoignable, image absente) ne sont pas lancés. Hors du mode conteneur, rien n'est lancé.
 * @param runtime Réglages de l'exécution des agents (`AGENT_*`).
 * @param ctx Dossier de données, mode de connexion à Claude et présence de la clé API.
 * @returns Le résultat de chaque contrôle.
 */
export async function diagnoseAgentRuntime(runtime: Config["agentRuntime"], ctx: RuntimeContext): Promise<RuntimeDiagnostic> {
  if (runtime.mode !== "docker") return { mode: "host", ok: true, checks: [] };

  const checks: RuntimeCheck[] = [];
  const finish = (): RuntimeDiagnostic => ({ mode: "docker", ok: checks.every((c) => c.ok), checks });
  const add = (id: RuntimeCheck["id"], label: string, ok: boolean, detail: string) => void checks.push({ id, label, ok, detail });

  // 1. Connexion à Claude : l'abonnement ne se monte pas dans un conteneur
  if (ctx.agentAuth !== "api") {
    add("auth", "Mode clé API", false, "Les agents en conteneur exigent le mode « Clé API » (Paramètres > Modèles) : en mode abonnement, les tâches sont refusées.");
  } else if (!ctx.apiKeyConfigured) {
    add("auth", "Mode clé API", false, "Le mode clé API est actif, mais aucune clé Anthropic n'est définie (section Connexion ou ANTHROPIC_API_KEY).");
  } else {
    add("auth", "Mode clé API", true, "Mode clé API actif, clé définie.");
  }

  // 2. Docker répond, et en quel mode (classique ou sans root)
  let rootless: boolean;
  try {
    const info = await readDockerInfo(runtime.dockerBin);
    rootless = info.rootless;
    add("docker", "Docker", true, `Docker ${info.version}, ${rootless ? "sans root (rootless)" : "avec root (classique)"}.`);
  } catch (err) {
    add("docker", "Docker", false, `${err instanceof Error ? err.message : String(err)}. Le démon est-il démarré, et DOCKER_HOST / DOCKER_BIN sont-ils corrects ?`);
    return finish();
  }
  const user = containerUserFor(runtime.containerUser, rootless);

  // 3. L'image des agents existe déjà (jamais téléchargée au lancement d'une tâche)
  const image = await runDocker(runtime.dockerBin, ["image", "inspect", "--format", "{{.Id}}", runtime.image], 20_000);
  if (!image.ok) {
    add("image", "Image des agents", false, `Image « ${runtime.image} » introuvable sur ce Docker. Construis-la : docker build -f Dockerfile.agent -t ${runtime.image} . (voir docs/deploiement.md, section 11).`);
    return finish();
  }
  add("image", "Image des agents", true, `Image « ${runtime.image} » présente.`);

  // 4. Conteneur d'essai, lancé avec les options d'une vraie tâche, sur un dossier temporaire du dossier de données
  await mkdir(ctx.dataDir, { recursive: true });
  const dir = await mkdtemp(path.join(ctx.dataDir, "diagnostic-"));
  try {
    const run = async (program: string, args: string[], timeoutMs: number): Promise<DockerOutput> => {
      const name = `ra-diag-${randomBytes(6).toString("hex")}`;
      try {
        return await runDocker(runtime.dockerBin, buildDockerArgs(runtime, { cwd: dir }, name, args, user, program), timeoutMs);
      } finally {
        await removeContainer(runtime.dockerBin, name);
      }
    };

    const probe = await run("sh", ["-c", PROBE_SCRIPT], 60_000);
    if (!probe.ok) {
      const why = (probe.stderr || probe.error).trim().slice(0, 300);
      add("write", "Conteneur d'essai", false, `Le conteneur d'essai n'a pas pu démarrer avec les options des agents : ${why}`);
    } else {
      const p = parseProbe(probe.stdout);

      add("write", "Écriture dans le dossier de travail", p.write === "ok",
        p.write === "ok" ? `Le conteneur écrit dans son dossier de travail (utilisateur ${p.user}).`
          : `Le conteneur ne peut pas écrire dans son dossier de travail (utilisateur ${p.user}). Avec Docker sans root, il doit tourner en root du conteneur : AGENT_CONTAINER_USER=root.`);

      const isolationFaults = [
        p.root === "ok" ? null : "système de fichiers en écriture",
        /^0+$/.test(p.caps ?? "x") ? null : `capacités Linux conservées (${p.caps || "illisible"})`,
        p.nnp === "1" ? null : "élévation de droits possible",
      ].filter((f): f is string => f !== null);
      add("isolation", "Isolation du conteneur", isolationFaults.length === 0,
        isolationFaults.length === 0 ? "Système de fichiers en lecture seule, aucune capacité Linux, élévation de droits interdite." : `Isolation insuffisante : ${isolationFaults.join(", ")}.`);

      const memExpected = memoryBytes(runtime.memory);
      const limitFaults = [
        memExpected === null ? `mémoire : réglage « ${runtime.memory} » illisible` : limitFault("mémoire", p.mem, memExpected, "octets"),
        limitFault("processus", p.pids, runtime.pids, "processus"),
      ].filter((f): f is string => f !== null);
      add("limits", "Plafonds de ressources", limitFaults.length === 0,
        limitFaults.length === 0 ? `Mémoire plafonnée à ${runtime.memory}, ${runtime.pids} processus au plus : appliqués par Docker.`
          : `${limitFaults.join(" ; ")}. Avec Docker sans root, déléguer les cgroups à l'utilisateur (docs/deploiement.md, section 11, étape 2).`);
    }

    // 5. La CLI Claude Code est dans l'image et démarre
    const cli = await run("claude", ["--version"], 60_000);
    const version = cli.stdout.trim().split("\n")[0] ?? "";
    add("claude", "CLI Claude Code", cli.ok && version !== "",
      cli.ok && version !== "" ? `La CLI répond : ${version.slice(0, 100)}.`
        : `La CLI Claude Code est absente de l'image ou ne démarre pas : ${(cli.stderr || cli.error || "aucune réponse").trim().slice(0, 300)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return finish();
}
