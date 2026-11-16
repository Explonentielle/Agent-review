import { describe, expect, it } from "vitest";
import { GOLD, computeArmory, gradeOfLevel, gradeOfScore, itemScore, type ArmoryProject, type ArmoryReview, type ArmoryTask } from "./armory.js";

const project = (projectId: number, path = `moi/p${projectId}`): ArmoryProject => ({ source: "github", projectId, path, devEnabled: true });
const task = (id: number, projectId: number, status: string, extra: Partial<ArmoryTask> = {}): ArmoryTask => ({
  id, source: "github", project_id: projectId, issue_iid: 100 + id, issue_title: `Ticket ${id}`, status, files_changed: null, num_turns: null, mode: "new", updated_at: "2026-11-12 10:00:00", ...extra,
});
const review = (projectId: number, status: string): ArmoryReview => ({ source: "github", project_id: projectId, status });

describe("l'armurerie : armes (projets) et pièces forgées", () => {
  it("la note d'une pièce récompense un travail large, direct, ou une reprise", () => {
    const base = { files_changed: null, num_turns: null, mode: "new" as const, status: "mr_created" };
    expect(itemScore(base)).toBe(20);
    expect(itemScore({ ...base, files_changed: 4 })).toBe(26);
    expect(itemScore({ ...base, files_changed: 500 })).toBe(50); // plafonné à 20 fichiers
    expect(itemScore({ ...base, num_turns: 10 })).toBe(35);
    expect(itemScore({ ...base, num_turns: 25 })).toBe(28);
    expect(itemScore({ ...base, num_turns: 50 })).toBe(23);
    expect(itemScore({ ...base, num_turns: 200 })).toBe(20);
    expect(itemScore({ ...base, status: "mr_updated" })).toBe(25);
    expect(itemScore({ ...base, mode: "followup" })).toBe(25);
    expect(itemScore({ files_changed: 20, num_turns: 5, mode: "followup", status: "mr_updated" })).toBe(70);
  });

  it("la qualité d'une pièce et celle d'une arme suivent des seuils nets", () => {
    expect([20, 34, 35, 49, 50, 64, 65, 100].map(gradeOfScore)).toEqual(["common", "common", "rare", "rare", "epic", "epic", "legendary", "legendary"]);
    expect([1, 2, 3, 5, 6, 9, 10, 40].map(gradeOfLevel)).toEqual(["common", "common", "rare", "rare", "epic", "epic", "legendary", "legendary"]);
  });

  it("un projet sans activité est une arme brute de niveau 1", () => {
    const { weapons, loot } = computeArmory({ projects: [project(1)], tasks: [], reviews: [] });
    expect(weapons).toEqual([{ key: "github:1", source: "github", projectId: 1, path: "moi/p1", devEnabled: true, xp: 0, level: 1, grade: "common", forged: 0, reviews: 0, failures: 0, blocked: 0 }]);
    expect(loot).toEqual([]);
  });

  it("les pièces forgées et les reviews font monter l'arme ; erreurs et questions sont comptées sans XP", () => {
    const tasks = [
      task(1, 1, "mr_created", { files_changed: 10, num_turns: 12 }), // 20 + 15 + 15 = 50, épique
      task(2, 1, "mr_updated", { files_changed: 2 }), // 20 + 3 + 5 = 28, commun
      task(3, 1, "error"),
      task(4, 1, "blocked"),
      task(5, 1, "cancelled"),
      task(6, 2, "running"),
    ];
    const { weapons, loot } = computeArmory({ projects: [project(1), project(2)], tasks, reviews: [review(1, "approved"), review(1, "published"), review(1, "error"), review(2, "needs_human")] });
    const w1 = weapons.find((w) => w.key === "github:1")!;
    expect(w1).toMatchObject({ forged: 2, failures: 1, blocked: 1, reviews: 2, xp: 50 + 28 + 10 });
    expect(w1.level).toBe(2); // 88 XP : le niveau 3 commence à 150
    expect(w1.grade).toBe("common");
    expect(weapons.find((w) => w.key === "github:2")).toMatchObject({ forged: 0, reviews: 1, xp: 5, level: 1 });
    expect(loot.map((i) => [i.id, i.grade, i.value])).toEqual([["task-2", "common", GOLD.common], ["task-1", "epic", GOLD.epic]]);
  });

  it("les armes sont classées par niveau, et une pièce d'un projet retiré reste à vendre", () => {
    const tasks = [task(1, 1, "mr_created", { files_changed: 20, num_turns: 5 }), task(2, 1, "mr_created", { files_changed: 20, num_turns: 5 }), task(3, 99, "mr_created")];
    const { weapons, loot } = computeArmory({ projects: [project(2, "a/zzz"), project(1, "b/aaa")], tasks, reviews: [] });
    expect(weapons.map((w) => w.key)).toEqual(["github:1", "github:2"]);
    expect(loot.find((i) => i.taskId === 3)).toMatchObject({ weaponKey: "github:99", grade: "common" });
    expect(weapons.every((w) => w.key !== "github:99")).toBe(true);
  });
});
