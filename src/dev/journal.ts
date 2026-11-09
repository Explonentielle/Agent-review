import type { DevTaskEvent, DevTaskRepo } from "../db/devTasks.js";
import { errorMessage, log } from "../logger.js";

/**
 * Journal d'une tâche de dev. Les écritures partent dans l'ordre où elles sont demandées, même
 * quand elles viennent de callbacks synchrones (événements en direct de l'agent) : avec PostgreSQL,
 * deux écritures lancées sans les attendre pourraient arriver dans le désordre. Une écriture qui
 * échoue est signalée dans les logs de l'outil mais ne fait pas échouer la tâche.
 */
export class Journal {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly tasks: DevTaskRepo,
    private readonly taskId: number,
  ) {}

  private enqueue(write: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(write).catch((err) => log.error("dev.journal_error", { taskId: this.taskId, error: errorMessage(err) }));
    return this.tail;
  }

  step(text: string): Promise<void> {
    return this.enqueue(() => this.tasks.addEvent(this.taskId, "step", text));
  }

  event(kind: DevTaskEvent["kind"], text: string): Promise<void> {
    return this.enqueue(() => this.tasks.addEvent(this.taskId, kind, text));
  }

  update(fields: Parameters<DevTaskRepo["update"]>[1]): Promise<void> {
    return this.enqueue(() => this.tasks.update(this.taskId, fields));
  }

  /** Attend que toutes les écritures demandées soient terminées. */
  flush(): Promise<void> {
    return this.tail;
  }
}
