import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "./agent/runner.js";
import { BudgetExceededError, assertBudgetAvailable } from "./budget.js";
import { currentMonth } from "./db/costs.js";
import { runDevTask } from "./dev/pipeline.js";
import { runReview } from "./review/pipeline.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings/schema.js";
import { createHarness, type Harness } from "./testing/harness.js";

const BACKENDS = ["sqlite", "postgres"] as const;

const settingsWith = (agentAuth: Settings["agentAuth"], monthlyUsd: number): Settings => ({ ...DEFAULT_SETTINGS, agentAuth, budget: { monthlyUsd } });

describe.each(BACKENDS)("coûts et budget, base %s", (backend) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness(backend);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** Review terminée avec un coût, rattachée à un projet. */
  async function addReview(projectPath: string, iid: number, costUsd: number): Promise<number> {
    const id = (await h.reviews.insertIfNew({ projectId: 1, projectPath, mrIid: iid, mrTitle: "t", mrUrl: "u", author: "a", headSha: String(iid).padStart(40, "a") }))!;
    await h.reviews.saveResult(id, { status: "auto_ok", decisionReasons: [], resultJson: "{}", changedLines: 1, costUsd, numTurns: 1 });
    return id;
  }
  async function addDevTask(projectPath: string, iid: number, costUsd: number): Promise<number> {
    const id = await h.tasks.insert({ projectId: 1, projectPath, issueIid: iid, issueTitle: "t", issueUrl: "u", extraInstructions: null });
    await h.tasks.update(id, { status: "mr_created", cost_usd: costUsd });
    return id;
  }

  it("cumule par type de tâche et par projet, du plus coûteux au moins coûteux, sur le mois courant seulement", async () => {
    await addReview("groupe/a", 1, 1.5);
    await addReview("groupe/a", 2, 0.5);
    await addDevTask("groupe/a", 10, 3);
    await addDevTask("groupe/b", 11, 0.25);
    const old = await addReview("groupe/a", 3, 99);
    await h.db.run("UPDATE reviews SET updated_at = '2020-01-15 10:00:00' WHERE id = ?", [old]);

    const month = currentMonth();
    expect(await h.costs.breakdown(month)).toEqual([
      { kind: "dev", projectPath: "groupe/a", usd: 3, count: 1 },
      { kind: "review", projectPath: "groupe/a", usd: 2, count: 2 },
      { kind: "dev", projectPath: "groupe/b", usd: 0.25, count: 1 },
    ]);
    expect(await h.costs.monthTotal(month)).toBeCloseTo(5.25);
    expect(await h.costs.monthTotal("2020-01")).toBe(99);
    expect(await h.costs.monthTotal("1999-01")).toBe(0);
  });

  it("budget : bloque seulement en mode clé API, avec un budget fixé, une fois atteint", async () => {
    await addDevTask("groupe/a", 10, 3.5);

    await expect(assertBudgetAvailable(settingsWith("subscription", 1), h.costs)).resolves.toBeUndefined(); // l'abonnement n'est pas facturé à l'usage
    await expect(assertBudgetAvailable(settingsWith("api", 0), h.costs)).resolves.toBeUndefined(); // 0 = aucune limite
    await expect(assertBudgetAvailable(settingsWith("api", 10), h.costs)).resolves.toBeUndefined();

    const attempt = () => assertBudgetAvailable(settingsWith("api", 3.5), h.costs);
    await expect(attempt()).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(attempt()).rejects.toThrow(/3\.50 \$ dépensés sur 3\.50 \$/);
  });

  it("le budget du mois précédent ne compte pas pour le mois suivant", async () => {
    const id = await addDevTask("groupe/a", 10, 50);
    await h.db.run("UPDATE dev_tasks SET updated_at = '2020-01-15 10:00:00' WHERE id = ?", [id]);
    await expect(assertBudgetAvailable(settingsWith("api", 5), h.costs)).resolves.toBeUndefined();
  });

  it("une tâche de dev et une review ne démarrent pas quand le budget est atteint", async () => {
    await h.settings.save(settingsWith("api", 2));
    await addDevTask("groupe/a", 10, 5);
    const requests: AgentRequest[] = [];
    const runner: AgentRunner = {
      async run(req) {
        requests.push(req);
        throw new Error("ne devrait pas être lancé");
      },
    };

    h.connector.tickets.set(609, h.ticket());
    const taskId = await h.tasks.insert({ projectId: 1, projectPath: "groupe/projet", issueIid: 609, issueTitle: "Import", issueUrl: "u", extraInstructions: null });
    await runDevTask(taskId, { config: h.config, forges: h.forges, costs: h.costs, settings: h.settings, tasks: h.tasks, runner });
    expect(await h.tasks.get(taskId)).toMatchObject({ status: "error" });
    expect((await h.tasks.get(taskId))!.error).toMatch(/Budget mensuel atteint/);

    const sha = h.addMergeRequestRef(7, { "app.js": "x\n" });
    const reviewId = (await h.reviews.insertIfNew({ projectId: 1, projectPath: "groupe/projet", mrIid: 7, mrTitle: "t", mrUrl: "u", author: "a", headSha: sha }))!;
    await runReview(reviewId, { config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, runner });
    expect(await h.reviews.get(reviewId)).toMatchObject({ status: "error" });
    expect((await h.reviews.get(reviewId))!.error).toMatch(/Budget mensuel atteint/);

    expect(requests).toHaveLength(0);
    expect(h.remoteBranchSha("feature/609-import")).toBe("");
  });
});
