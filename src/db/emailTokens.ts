import { createHash, randomBytes } from "node:crypto";
import type { Db } from "./db.js";

/** À quoi sert le lien : confirmer une adresse en créant un compte, ou choisir un nouveau mot de passe. */
export type EmailTokenPurpose = "signup" | "reset";

/** Ce qu'un lien valable désigne : l'adresse qui l'a reçu et, pour un nouveau mot de passe, le compte. */
export interface EmailTokenTarget {
  email: string;
  userId: number | null;
}

export type EmailTokenRepo = ReturnType<typeof createEmailTokenRepo>;

/**
 * Empreinte d'un jeton : seule elle est stockée, un vol de la base ne donne donc aucun lien utilisable.
 * @param token Jeton lu dans le lien.
 * @returns Empreinte SHA-256 en hexadécimal.
 */
function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Liens à usage unique envoyés par email. Recevoir le lien prouve qu'on lit la boîte de l'adresse : c'est ce qui remplace la vérification d'adresse. Le jeton
 * est tiré au hasard (256 bits), n'est jamais stocké, ne sert qu'une fois et expire vite.
 * @param db Base de données.
 * @returns Les opérations sur les liens.
 */
export function createEmailTokenRepo(db: Db) {
  return {
    /**
     * Crée un lien. Les liens encore valables de même usage pour cette adresse sont annulés : seul le dernier envoyé fonctionne.
     * @param input Usage, adresse (normalisée par l'appelant), compte visé (nouveau mot de passe) et validité en minutes.
     * @returns Le jeton à mettre dans le lien : il n'est plus récupérable ensuite.
     */
    async create(input: { purpose: EmailTokenPurpose; email: string; userId?: number | null; minutes: number }): Promise<string> {
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + input.minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
      await db.run("DELETE FROM email_tokens WHERE purpose = ? AND email = ? AND used_at IS NULL", [input.purpose, input.email]);
      await db.run("INSERT INTO email_tokens (purpose, email, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)", [input.purpose, input.email, input.userId ?? null, hashOf(token), expiresAt]);
      return token;
    },

    /**
     * Regarde à quoi un lien correspond, sans le consommer (pour afficher la page).
     * @param purpose Usage attendu.
     * @param token Jeton lu dans le lien.
     * @returns L'adresse et le compte visés, ou null si le lien est inconnu, utilisé, expiré ou d'un autre usage.
     */
    async peek(purpose: EmailTokenPurpose, token: string): Promise<EmailTokenTarget | null> {
      if (token === "" || token.length > 200) return null;
      const row = await db.get<{ email: string; user_id: number | null }>(
        `SELECT email, user_id FROM email_tokens WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ${db.sql.now}`,
        [hashOf(token), purpose],
      );
      return row ? { email: row.email, userId: row.user_id } : null;
    },

    /**
     * Consomme un lien, en une seule instruction : de deux personnes qui l'utilisent en même temps, une seule l'obtient.
     * @param purpose Usage attendu.
     * @param token Jeton lu dans le lien.
     * @returns L'adresse et le compte visés, ou null si le lien n'est plus valable.
     */
    async consume(purpose: EmailTokenPurpose, token: string): Promise<EmailTokenTarget | null> {
      if (token === "" || token.length > 200) return null;
      const row = await db.get<{ email: string; user_id: number | null }>(
        `UPDATE email_tokens SET used_at = ${db.sql.now}
          WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ${db.sql.now}
          RETURNING email, user_id`,
        [hashOf(token), purpose],
      );
      return row ? { email: row.email, userId: row.user_id } : null;
    },

    /**
     * Supprime les liens expirés ou utilisés.
     * @returns Le nombre de liens supprimés.
     */
    async purge(): Promise<number> {
      return (await db.run(`DELETE FROM email_tokens WHERE used_at IS NOT NULL OR expires_at <= ${db.sql.now}`)).changes;
    },
  };
}
