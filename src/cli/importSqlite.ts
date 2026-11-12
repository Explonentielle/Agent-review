/**
 * Copie la base SQLite locale vers la base PostgreSQL du serveur (celle de DATABASE_URL), identifiants conservés.
 * Usage : DATABASE_URL=postgres://... npm run db:import -- <fichier.sqlite>
 *     ou, dans le conteneur du serveur : node dist/cli/importSqlite.js /app/data/import.sqlite
 * Arrête l'outil local avant (le fichier doit être complet) et travaille sur une COPIE du fichier. La base du serveur doit être vide.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "../db/migrations.js";
import { openPostgres } from "../db/postgres.js";
import { openSqlite } from "../db/sqlite.js";
import { copyDatabase } from "../db/transfer.js";

const file = process.argv[2];
const url = process.env.DATABASE_URL;
if (!file || !url) {
  console.error("Usage : DATABASE_URL=postgres://... npm run db:import -- <fichier.sqlite>");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`Fichier introuvable : ${file}`);
  process.exit(1);
}

// Travail sur une copie : le fichier d'origine n'est jamais ouvert en écriture
const workDir = mkdtempSync(path.join(tmpdir(), "import-sqlite-"));
const copy = path.join(workDir, "source.sqlite");
copyFileSync(file, copy);

const source = openSqlite(copy);
const target = await openPostgres(url);
try {
  await migrate(target);
  const { copied } = await copyDatabase(source, target);
  console.log("Copie terminée :");
  for (const [table, n] of Object.entries(copied)) console.log(`  ${table} : ${n}`);
  console.log("\nLes secrets enregistrés (jetons, clés) ont été copiés chiffrés. Ils ne sont lisibles que si SECRETS_MASTER_KEY du serveur contient la clé de data/master.key de la machine d'origine.");
  console.log("Les dossiers de travail locaux des tâches de dev ne suivent pas : leurs chemins ont été vidés.");
} finally {
  await source.close();
  await target.close();
  rmSync(workDir, { recursive: true, force: true });
}
