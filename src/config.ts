import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * Configuration de la machine, lue dans le .env : secrets et chemins uniquement.
 * Tout le reste (modèles, labels, conventions, projets, mode d'action) se règle dans
 * le dashboard (page Paramètres) et vit en base : voir src/settings/.
 */
const EnvSchema = z.object({
  GITLAB_URL: z.string().url().transform((u) => u.replace(/\/+$/, "")),
  GITLAB_TOKEN: z.string().min(1, "GITLAB_TOKEN manquant"),
  GITLAB_USERNAME: z.string().min(1, "GITLAB_USERNAME manquant"),
  POLL_INTERVAL_SEC: z.coerce.number().int().min(30).default(90),

  CLAUDE_BIN: z.string().optional(),

  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().default(4321),
  DATA_DIR: z.string().default("./data"),

  PLANIO_URL: z.string().url().optional(),
  PLANIO_API_KEY: z.string().optional(),
});

export type ActionMode = "shadow" | "comment" | "auto";

export interface Config {
  gitlab: { url: string; token: string; username: string; pollIntervalMs: number };
  claudeBin: string;
  server: { host: string; port: number };
  dataDir: string;
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
    gitlab: {
      url: e.GITLAB_URL,
      token: e.GITLAB_TOKEN,
      username: e.GITLAB_USERNAME,
      pollIntervalMs: e.POLL_INTERVAL_SEC * 1000,
    },
    claudeBin: e.CLAUDE_BIN ?? defaultClaudeBin(),
    server: { host: e.HOST, port: e.PORT },
    dataDir: path.resolve(e.DATA_DIR),
    planio: e.PLANIO_URL && e.PLANIO_API_KEY ? { url: e.PLANIO_URL.replace(/\/+$/, ""), apiKey: e.PLANIO_API_KEY } : null,
  };
}
