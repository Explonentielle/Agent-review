/**
 * Limite le nombre de tâches d'agent qui tournent en même temps, toutes personnes confondues : chaque agent occupe de la mémoire
 * et du processeur de la machine, et coûte de l'argent. Les tâches en trop attendent leur tour, dans l'ordre d'arrivée.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  /**
   * @param max Nombre maximum de tâches simultanées (au moins 1).
   */
  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("La limite de tâches simultanées doit être un entier d'au moins 1");
  }

  /** Tâches en cours et en attente, pour l'affichage et les tests. */
  get load(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiting.length };
  }

  /**
   * Exécute une tâche dès qu'une place se libère.
   * @param job Tâche à exécuter.
   * @returns Le résultat de la tâche (son erreur est relayée telle quelle, la place est toujours rendue).
   */
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // la place passe directement au suivant
      else this.active--;
    }
  }
}
