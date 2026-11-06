import type { Db } from "../db/index.js";
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
    review: section("review"),
    dev: section("dev"),
    rules: section("rules"),
    workflow: section("workflow"),
    templates: section("templates"),
  };
  const parsed = SettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  log.warn("settings.invalid_stored", { error: parsed.error.message });
  return DEFAULT_SETTINGS;
}

export function createSettingsStore(db: Db) {
  return {
    get(): Settings {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
      return mergeWithDefaults(row ? JSON.parse(row.value) : null);
    },

    /** Valide puis enregistre. Lève une erreur lisible si invalide. */
    save(input: unknown): Settings {
      const settings = SettingsSchema.parse(input);
      db.prepare(
        "INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(JSON.stringify(settings));
      return settings;
    },

    listProjects(): ProjectSettings[] {
      const rows = db.prepare("SELECT config FROM projects ORDER BY path").all() as unknown as Array<{ config: string }>;
      return rows.map((r) => ProjectSettingsSchema.parse(JSON.parse(r.config)));
    },

    getProject(projectId: number): ProjectSettings | null {
      const row = db.prepare("SELECT config FROM projects WHERE project_id = ?").get(projectId) as { config: string } | undefined;
      return row ? ProjectSettingsSchema.parse(JSON.parse(row.config)) : null;
    },

    saveProject(input: unknown): ProjectSettings {
      const project = ProjectSettingsSchema.parse(input);
      if (project.devEnabled && (!project.baseBranch || !project.targetBranch)) {
        throw new Error("Branche de départ et branche cible obligatoires pour activer l'agent dev");
      }
      db.prepare(
        `INSERT INTO projects (project_id, path, config) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET path = excluded.path, config = excluded.config`,
      ).run(project.projectId, project.path, JSON.stringify(project));
      return project;
    },

    deleteProject(projectId: number): void {
      db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId);
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
