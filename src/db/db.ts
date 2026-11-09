/**
 * Accès à la base de données, indépendant du moteur : SQLite pour l'outil local (rien à installer),
 * PostgreSQL pour le serveur. Les dépôts de données (`reviews.ts`, `devTasks.ts`...) n'écrivent que du
 * SQL commun aux deux moteurs, avec des paramètres `?`, et utilisent `db.sql` pour ce qui diffère.
 */

export type DbDialect = "sqlite" | "postgres";

/** Fragments SQL qui diffèrent d'un moteur à l'autre. */
export interface Sql {
  name: DbDialect;
  /** Horodatage courant au format texte AAAA-MM-JJ HH:MM:SS (UTC), le même dans les deux moteurs. */
  now: string;
  /** Clé primaire entière auto-incrémentée (DDL). */
  pk: string;
  /** Flottant double précision (DDL). */
  real: string;
  /** Clause `DEFAULT (...)` d'un horodatage texte (DDL). */
  nowDefault: string;
}

export interface Db {
  readonly sql: Sql;

  /** Toutes les lignes. Écrire `AS nom_en_snake_case` pour les alias : PostgreSQL passe les identifiants en minuscules. */
  all<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T | undefined>;
  /** Exécute une écriture ; `changes` = nombre de lignes touchées. Pour récupérer un id, utiliser `get` avec `RETURNING id`. */
  run(query: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Plusieurs instructions sans paramètres (migrations). */
  exec(statements: string): Promise<void>;
  /**
   * Transaction. Sur SQLite il n'y a qu'une connexion : toute requête lancée pendant la transaction y
   * participe. À réserver aux migrations, qui tournent au démarrage avant toute autre requête.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  schemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;
  close(): Promise<void>;
}
