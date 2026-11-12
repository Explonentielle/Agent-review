/**
 * Les forgerons de l'atelier : un par agent actif ou récemment terminé, avec ce qu'il « dit » d'après l'état réel de sa tâche.
 * Fonction pure : le serveur lui donne les lignes de la base, le dashboard dessine le résultat.
 */

export type WorkerState = "working" | "waiting" | "done" | "blocked" | "failed";

export interface Worker {
  /** `dev-12` ou `review-7` : stable d'une actualisation à l'autre. */
  id: string;
  kind: "dev" | "review";
  /** Ticket ou demande de fusion traité, court. */
  label: string;
  state: WorkerState;
  /** Ce que le forgeron dit dans sa bulle. */
  line: string;
}

export interface TaskLike {
  id: number;
  status: string;
  issue_iid: number;
  issue_title: string;
  updated_at: string;
}

export interface ReviewLike {
  id: number;
  status: string;
  mr_iid: number;
  mr_title: string;
  updated_at: string;
}

export const MAX_WORKERS = 4;
/** Une tâche terminée reste à l'atelier ce temps-là, pour qu'on voie le résultat. */
export const RECENT_MS = 15 * 60_000;
const MAX_LINE = 70;
const MAX_LABEL = 40;

/**
 * Nettoie un texte venu de la base ou du modèle avant de l'afficher : sans caractères de contrôle, sur une ligne, court.
 * @param text Texte brut (non fiable).
 * @param max Longueur maximale, points de suspension compris.
 * @returns Le texte nettoyé.
 */
export function tidy(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/**
 * Lit une date de la base (`2026-11-12 19:30:00` en UTC pour SQLite, ISO pour PostgreSQL).
 * @param value Date lue.
 * @returns Les millisecondes depuis 1970, ou NaN si la date est illisible.
 */
export function parseDbDate(value: string): number {
  const iso = /Z|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

const ACTIVE_TASK: Record<string, WorkerState> = { running: "working", queued: "waiting" };
const FINISHED_TASK: Record<string, WorkerState> = { mr_created: "done", mr_updated: "done", blocked: "blocked", error: "failed" };

const TASK_LINES: Record<WorkerState, (iid: number) => string> = {
  working: (iid) => `Je forge le ticket #${iid}…`,
  waiting: () => "J'attends mon tour à l'enclume.",
  done: () => "Pièce forgée ! La demande de fusion est ouverte.",
  blocked: () => "J'ai une question avant de frapper…",
  failed: () => "Aïe, la lame s'est brisée.",
};

/**
 * Choisit les forgerons à montrer : d'abord ceux qui travaillent, puis ceux qui attendent, puis les tâches terminées depuis peu.
 * @param input Tâches et reviews récentes, dernière étape connue des tâches en cours, et l'heure.
 * @returns Au plus MAX_WORKERS forgerons.
 */
export function pickWorkers(input: { tasks: TaskLike[]; reviews: ReviewLike[]; steps: Record<number, string>; now: number }): Worker[] {
  const working: Worker[] = [];
  const waiting: Worker[] = [];
  const recent: Worker[] = [];

  for (const task of input.tasks) {
    const label = tidy(`#${task.issue_iid} ${task.issue_title}`, MAX_LABEL);
    const active = ACTIVE_TASK[task.status];
    if (active) {
      const step = input.steps[task.id];
      const line = active === "working" && step ? tidy(step, MAX_LINE) : TASK_LINES[active](task.issue_iid);
      (active === "working" ? working : waiting).push({ id: `dev-${task.id}`, kind: "dev", label, state: active, line });
      continue;
    }
    const finished = FINISHED_TASK[task.status];
    if (finished && input.now - parseDbDate(task.updated_at) <= RECENT_MS) {
      recent.push({ id: `dev-${task.id}`, kind: "dev", label, state: finished, line: TASK_LINES[finished](task.issue_iid) });
    }
  }

  for (const review of input.reviews) {
    const label = tidy(`MR !${review.mr_iid} ${review.mr_title}`, MAX_LABEL);
    if (review.status === "running") working.push({ id: `review-${review.id}`, kind: "review", label, state: "working", line: tidy(`Je contrôle la lame : ${review.mr_title}`, MAX_LINE) });
    else if (review.status === "queued") waiting.push({ id: `review-${review.id}`, kind: "review", label, state: "waiting", line: "Une lame attend mon contrôle." });
  }

  return [...working, ...waiting, ...recent].slice(0, MAX_WORKERS);
}
