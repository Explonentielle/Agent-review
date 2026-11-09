import pg from "pg";
import type { Db, Sql } from "./db.js";

export const POSTGRES_SQL: Sql = {
  name: "postgres",
  now: "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')",
  pk: "SERIAL PRIMARY KEY",
  real: "DOUBLE PRECISION",
  nowDefault: "DEFAULT (to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS'))",
};

/**
 * Ce que l'adaptateur attend d'un client PostgreSQL : `pg` (production) et PGlite (tests, un vrai
 * PostgreSQL compilé en WebAssembly) en fournissent chacun une version via ces deux fonctions de liaison.
 */
export interface PgConn {
  query(query: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[]; changes: number }>;
  exec(statements: string): Promise<void>;
  transaction<T>(fn: (conn: PgConn) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** `?` devient `$1`, `$2`... (le SQL du projet n'a jamais de point d'interrogation dans une chaîne). */
export function toNumberedParams(query: string): string {
  let n = 0;
  return query.replace(/\?/g, () => `$${++n}`);
}

class PostgresDb implements Db {
  readonly sql = POSTGRES_SQL;

  constructor(private readonly conn: PgConn) {}

  async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    return (await this.conn.query(toNumberedParams(query), params)).rows as T[];
  }

  async get<T>(query: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.all<T>(query, params))[0];
  }

  async run(query: string, params: unknown[] = []): Promise<{ changes: number }> {
    return { changes: (await this.conn.query(toNumberedParams(query), params)).changes };
  }

  exec(statements: string): Promise<void> {
    return this.conn.exec(statements);
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.conn.transaction((c) => fn(new PostgresDb(c)));
  }

  async schemaVersion(): Promise<number> {
    await this.conn.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    const row = await this.get<{ version: number }>("SELECT version FROM schema_migrations WHERE id = 1");
    return row?.version ?? 0;
  }

  async setSchemaVersion(version: number): Promise<void> {
    await this.run("INSERT INTO schema_migrations (id, version) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET version = excluded.version", [version]);
  }

  close(): Promise<void> {
    return this.conn.close();
  }
}

// --- Liaison avec `pg` (production) ---------------------------------------------------

type PgQueryable = Pick<pg.Pool | pg.PoolClient, "query">;

function fromPgQueryable(q: PgQueryable, ops: { transaction: PgConn["transaction"]; close: PgConn["close"] }): PgConn {
  return {
    async query(query, params) {
      const res = await q.query(query, params as unknown[]);
      return { rows: res.rows as Record<string, unknown>[], changes: res.rowCount ?? 0 };
    },
    async exec(statements) {
      await q.query(statements);
    },
    transaction: ops.transaction,
    close: ops.close,
  };
}

function fromPgClient(client: pg.PoolClient): PgConn {
  return fromPgQueryable(client, {
    transaction: () => Promise.reject(new Error("Transaction imbriquée non prise en charge")),
    close: async () => undefined,
  });
}

/** Se connecte à PostgreSQL (URL postgres://utilisateur:motdepasse@hote:5432/base). */
export async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  await pool.query("SELECT 1"); // échoue tout de suite si l'adresse ou les identifiants sont faux

  const conn: PgConn = fromPgQueryable(pool, {
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(fromPgClient(client));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
  return new PostgresDb(conn);
}

// --- Liaison avec PGlite (tests) ---------------------------------------------------------

/** Sous-ensemble de PGlite utilisé ici (déclaré à la main pour ne pas dépendre de PGlite en production). */
export interface PgliteLike {
  query(query: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(statements: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function fromPglite(db: PgliteLike): PgConn {
  return {
    async query(query, params) {
      const res = await db.query(query, params);
      return { rows: res.rows as Record<string, unknown>[], changes: res.affectedRows ?? 0 };
    },
    async exec(statements) {
      await db.exec(statements);
    },
    transaction: (fn) => db.transaction((tx) => fn(fromPglite(tx))),
    close: () => db.close(),
  };
}

/** Base PostgreSQL embarquée (PGlite), pour tester le moteur PostgreSQL sans serveur. */
export function postgresFromPglite(db: PgliteLike): Db {
  return new PostgresDb(fromPglite(db));
}
