import type { Db } from "./db.js";

export type CredentialRepo = ReturnType<typeof createCredentialRepo>;

/**
 * Mots de passe des utilisateurs, sous forme d'empreinte lente (jamais en clair). La table est séparée des utilisateurs : aucune requête sur `users`
 * ne peut les remonter par erreur.
 * @param db Base de données.
 * @returns Les opérations sur les mots de passe.
 */
export function createCredentialRepo(db: Db) {
  return {
    /**
     * Enregistre le mot de passe d'un utilisateur (le remplace s'il en avait un).
     * @param userId Identifiant de l'utilisateur.
     * @param hash Empreinte du mot de passe (`auth/password.ts`).
     * @returns Rien.
     */
    async set(userId: number, hash: string): Promise<void> {
      await db.run(
        `INSERT INTO credentials (user_id, password_hash) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = ${db.sql.now}`,
        [userId, hash],
      );
    },

    /**
     * Empreinte du mot de passe d'un utilisateur.
     * @param userId Identifiant de l'utilisateur.
     * @returns L'empreinte, ou null s'il n'a pas de mot de passe (compte créé par une forge).
     */
    async get(userId: number): Promise<string | null> {
      const row = await db.get<{ password_hash: string }>("SELECT password_hash FROM credentials WHERE user_id = ?", [userId]);
      return row ? row.password_hash : null;
    },
  };
}
