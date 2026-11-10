import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

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
  })
  .superRefine((e, ctx) => {
    const gitlab = { GITLAB_URL: e.GITLAB_URL, GITLAB_TOKEN: e.GITLAB_TOKEN, GITLAB_USERNAME: e.GITLAB_USERNAME };
    const present = Object.values(gitlab).filter(Boolean).length;
    if (present > 0 && present < 3) {
      for (const [name, value] of Object.entries(gitlab)) {
        if (!value) ctx.addIssue({ code: "custom", path: [name], message: `${name} manquant (GitLab demande GITLAB_URL, GITLAB_TOKEN et GITLAB_USERNAME ensemble)` });
      }
    }
    if (present === 0 && !e.GITHUB_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["GITLAB_TOKEN"], message: "aucune forge configurée : renseigne GITLAB_URL, GITLAB_TOKEN et GITLAB_USERNAME, et/ou GITHUB_TOKEN" });
    }
  });

export type ActionMode = "shadow" | "comment" | "auto";

export interface Config {
  /** Null si GitLab n'est pas configuré. */
  gitlab: { url: string; token: string; username: string } | null;
  /** Null si GitHub n'est pas configuré. `apiUrl` : https://api.github.com sauf GitHub Enterprise. */
  github: { apiUrl: string; token: string } | null;
  /** Intervalle de détection des demandes de fusion à reviewer, pour chaque forge. */
  pollIntervalMs: number;
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

  return {
    gitlab: e.GITLAB_URL && e.GITLAB_TOKEN && e.GITLAB_USERNAME ? { url: e.GITLAB_URL, token: e.GITLAB_TOKEN, username: e.GITLAB_USERNAME } : null,
    github: e.GITHUB_TOKEN ? { apiUrl: e.GITHUB_API_URL, token: e.GITHUB_TOKEN } : null,
    pollIntervalMs: e.POLL_INTERVAL_SEC * 1000,
    claudeBin: e.CLAUDE_BIN ?? defaultClaudeBin(),
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    server: { host: e.HOST, port: e.PORT },
    dataDir: path.resolve(e.DATA_DIR),
    databaseUrl: e.DATABASE_URL ?? null,
    planio: e.PLANIO_URL && e.PLANIO_API_KEY ? { url: e.PLANIO_URL.replace(/\/+$/, ""), apiKey: e.PLANIO_API_KEY } : null,
  };
}
