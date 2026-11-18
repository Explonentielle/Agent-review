/** Nombre de clés suivies au plus : au-delà, les plus anciennes sont oubliées (la mémoire ne grandit jamais sans limite). */
const MAX_KEYS = 10_000;

export type RateLimiter = ReturnType<typeof createRateLimiter>;

/**
 * Limiteur de tentatives à fenêtre glissante, en mémoire : au plus `limit` tentatives par clé (une adresse IP, par exemple) pendant `windowMs`.
 * Il ne protège qu'une instance de l'outil (le compteur disparaît au redémarrage), ce qui suffit contre un essai en masse de la connexion.
 * @param limit Tentatives permises par fenêtre.
 * @param windowMs Durée de la fenêtre en millisecondes.
 * @param now Horloge (remplaçable dans les tests).
 * @returns Les opérations du limiteur.
 */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();

  return {
    /**
     * Compte une tentative si elle est permise.
     * @param key Qui tente (adresse IP).
     * @returns `ok` (la tentative est comptée) et, sinon, `retryAfterSeconds` : dans combien de temps la prochaine sera permise.
     */
    take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + windowMs - t) / 1000)) };
      }
      recent.push(t);
      hits.delete(key); // réinsérée en dernier : les clés les plus anciennes sont celles qu'on oublie en premier
      hits.set(key, recent);
      while (hits.size > MAX_KEYS) hits.delete(hits.keys().next().value!);
      return { ok: true };
    },

    /**
     * Oublie les tentatives d'une clé (une connexion réussie remet le compteur de l'adresse à zéro).
     * @param key Clé à remettre à zéro.
     * @returns Rien.
     */
    forget(key: string): void {
      hits.delete(key);
    },

    /** Oublie toutes les tentatives (tests). */
    reset(): void {
      hits.clear();
    },
  };
}
