import type { Db } from "./db.js";
import { migrationsFor } from "./migrations.js";

/**
 * Tables copiées, dans l'ordre des clés étrangères (une table parente avant ses filles). Les sessions de connexion et les liens envoyés par email
 * (inscription, mot de passe oublié) ne sont pas copiés : ils se refont à la prochaine connexion ou demande.
 */
export const TRANSFER_TABLES = [
  "users",
  "credentials",
  "workspaces",
  "memberships",
  "identities",
  "invitations",
  "secrets",
  "settings",
  "projects",
  "reviews",
  "actions",
  "dev_tasks",
  "dev_task_events",
  "audit_log",
] as const;

/** Tables dont la clé primaire entière `id` est auto-incrémentée : leur compteur doit repartir après le plus grand identifiant copié. */
const TABLES_WITH_ID = ["users", "workspaces", "identities", "invitations", "secrets", "reviews", "actions", "dev_tasks", "dev_task_events", "audit_log"] as const;

/** Colonnes qui n'ont de sens que sur la machine d'origine : vidées à l'import (dossier de travail local, session de l'agent). */
const LOCAL_ONLY_COLUMNS: Record<string, string[]> = { dev_tasks: ["worktree_path", "session_id"] };

/** Tables qui doivent être vides dans la base cible (hors le compte local créé par la migration). */
const MUST_BE_EMPTY = ["reviews", "dev_tasks", "projects", "settings", "secrets", "identities", "credentials", "invitations", "audit_log"] as const;

export interface TransferReport {
  /** Lignes copiées, par table. */
  copied: Record<string, number>;
}

/**
 * Compte les lignes d'une table.
 * @param db Base de données.
 * @param table Nom de la table (de la liste fixe de ce module, jamais une saisie).
 * @returns Le nombre de lignes.
 */
async function count(db: Db, table: string): Promise<number> {
  return Number((await db.get<{ n: number }>(`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM ${table}`))!.n);
}

/**
 * Copie toutes les données d'une base vers une autre (typiquement SQLite local vers PostgreSQL du serveur), en conservant les identifiants.
 * La base cible doit avoir le même schéma et être vide : seul le compte local créé par la migration est remplacé par celui de la source.
 * Tout se fait dans une transaction : en cas d'erreur, la cible reste intacte. Les secrets sont copiés chiffrés, tels quels : ils ne seront
 * lisibles que si la cible utilise la même clé maître.
 * @param source Base d'origine, lue seulement.
 * @param target Base d'arrivée.
 * @returns Le nombre de lignes copiées par table.
 * @throws Error Si les schémas diffèrent, si la cible contient déjà des données, ou si la copie échoue ou ne reproduit pas les effectifs.
 */
export async function copyDatabase(source: Db, target: Db): Promise<TransferReport> {
  const expected = migrationsFor(source.sql).length;
  for (const [name, db] of [["source", source], ["cible", target]] as const) {
    const version = await db.schemaVersion();
    if (version !== expected) throw new Error(`La base ${name} est à la version ${version} du schéma, ${expected} attendue : ouvre-la d'abord avec cette version de l'outil`);
  }
  for (const table of MUST_BE_EMPTY) {
    if ((await count(target, table)) > 0) throw new Error(`La base cible n'est pas vide (${table}) : rien n'a été copié`);
  }
  if ((await count(target, "users")) > 1) throw new Error("La base cible a déjà plusieurs utilisateurs : rien n'a été copié");

  const copied: Record<string, number> = {};
  await target.transaction(async (tx) => {
    // Le compte local de la cible (créé par la migration) cède la place à celui de la source, avec ses identifiants
    for (const table of ["memberships", "workspaces", "users"]) await tx.run(`DELETE FROM ${table}`);

    for (const table of TRANSFER_TABLES) {
      const cleared = LOCAL_ONLY_COLUMNS[table] ?? [];
      const rows = await source.all<Record<string, unknown>>(`SELECT * FROM ${table}${(TABLES_WITH_ID as readonly string[]).includes(table) ? " ORDER BY id" : ""}`);
      for (const row of rows) {
        const columns = Object.keys(row);
        await tx.run(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          columns.map((c) => (cleared.includes(c) ? null : row[c])),
        );
      }
      copied[table] = rows.length;
    }

    // PostgreSQL ne fait pas avancer ses compteurs quand on fournit les identifiants : sans cela, le prochain ajout entrerait en collision
    if (tx.sql.name === "postgres") {
      for (const table of TABLES_WITH_ID) {
        await tx.run(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${table}), (SELECT COUNT(*) > 0 FROM ${table}))`);
      }
    }

    for (const table of TRANSFER_TABLES) {
      const actual = await count(tx, table);
      if (actual !== copied[table]) throw new Error(`Copie incomplète de ${table} : ${actual} lignes au lieu de ${copied[table]}`);
    }
  });
  return { copied };
}
