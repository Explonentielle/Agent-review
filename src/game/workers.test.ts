import { describe, expect, it } from "vitest";
import { MAX_WORKERS, RECENT_MS, parseDbDate, pickWorkers, tidy, type ReviewLike, type TaskLike } from "./workers.js";

const NOW = Date.parse("2026-11-12T20:00:00Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString().replace("T", " ").slice(0, 19);
const task = (id: number, status: string, minutesAgo = 0, title = `Ticket ${id}`): TaskLike => ({ id, status, issue_iid: 100 + id, issue_title: title, updated_at: at(minutesAgo) });
const review = (id: number, status: string): ReviewLike => ({ id, status, mr_iid: 10 + id, mr_title: `MR ${id}`, updated_at: at(0) });

describe("les forgerons de l'atelier", () => {
  it("lit les dates de SQLite (UTC sans fuseau) et de PostgreSQL (ISO)", () => {
    expect(parseDbDate("2026-11-12 20:00:00")).toBe(NOW);
    expect(parseDbDate("2026-11-12T20:00:00Z")).toBe(NOW);
    expect(parseDbDate("2026-11-12T22:00:00+02:00")).toBe(NOW);
    expect(Number.isNaN(parseDbDate("pas une date"))).toBe(true);
  });

  it("nettoie le texte non fiable : sans contrôle, sur une ligne, tronqué", () => {
    expect(tidy("  a\u0000b\n\tc  ", 10)).toBe("a b c");
    expect(tidy("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("une tâche qui travaille dit sa dernière étape, sinon une phrase par défaut", () => {
    const [withStep] = pickWorkers({ tasks: [task(1, "running")], reviews: [], steps: { 1: "Lecture du ticket\u0007 et du dépôt" }, now: NOW });
    expect(withStep).toMatchObject({ id: "dev-1", kind: "dev", state: "working", line: "Lecture du ticket et du dépôt" });
    const [without] = pickWorkers({ tasks: [task(2, "running")], reviews: [], steps: {}, now: NOW });
    expect(without!.line).toBe("Je forge le ticket #102…");
  });

  it("ordre : ceux qui travaillent, ceux qui attendent, puis les terminées depuis peu", () => {
    const workers = pickWorkers({
      tasks: [task(1, "mr_created", 3), task(2, "queued"), task(3, "running")],
      reviews: [review(1, "running"), review(2, "queued")],
      steps: {},
      now: NOW,
    });
    expect(workers.map((w) => `${w.id}:${w.state}`)).toEqual(["dev-3:working", "review-1:working", "dev-2:waiting", "review-2:waiting"]);
  });

  it("une tâche terminée reste à l'atelier un quart d'heure, avec son résultat", () => {
    const base = { reviews: [], steps: {}, now: NOW };
    const states = pickWorkers({ ...base, tasks: [task(1, "mr_created", 1), task(2, "blocked", 5), task(3, "error", 14), task(4, "mr_updated", 16), task(5, "cancelled", 1)] });
    expect(states.map((w) => `${w.id}:${w.state}`)).toEqual(["dev-1:done", "dev-2:blocked", "dev-3:failed"]);
    expect(states[0]!.line).toContain("Pièce forgée");
    expect(RECENT_MS).toBe(15 * 60_000);
  });

  it("un agent relancé sur sa MR n'apparaît qu'une fois : la tâche reprise cède la place à la nouvelle", () => {
    const base = { reviews: [], steps: {}, now: NOW };
    const resumed = { ...task(2, "running"), parent_id: 1 };
    const workers = pickWorkers({ ...base, tasks: [resumed, task(1, "mr_created", 2)] });
    expect(workers.map((w) => `${w.id}:${w.state}`)).toEqual(["dev-2:working"]);
    // Sans reprise, ou avec un lien vide, la tâche terminée reste affichée
    expect(pickWorkers({ ...base, tasks: [{ ...task(3, "running"), parent_id: null }, task(1, "mr_created", 2)] }).map((w) => w.id)).toEqual(["dev-3", "dev-1"]);
  });

  it("au plus quatre forgerons, et le libellé est court", () => {
    const tasks = [1, 2, 3, 4, 5, 6].map((id) => task(id, "running", 0, "Un titre de ticket vraiment très long pour tester la troncature du libellé"));
    const workers = pickWorkers({ tasks, reviews: [], steps: {}, now: NOW });
    expect(workers.length).toBe(MAX_WORKERS);
    expect(workers[0]!.label.length <= 40).toBe(true);
    expect(workers[0]!.label.startsWith("#101 Un titre")).toBe(true);
  });

  it("personne à l'atelier quand rien n'est actif", () => {
    expect(pickWorkers({ tasks: [task(1, "cancelled", 1), task(2, "mr_created", 60)], reviews: [review(1, "approved")], steps: {}, now: NOW })).toEqual([]);
  });
});
