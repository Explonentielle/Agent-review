import { errorMessage, log } from "./logger.js";

/**
 * File de traitement en mémoire, une tâche à la fois : les reviews tournent en série
 * pour maîtriser le coût et ne pas saturer la machine. La persistance est assurée par
 * la table `reviews` (statut queued/running remis en file au redémarrage).
 */
export class SerialQueue {
  private readonly pending: number[] = [];
  private running = false;

  constructor(private readonly worker: (id: number) => Promise<void>) {}

  push(id: number): void {
    if (this.pending.includes(id)) return;
    this.pending.push(id);
    void this.drain();
  }

  get size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let id: number | undefined;
      while ((id = this.pending.shift()) !== undefined) {
        try {
          await this.worker(id);
        } catch (err) {
          log.error("queue.worker_error", { id, error: errorMessage(err) });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
