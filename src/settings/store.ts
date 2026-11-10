import type { ForgeKind } from "../connectors/types.js";
import type { Db } from "../db/db.js";
import { log } from "../logger.js";
import { DEFAULT_SETTINGS, ProjectSettingsSchema, SettingsSchema, type ProjectSettings, type Settings } from "./schema.js";

export type SettingsStore = ReturnType<typeof createSettingsStore>;

/**
 * Fusionne les réglages stockés avec les valeurs par défaut, section par section :
 * un réglage ajouté dans une version ultérieure prend sa valeur par défaut sans casser l'existant.
 */
export function mergeWithDefaults(stored: unknown): Settings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const section = <K extends keyof Settings>(key: K): Settings[K] => {
    const def = DEFAULT_SETTINGS[key];
    const val = s[key];
    if (def && typeof def === "object" && !Array.isArray(def)) {
      return { ...def, ...(val && typeof val === "object" ? val : {}) } as Settings[K];
    }
    return (val ?? def) as Settings[K];
  };

  const merged = {
    actionMode: section("actionMode"),
    agentAuth: section("agentAuth"),
    budget: section("budget"),
    review: section("review"),
    dev: section("dev"),
    rules: section("rules"),
    workflow: section("workflow"),
    instructions: section("instructions"),
    systemPrompts: section("systemPrompts"),
    templates: section("templates"),
  };
  const parsed = SettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  log.warn("settings.invalid_stored", { error: parsed.error.message });
  return DEFAULT_SETTINGS;
}

export function createSettingsStore(db: Db) {
  return {
    async get(): Promise<Settings> {
      const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'");
      return mergeWithDefaults(row ? JSON.parse(row.value) : null);
    },

    /** Valide puis enregistre. Lève une erreur lisible si invalide. */
    async save(input: unknown): Promise<Settings> {
      const settings = SettingsSchema.parse(input);
      await db.run("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(settings)]);
      return settings;
    },

    async listProjects(): Promise<ProjectSettings[]> {
      const rows = await db.all<{ config: string }>("SELECT config FROM projects ORDER BY path");
      return rows.map((r) => ProjectSettingsSchema.parse(JSON.parse(r.config)));
    },

    async getProject(source: ForgeKind, projectId: number): Promise<ProjectSettings | null> {
      const row = await db.get<{ config: string }>("SELECT config FROM projects WHERE source = ? AND project_id = ?", [source, projectId]);
      return row ? ProjectSettingsSchema.parse({ ...JSON.parse(row.config), source }) : null;
    },

    async saveProject(input: unknown): Promise<ProjectSettings> {
      const project = ProjectSettingsSchema.parse(input);
      if (project.devEnabled && (!project.baseBranch || !project.targetBranch)) {
        throw new Error("Branche de départ et branche cible obligatoires pour activer l'agent dev");
      }
      await db.run(
        `INSERT INTO projects (source, project_id, path, config) VALUES (?, ?, ?, ?)
         ON CONFLICT (source, project_id) DO UPDATE SET path = excluded.path, config = excluded.config`,
        [project.source, project.projectId, project.path, JSON.stringify(project)],
      );
      return project;
    },

    async deleteProject(source: ForgeKind, projectId: number): Promise<void> {
      await db.run("DELETE FROM projects WHERE source = ? AND project_id = ?", [source, projectId]);
    },
  };
}

/** Compile les regex de chemins sensibles en ignorant (et signalant) celles qui sont invalides. */
export function compileRules(settings: Settings): { maxChangedLinesAuto: number; sensitivePathPatterns: RegExp[] } {
  const patterns: RegExp[] = [];
  for (const p of settings.rules.sensitivePaths) {
    try {
      patterns.push(new RegExp(p, "i"));
    } catch {
      log.warn("settings.invalid_regex", { pattern: p });
    }
  }
  return { maxChangedLinesAuto: settings.rules.maxChangedLinesAuto, sensitivePathPatterns: patterns };
}
