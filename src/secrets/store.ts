import type { Db } from "../db/db.js";
import { registerSecret } from "../logger.js";
import { Keyring, SecretError, envelopeKeyId, open, seal } from "./crypto.js";

/** À qui appartient un secret : un espace (userId vide, secret partagé) ou un utilisateur dans un espace. */
export interface SecretScope {
  workspaceId: number;
  userId: number | null;
}

/** Ce que la liste d'un espace révèle d'un secret : son nom et sa date, jamais sa valeur. */
export interface SecretInfo {
  name: string;
  updated_at: string;
}

const NAME_FORMAT = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_VALUE_LENGTH = 8192;

export type SecretStore = ReturnType<typeof createSecretStore>;

/**
 * Dit si la base contient des secrets, sans les lire. Sert à refuser de générer une nouvelle clé maître
 * quand l'ancienne est perdue.
 * @param db Base de données.
 * @returns true si au moins un secret est enregistré.
 */
export async function hasAnySecret(db: Db): Promise<boolean> {
  return (await db.get("SELECT 1 AS found FROM secrets LIMIT 1")) !== undefined;
}

/**
 * Coffre des secrets : jetons de forge, clés d'API. Chaque valeur est chiffrée (AES-256-GCM) avec la clé maître
 * avant d'entrer en base, et liée à son espace, son utilisateur et son nom : recopier une valeur chiffrée ailleurs
 * ne la rend pas lisible. Les valeurs lues sont déclarées au journal, qui les masque.
 * @param db Base de données.
 * @param keyring Clés maîtres (hors base).
 * @returns Les opérations du coffre.
 */
