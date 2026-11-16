/**
 * Plafond d'actions par personne sur une fenêtre glissante (en mémoire) : une validation à la fois reste le principe, ce plafond
 * empêche seulement qu'un script ou une page emballée ne crée des dizaines de tickets ou de projets chez la forge.
 */
export class ScribeLimitError extends Error {}

export interface Limiter {
  /** Compte une action ; lève `ScribeLimitError` quand le plafond est atteint. */
  take(key: string, limit: number, what: string): void;
}

/**
 * @param windowMs Durée de la fenêtre.
 * @param now Horloge (remplaçable dans les tests).
 * @returns Un limiteur.
 */
export function createLimiter(windowMs = 3_600_000, now: () => number = Date.now): Limiter {
  const hits = new Map<string, number[]>();
  return {
    take(key, limit, what) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((h) => t - h < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        throw new ScribeLimitError(`Trop de ${what} en une heure (${limit} au plus). Réessaie plus tard.`);
      }
      recent.push(t);
      hits.set(key, recent);
    },
  };
}

/** Plafonds par heure et par personne. */
export const HOURLY = { drafts: 30, tickets: 40, projects: 5 } as const;
