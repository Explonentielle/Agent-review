import { describe, expect, it } from "vitest";
import { LOOT_CATALOG, computeDrops, lootEvents, rarityWeights, rollDrop, type LootEvent } from "./loot.js";

/* Butin « création de projet » et graine des armes uniques. */
const NONE = { tasks: [], reviews: [], mergedTaskIds: [] };
const projects = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, created_at: `2026-11-${String((i % 28) + 1).padStart(2, "0")} 10:00:00` }));

describe("butin : création de projet", () => {
  it("chaque projet créé est un événement stable ; sans projet, rien ne change", () => {
    expect(lootEvents(NONE)).toEqual([]);
    expect(lootEvents({ ...NONE, projects: projects(3) }).map((e) => e.id).sort()).toEqual(["project-1", "project-2", "project-3"]);
    expect(lootEvents({ ...NONE, projects: projects(3) }).every((e) => e.kind === "project")).toBe(true);
  });

  it("seuls les 20 premiers projets créés comptent : en créer à la chaîne ne rapporte pas sans fin", () => {
    const ids = lootEvents({ ...NONE, projects: projects(60) }).map((e) => e.id);
    expect(ids).toHaveLength(20);
    expect(ids).toContain("project-1");
    expect(ids).toContain("project-20");
    expect(ids).not.toContain("project-21");
  });

  it("un projet rapporte moins qu'une pièce forgée : pas toujours quelque chose, et de moins bonnes raretés", () => {
    const events: LootEvent[] = Array.from({ length: 3000 }, (_, i) => ({ id: `project-${i}`, kind: "project", at: "2026-11-01", quality: "common" }));
    const dropped = events.map((e) => rollDrop(e)).filter((d) => d !== null);
    expect(dropped.length).toBeGreaterThan(0.25 * events.length);
    expect(dropped.length).toBeLessThan(0.45 * events.length); // environ 35 %
    const legendary = dropped.filter((d) => d!.rarity === "legendary").length / dropped.length;
    const forged = Array.from({ length: 3000 }, (_, i) => rollDrop({ id: `forge-${i}`, kind: "forge", at: "2026-11-01", quality: "common" })!);
    expect(legendary).toBeLessThan(forged.filter((d) => d.rarity === "legendary").length / forged.length);
    const [pc] = rarityWeights("project", "common"), [fc] = rarityWeights("forge", "common");
    expect(pc).toBeGreaterThan(fc);
    expect(rarityWeights("project", "common").reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("le tirage d'un projet ne dépend que de son identifiant", () => {
    const e: LootEvent = { id: "project-4", kind: "project", at: "2026-11-01", quality: "common" };
    expect(rollDrop(e)).toEqual(rollDrop({ ...e }));
  });

  it("computeDrops tient compte des projets, et reste identique d'un appel à l'autre", () => {
    const input = { ...NONE, projects: projects(20) };
    const drops = computeDrops(input);
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.every((d) => d.event === "project")).toBe(true);
    expect(computeDrops(input)).toEqual(drops);
  });
});

describe("butin : graine des armes uniques", () => {
  it("chaque tirage porte la graine de son événement, qui fixe les valeurs de l'arme", () => {
    for (let i = 1; i <= 200; i++) {
      const drop = rollDrop({ id: `merge-${i}`, kind: "merge", at: "2026-11-01", quality: "epic" })!;
      expect(drop.seed).toBe(`merge-${i}`);
      expect(LOOT_CATALOG.find((c) => c.id === drop.itemId)).toBeDefined(); // l'identifiant reste celui du catalogue (le modèle)
    }
  });
});
