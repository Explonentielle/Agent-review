import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Db, Sql } from "./db.js";

export const SQLITE_SQL: Sql = {
  name: "sqlite",
  now: "datetime('now')",
  pk: "INTEGER PRIMARY KEY AUTOINCREMENT",
  real: "REAL",
  nowDefault: "DEFAULT (datetime('now'))",
};

const bind = (params: unknown[] = []) => params as SQLInputValue[];

/** SQLite via `node:sqlite` (synchrone) derrière l'interface asynchrone commune. */
class SqliteDb implements Db {
  readonly sql = SQLITE_SQL;

  constructor(private readonly db: DatabaseSync) {}

  async all<T>(query: string, params?: unknown[]): Promise<T[]> {
    return this.db.prepare(query).all(...bind(params)) as unknown as T[];
  }

  async get<T>(query: string, params?: unknown[]): Promise<T | undefined> {
    return this.db.prepare(query).get(...bind(params)) as unknown as T | undefined;
  }

  async run(query: string, params?: unknown[]): Promise<{ changes: number }> {
    const res = this.db.prepare(query).run(...bind(params));
    return { changes: Number(res.changes) };
  }

  async exec(statements: string): Promise<void> {
    this.db.exec(statements);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async schemaVersion(): Promise<number> {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  async setSchemaVersion(version: number): Promise<void> {
    if (!Number.isInteger(version) || version < 0) throw new Error(`Version de schéma invalide : ${version}`);
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Ouvre (ou crée) une base SQLite. `":memory:"` pour une base en mémoire (tests). */
export function openSqlite(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return new SqliteDb(db);
}
