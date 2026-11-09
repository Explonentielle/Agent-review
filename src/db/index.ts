import path from "node:path";
import type { Db } from "./db.js";
import { migrate } from "./migrations.js";
import { openPostgres } from "./postgres.js";
import { openSqlite } from "./sqlite.js";

export type { Db, DbDialect, Sql } from "./db.js";

export interface DbOptions {
  /** Dossier des données locales : contient la base SQLite quand aucune URL PostgreSQL n'est donnée. */
  dataDir: string;
  /** URL PostgreSQL (mode serveur). Absente : SQLite dans `dataDir` (outil local). */
  databaseUrl: string | null;
}

/** Ouvre la base choisie (SQLite local ou PostgreSQL) et applique les migrations manquantes. */
export async function openDb(options: DbOptions): Promise<Db> {
  const db = options.databaseUrl ? await openPostgres(options.databaseUrl) : openSqlite(path.join(options.dataDir, "review-agent.sqlite"));
  await migrate(db);
  return db;
}
