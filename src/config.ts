import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { IMAGE_NAME_RE } from "./agent/imageName.js";

/**
 * Configuration de la machine, lue dans le .env : secrets et chemins uniquement.
 * Tout le reste (modèles, labels, conventions, projets, mode d'action) se règle dans
 * le dashboard (page Paramètres) et vit en base : voir src/settings/.
 */
/** Une variable laissée vide dans le .env (`GITHUB_TOKEN=`) vaut « non renseignée ». */
const blankIsMissing = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const EnvSchema = z
  .object({
    // GitLab : les trois variables ensemble, ou aucune
    GITLAB_URL: z.preprocess(blankIsMissing, z.string().url().transform((u) => u.replace(/\/+$/, "")).optional()),
    GITLAB_TOKEN: z.preprocess(blankIsMissing, z.string().min(1).optional()),
    GITLAB_USERNAME: z.preprocess(blankIsMissing, z.string().min(1).optional()),
    // GitHub : jeton à portée fine (fine-grained), limité aux dépôts choisis. L'adresse de l'API ne change que pour GitHub Enterprise.
    GITHUB_TOKEN: z.preprocess(blankIsMissing, z.string().trim().min(1).optional()),
    GITHUB_API_URL: z.preprocess(blankIsMissing, z.string().url().default("https://api.github.com")),
    POLL_INTERVAL_SEC: z.coerce.number().int().min(30).default(90),
    /** Nombre maximum de reviews, et de tâches de dev, qui tournent en même temps sur la machine, toutes personnes confondues. */
    MAX_CONCURRENT_AGENTS: z.coerce.number().int().min(1).max(8).default(1),
    /** Où tournent les agents : sur la machine (host), ou dans un conteneur jetable par tâche (docker, mode clé API seulement). */
    AGENT_RUNTIME: z.preprocess(blankIsMissing, z.enum(["host", "docker"]).default("host")),
    /** Image des conteneurs d'agents : doit contenir la CLI Claude Code et les outils du projet. */
    AGENT_IMAGE: z.preprocess(blankIsMissing, z.string().trim().regex(IMAGE_NAME_RE, "nom d'image invalide").default("review-agent-sandbox:local")),
    /** Autres images que les projets peuvent choisir (Paramètres > Projets), séparées par des virgules ou des espaces. */
    AGENT_IMAGES: z.preprocess(
      blankIsMissing,
      z.string().transform((s) => s.split(/[\s,]+/).filter(Boolean)).pipe(z.array(z.string().regex(IMAGE_NAME_RE, "nom d'image invalide")).max(50)).optional(),
    ),
    AGENT_MEMORY: z.preprocess(blankIsMissing, z.string().regex(/^\d+[bkmg]$/i, "ex. 1536m ou 2g").default("1536m")),
    AGENT_CPUS: z.coerce.number().min(0.25).max(16).default(1),
    AGENT_PIDS: z.coerce.number().int().min(16).max(4096).default(256),
    /** Réseau Docker des conteneurs d'agents (par défaut : le réseau par défaut de Docker). */
    AGENT_NETWORK: z.preprocess(blankIsMissing, z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/).optional()),
    DOCKER_BIN: z.preprocess(blankIsMissing, z.string().min(1).default("docker")),
    /** Utilisateur du conteneur d'agent : auto (détecte Docker sans root), host (UID de l'outil) ou root (Docker sans root). */
    AGENT_CONTAINER_USER: z.preprocess(blankIsMissing, z.enum(["auto", "host", "root"]).default("auto")),

    CLAUDE_BIN: z.string().optional(),
    /** Seulement utilisée si le mode « clé API » est choisi dans les réglages. Jamais affichée ni journalisée. */
    ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),

    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().default(4321),
    DATA_DIR: z.string().default("./data"),
    /** Base PostgreSQL du mode serveur (postgres://utilisateur:motdepasse@hote:5432/base). Absente : SQLite local dans DATA_DIR. */
    DATABASE_URL: z.string().url().optional(),

    PLANIO_URL: z.string().url().optional(),
    PLANIO_API_KEY: z.string().optional(),

    /** Clé maître qui chiffre les secrets enregistrés dans l'outil (32 octets en base64). Absente : fichier `master.key` dans DATA_DIR, en local seulement. */
    SECRETS_MASTER_KEY: z.preprocess(blankIsMissing, z.string().trim().optional()),
    /** Anciennes clés maîtres, séparées par des virgules : elles déchiffrent encore pendant une rotation. */
    SECRETS_MASTER_KEY_PREVIOUS: z.preprocess(blankIsMissing, z.string().optional()),

    /** Adresse publique de l'outil, celle que voit le navigateur (URL de retour OAuth). Par défaut http://localhost:PORT. */
    PUBLIC_URL: z.preprocess(blankIsMissing, z.string().url().transform((u) => u.replace(/\/+$/, "")).optional()),
    /** Connexion par compte GitLab (application OAuth créée sur GITLAB_URL) : les deux ensemble, ou aucun. */
    AUTH_GITLAB_CLIENT_ID: z.preprocess(blankIsMissing, z.string().trim().optional()),
    AUTH_GITLAB_CLIENT_SECRET: z.preprocess(blankIsMissing, z.string().trim().optional()),
    /** Connexion par compte GitHub (application OAuth de github.com) : les deux ensemble, ou aucun. */
    AUTH_GITHUB_CLIENT_ID: z.preprocess(blankIsMissing, z.string().trim().optional()),
    AUTH_GITHUB_CLIENT_SECRET: z.preprocess(blankIsMissing, z.string().trim().optional()),
    /** Propriétaire de l'installation, au format `forge:identifiant` (ex. gitlab:alex) : il reprend le compte local et ses données. Obligatoire dès qu'une connexion est configurée. */
    AUTH_OWNER: z.preprocess(blankIsMissing, z.string().trim().optional()),
    /** Autres personnes autorisées à se connecter, `forge:identifiant` séparés par des virgules. */
    AUTH_ALLOWED_USERS: z.preprocess(blankIsMissing, z.string().optional()),
    /** Durée d'une session de connexion, en jours. */
    SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  })
  .superRefine((e, ctx) => {
    const identity = /^(gitlab|github):[A-Za-z0-9._-]+$/i;
    const pair = (provider: "GITLAB" | "GITHUB") => {
      const id = e[`AUTH_${provider}_CLIENT_ID`];
      const secret = e[`AUTH_${provider}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({ code: "custom", path: [`AUTH_${provider}_CLIENT_${id ? "SECRET" : "ID"}`], message: `AUTH_${provider}_CLIENT_ID et AUTH_${provider}_CLIENT_SECRET vont ensemble` });
      }
      return Boolean(id && secret);
    };
    const gitlabLogin = pair("GITLAB");
    const githubLogin = pair("GITHUB");
    if (gitlabLogin && !e.GITLAB_URL) ctx.addIssue({ code: "custom", path: ["GITLAB_URL"], message: "la connexion par GitLab demande GITLAB_URL" });
    if (gitlabLogin || githubLogin) {
      if (!e.AUTH_OWNER) {
        ctx.addIssue({ code: "custom", path: ["AUTH_OWNER"], message: "AUTH_OWNER est obligatoire quand une connexion est configurée (ex. gitlab:alex)" });
      } else if (!identity.test(e.AUTH_OWNER)) {
        ctx.addIssue({ code: "custom", path: ["AUTH_OWNER"], message: "AUTH_OWNER doit avoir la forme forge:identifiant (ex. gitlab:alex)" });
      } else if (!(e.AUTH_OWNER.toLowerCase().startsWith("gitlab:") ? gitlabLogin : githubLogin)) {
        ctx.addIssue({ code: "custom", path: ["AUTH_OWNER"], message: "AUTH_OWNER vise une forge dont la connexion n'est pas configurée" });
      }
      for (const entry of (e.AUTH_ALLOWED_USERS ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!identity.test(entry)) ctx.addIssue({ code: "custom", path: ["AUTH_ALLOWED_USERS"], message: `« ${entry} » doit avoir la forme forge:identifiant` });
      }
    }
    const gitlab = { GITLAB_URL: e.GITLAB_URL, GITLAB_TOKEN: e.GITLAB_TOKEN, GITLAB_USERNAME: e.GITLAB_USERNAME };
    // GITLAB_URL seule est permise (adresse de l'instance, jetons personnels saisis dans le dashboard) ; un jeton ou un nom d'utilisateur exige les trois
    const personal = Boolean(e.GITLAB_TOKEN || e.GITLAB_USERNAME);
    if (personal) {
      for (const [name, value] of Object.entries(gitlab)) {
        if (!value) ctx.addIssue({ code: "custom", path: [name], message: `${name} manquant (GitLab demande GITLAB_URL, GITLAB_TOKEN et GITLAB_USERNAME ensemble)` });
      }
    }
    if (!e.GITLAB_URL && !e.GITHUB_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["GITLAB_URL"], message: "aucune forge configurée : renseigne GITLAB_URL (jeton saisi ensuite dans le dashboard) et/ou GITHUB_TOKEN" });
    }
  });

export type ActionMode = "shadow" | "comment" | "auto";

/** Connexion par compte de forge (OAuth). Absente de la configuration : pas de connexion, l'outil sert l'utilisateur local. */
export interface AuthConfig {
  /** Adresse publique de l'outil, sans barre finale. */
  publicUrl: string;
  /** Null si la connexion par GitLab n'est pas configurée. */
  gitlab: { baseUrl: string; clientId: string; clientSecret: string } | null;
  /** Null si la connexion par GitHub n'est pas configurée. */
  github: { clientId: string; clientSecret: string } | null;
  /** Propriétaire de l'installation, `forge:identifiant` en minuscules. */
  owner: string;
  /** Autres personnes autorisées, `forge:identifiant` en minuscules. */
  allowedUsers: string[];
  /** Durée d'une session, en jours. */
  sessionDays: number;
}

export interface Config {
  /** Connexion par compte de forge, ou null (mode local sans connexion). */
  auth: AuthConfig | null;
  /** Null si GitLab n'est pas configuré. */
  gitlab: { url: string; token: string; username: string } | null;
  /** Adresse de l'instance GitLab (GITLAB_URL), même quand le jeton vient du coffre ou n'est pas renseigné. */
  gitlabUrl: string | null;
  /** Null si GitHub n'est pas configuré. `apiUrl` : https://api.github.com sauf GitHub Enterprise. */
  github: { apiUrl: string; token: string } | null;
  /** Adresse de l'API GitHub, même quand le jeton vient du coffre et non du .env (https://api.github.com sauf GitHub Enterprise). */
  githubApiUrl: string;
  /** Clés maîtres du coffre à secrets : la courante (ou null : fichier local) et les anciennes. */
  secrets: { masterKey: string | null; previousKeys: string[] };
  /** Intervalle de détection des demandes de fusion à reviewer, pour chaque forge. */
  pollIntervalMs: number;
  /** Nombre maximum de reviews, et de tâches de dev, simultanées sur la machine. */
  maxConcurrentAgents: number;
  /** Où et comment tournent les agents (sur la machine, ou dans des conteneurs jetables). */
  agentRuntime: { mode: "host" | "docker"; image: string; extraImages: string[]; memory: string; cpus: number; pids: number; network: string | null; dockerBin: string; containerUser: "auto" | "host" | "root" };
  claudeBin: string;
  /** Clé API Anthropic, ou null. Utilisée uniquement quand les réglages demandent le mode clé API. */
  anthropicApiKey: string | null;
  server: { host: string; port: number };
  dataDir: string;
  databaseUrl: string | null;
  planio: { url: string; apiKey: string } | null;
}

/** L'installeur natif met la CLI dans ~/.local/bin, qui n'est pas toujours dans le PATH. */
function defaultClaudeBin(): string {
  const local = path.join(homedir(), ".local", "bin", "claude");
  return existsSync(local) ? local : "claude";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuration invalide (.env) :\n${issues}`);
  }
  const e = parsed.data;

  const gitlabLogin = e.AUTH_GITLAB_CLIENT_ID && e.AUTH_GITLAB_CLIENT_SECRET && e.GITLAB_URL ? { baseUrl: e.GITLAB_URL, clientId: e.AUTH_GITLAB_CLIENT_ID, clientSecret: e.AUTH_GITLAB_CLIENT_SECRET } : null;
  const githubLogin = e.AUTH_GITHUB_CLIENT_ID && e.AUTH_GITHUB_CLIENT_SECRET ? { clientId: e.AUTH_GITHUB_CLIENT_ID, clientSecret: e.AUTH_GITHUB_CLIENT_SECRET } : null;

  return {
    auth:
      (gitlabLogin || githubLogin) && e.AUTH_OWNER
        ? {
            publicUrl: e.PUBLIC_URL ?? `http://localhost:${e.PORT}`,
            gitlab: gitlabLogin,
            github: githubLogin,
            owner: e.AUTH_OWNER.toLowerCase(),
            allowedUsers: (e.AUTH_ALLOWED_USERS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
            sessionDays: e.SESSION_DAYS,
          }
        : null,
    gitlabUrl: e.GITLAB_URL ?? null,
    gitlab: e.GITLAB_URL && e.GITLAB_TOKEN && e.GITLAB_USERNAME ? { url: e.GITLAB_URL, token: e.GITLAB_TOKEN, username: e.GITLAB_USERNAME } : null,
    github: e.GITHUB_TOKEN ? { apiUrl: e.GITHUB_API_URL, token: e.GITHUB_TOKEN } : null,
    githubApiUrl: e.GITHUB_API_URL,
    secrets: {
      masterKey: e.SECRETS_MASTER_KEY ?? null,
      previousKeys: (e.SECRETS_MASTER_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean),
    },
    pollIntervalMs: e.POLL_INTERVAL_SEC * 1000,
    maxConcurrentAgents: e.MAX_CONCURRENT_AGENTS,
    agentRuntime: { mode: e.AGENT_RUNTIME, image: e.AGENT_IMAGE, extraImages: e.AGENT_IMAGES ?? [], memory: e.AGENT_MEMORY, cpus: e.AGENT_CPUS, pids: e.AGENT_PIDS, network: e.AGENT_NETWORK ?? null, dockerBin: e.DOCKER_BIN, containerUser: e.AGENT_CONTAINER_USER },
    claudeBin: e.CLAUDE_BIN ?? defaultClaudeBin(),
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    server: { host: e.HOST, port: e.PORT },
    dataDir: path.resolve(e.DATA_DIR),
    databaseUrl: e.DATABASE_URL ?? null,
    planio: e.PLANIO_URL && e.PLANIO_API_KEY ? { url: e.PLANIO_URL.replace(/\/+$/, ""), apiKey: e.PLANIO_API_KEY } : null,
  };
}