export function createSecretStore(db: Db, keyring: Keyring) {
  /**
   * Contexte authentifié d'un secret.
   * @param scope Propriétaire.
   * @param name Nom du secret.
   * @returns Texte lié au chiffrement.
   */
  const contextOf = (scope: SecretScope, name: string): string => `review-agent:secret:${scope.workspaceId}:${scope.userId ?? "workspace"}:${name}`;

  /**
   * Condition SQL qui désigne un secret.
   * @param scope Propriétaire.
   * @param name Nom du secret.
   * @returns La condition et ses paramètres.
   */
  const whereOf = (scope: SecretScope, name: string): { sql: string; params: unknown[] } =>
    scope.userId === null
      ? { sql: "workspace_id = ? AND name = ? AND user_id IS NULL", params: [scope.workspaceId, name] }
      : { sql: "workspace_id = ? AND name = ? AND user_id = ?", params: [scope.workspaceId, name, scope.userId] };

  /**
   * Vérifie le nom d'un secret.
   * @param name Nom proposé.
   * @returns Rien.
   * @throws SecretError Si le nom n'est pas en minuscules, chiffres, point, tiret ou souligné (64 caractères au plus).
   */
  const checkName = (name: string): void => {
    if (!NAME_FORMAT.test(name)) throw new SecretError("Nom de secret invalide : minuscules, chiffres, point, tiret ou souligné (64 caractères au plus)");
  };

  return {
    /**
     * Enregistre un secret (remplace la valeur existante).
     * @param scope Propriétaire du secret.
     * @param name Nom du secret (par exemple « github.token »).
     * @param value Valeur en clair, chiffrée avant d'entrer en base.
     * @returns Rien.
     * @throws SecretError Si le nom est invalide ou la valeur vide ou trop longue.
     */
    async put(scope: SecretScope, name: string, value: string): Promise<void> {
      checkName(name);
      if (value === "" || value.length > MAX_VALUE_LENGTH) throw new SecretError(`Valeur invalide : entre 1 et ${MAX_VALUE_LENGTH} caractères`);
      registerSecret(value);
      const sealed = seal(keyring, value, contextOf(scope, name));
      const where = whereOf(scope, name);
      const update = () => db.run(`UPDATE secrets SET value = ?, updated_at = ${db.sql.now} WHERE ${where.sql}`, [sealed, ...where.params]);
      if ((await update()).changes > 0) return;
      try {
        await db.run("INSERT INTO secrets (workspace_id, user_id, name, value) VALUES (?, ?, ?, ?)", [scope.workspaceId, scope.userId, name, sealed]);
      } catch (err) {
        // Deux enregistrements simultanés du même secret : le second trouve la ligne du premier et la remplace
        if ((await update()).changes === 0) throw err;
      }
    },

    /**
     * Lit un secret et le déchiffre.
     * @param scope Propriétaire du secret.
     * @param name Nom du secret.
     * @returns La valeur en clair, ou null si le secret n'existe pas.
     * @throws SecretError Si le secret est illisible (clé maître différente, donnée modifiée).
     */
    async get(scope: SecretScope, name: string): Promise<string | null> {
      checkName(name);
      const where = whereOf(scope, name);
      const row = await db.get<{ value: string }>(`SELECT value FROM secrets WHERE ${where.sql}`, where.params);
      if (!row) return null;
      const value = open(keyring, row.value, contextOf(scope, name));
      registerSecret(value);
      return value;
    },

    /**
     * Dit si un secret existe, sans le déchiffrer.
     * @param scope Propriétaire du secret.
     * @param name Nom du secret.
     * @returns true si le secret est enregistré.
     */
    async has(scope: SecretScope, name: string): Promise<boolean> {
      checkName(name);
      const where = whereOf(scope, name);
      return (await db.get(`SELECT 1 AS found FROM secrets WHERE ${where.sql}`, where.params)) !== undefined;
    },

    /**
     * Supprime un secret.
     * @param scope Propriétaire du secret.
     * @param name Nom du secret.
     * @returns true si un secret a été supprimé, false s'il n'existait pas.
     */
    async delete(scope: SecretScope, name: string): Promise<boolean> {
      checkName(name);
      const where = whereOf(scope, name);
      return (await db.run(`DELETE FROM secrets WHERE ${where.sql}`, where.params)).changes > 0;
    },

    /**
     * Liste les secrets d'un propriétaire : noms et dates seulement, jamais les valeurs.
     * @param scope Propriétaire des secrets.
     * @returns Les secrets, classés par nom.
     */
    list(scope: SecretScope): Promise<SecretInfo[]> {
      const owner = scope.userId === null ? { sql: "user_id IS NULL", params: [] as unknown[] } : { sql: "user_id = ?", params: [scope.userId] };
      return db.all<SecretInfo>(`SELECT name, updated_at FROM secrets WHERE workspace_id = ? AND ${owner.sql} ORDER BY name`, [scope.workspaceId, ...owner.params]);
    },

    /**
     * Personnes qui ont au moins un secret personnel enregistré, pour démarrer leurs connexions aux forges au lancement de l'outil.
     * Ne livre aucune valeur : seulement des identifiants.
     * @returns Les couples (espace, utilisateur).
     */
    async listOwners(): Promise<{ workspaceId: number; userId: number }[]> {
      const rows = await db.all<{ workspace_id: number; user_id: number }>("SELECT DISTINCT workspace_id, user_id FROM secrets WHERE user_id IS NOT NULL ORDER BY workspace_id, user_id");
      return rows.map((r) => ({ workspaceId: r.workspace_id, userId: r.user_id }));
    },

    /**
     * Rechiffre avec la clé courante les secrets chiffrés par une ancienne clé (après une rotation de la clé maître).
     * @returns Le nombre de secrets rechiffrés.
     * @throws SecretError Si un secret est illisible : l'opération s'arrête là, les secrets déjà rechiffrés le restent.
     */
    async reencryptAll(): Promise<number> {
      const rows = await db.all<{ id: number; workspace_id: number; user_id: number | null; name: string; value: string }>(
        "SELECT id, workspace_id, user_id, name, value FROM secrets ORDER BY id",
      );
      let count = 0;
      for (const row of rows) {
        if (envelopeKeyId(row.value) === keyring.currentKeyId) continue;
        const scope = { workspaceId: row.workspace_id, userId: row.user_id };
        const plain = open(keyring, row.value, contextOf(scope, row.name));
        await db.run("UPDATE secrets SET value = ? WHERE id = ?", [seal(keyring, plain, contextOf(scope, row.name)), row.id]); // la date de mise à jour reste celle de la saisie
        count++;
      }
      return count;
    },
  };
}
