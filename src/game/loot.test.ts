import { describe, expect, it } from "vitest";
import { LOOT_CATALOG, RARITIES, computeDrops, lootEvents, rarityWeights, rollDrop, seededRandom, type LootEvent } from "./loot.js";

const event = (id: string, kind: LootEvent["kind"], quality: LootEvent["quality"] = "common", at = "2026-11-16 10:00:00"): LootEvent => ({ id, kind, at, quality });

/** Proportion de chaque rareté sur `n` événements d'un genre, en pourcentage. */
function distribution(kind: LootEvent["kind"], quality: LootEvent["quality"], n = 4000) {
  const counts = { common: 0, rare: 0, epic: 0, legendary: 0 };
  let none = 0;
  for (let i = 0; i < n; i++) {
    const drop = rollDrop(event(`${kind}-${quality}-${i}`, kind, quality));
    if (drop) counts[drop.rarity]++;
    else none++;
  }
  const pct = (v: number) => (v * 100) / n;
  return { common: pct(counts.common), rare: pct(counts.rare), epic: pct(counts.epic), legendary: pct(counts.legendary), none: pct(none) };
}

describe("le catalogue du butin", () => {
  it("des identifiants uniques, et chaque rareté a des tenues et des armes à gagner", () => {
    expect(new Set(LOOT_CATALOG.map((i) => i.id)).size).toBe(LOOT_CATALOG.length);
    for (const rarity of RARITIES) {
      expect(LOOT_CATALOG.some((i) => i.rarity === rarity && i.kind === "cosmetic")).toBe(true);
      expect(LOOT_CATALOG.some((i) => i.rarity === rarity && i.kind === "weapon")).toBe(true);
    }
  });

  it("une tenue dit où elle se porte, une arme quel type elle est, et les noms d'armes sont accordés", () => {
    for (const i of LOOT_CATALOG) {
      if (i.kind === "cosmetic") expect(i.part && i.value).toBeTruthy();
      else expect(i.weapon).toBeTruthy();
    }
    const name = (id: string) => LOOT_CATALOG.find((i) => i.id === id)!.name;
    expect(name("weapon-sword-common")).toBe("Épée rouillée");
    expect(name("weapon-hammer-common")).toBe("Marteau rouillé");
    expect(name("weapon-bow-legendary")).toBe("Arc mythique");
    expect(name("weapon-axe-rare")).toBe("Hache d'acier");
  });
});

describe("le hasard déterministe", () => {
  it("la même graine donne la même suite ; une autre graine, une autre suite ; toujours entre 0 et 1", () => {
    const a = seededRandom("forge-12");
    const b = seededRandom("forge-12");
    const suite = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(suite);
    expect(Array.from({ length: 5 }, ((c) => () => c())(seededRandom("forge-13")))).not.toEqual(suite);
    const r = seededRandom("x");
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v >= 0 && v < 1).toBe(true);
    }
  });

  it("le tirage d'un événement est toujours le même (recharger ne change rien, relancer non plus)", () => {
    const e = event("forge-42", "forge", "rare");
    expect(rollDrop(e)).toEqual(rollDrop(e));
    expect(rollDrop(e)!.itemId).toBe(rollDrop({ ...e })!.itemId);
  });
});

describe("les chances", () => {
  it("les poids totalisent toujours 100 et restent positifs, pour chaque événement et chaque qualité", () => {
    for (const kind of ["forge", "review", "merge"] as const) {
      for (const q of RARITIES) {
        const w = rarityWeights(kind, q);
        expect(w.reduce((a, b) => a + b, 0)).toBe(100);
        expect(w.every((x) => x > 0)).toBe(true);
      }
    }
  });

  it("une meilleure pièce et une fusion donnent de meilleures chances", () => {
    expect(rarityWeights("forge", "legendary")[3]).toBeGreaterThan(rarityWeights("forge", "common")[3]);
    expect(rarityWeights("forge", "legendary")[0]).toBeLessThan(rarityWeights("forge", "common")[0]);
    expect(rarityWeights("merge", "common")[3]).toBeGreaterThan(rarityWeights("forge", "common")[3]);
  });

  it("sur beaucoup d'événements, la répartition suit les poids (forge, pièce commune : 55 / 30 / 11 / 4)", () => {
    const d = distribution("forge", "common");
    expect(Math.abs(d.common - 55)).toBeLessThan(3);
    expect(Math.abs(d.rare - 30)).toBeLessThan(3);
    expect(Math.abs(d.epic - 11)).toBeLessThan(2.5);
    expect(Math.abs(d.legendary - 4)).toBeLessThan(2);
    expect(d.none).toBe(0); // une pièce forgée rapporte toujours quelque chose
  });

  it("une review rapporte quelque chose une fois sur deux ; une fusion toujours, avec plus de raretés", () => {
    const review = distribution("review", "common");
    expect(Math.abs(review.none - 50)).toBeLessThan(4);
    const merge = distribution("merge", "common");
    expect(merge.none).toBe(0);
    expect(merge.common).toBeLessThan(distribution("forge", "common").common);
    expect(merge.legendary).toBeGreaterThan(distribution("forge", "common").legendary);
  });

  it("environ un tiers des objets sont des armes, le reste des tenues", () => {
    let weapons = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) {
      const drop = rollDrop(event(`forge-${i}`, "forge"))!;
      if (LOOT_CATALOG.find((c) => c.id === drop.itemId)!.kind === "weapon") weapons++;
    }
    expect(Math.abs((weapons * 100) / n - 35)).toBeLessThan(4);
  });

  it("l'objet tiré existe toujours au catalogue et a la rareté annoncée", () => {
    for (let i = 0; i < 500; i++) {
      const drop = rollDrop(event(`merge-${i}`, "merge", RARITIES[i % 4]))!;
      expect(LOOT_CATALOG.find((c) => c.id === drop.itemId)?.rarity).toBe(drop.rarity);
    }
  });
});

describe("l'activité réelle qui rapporte du butin", () => {
  const task = (id: number, status: string, over: Record<string, unknown> = {}) => ({ id, status, files_changed: 2, num_turns: 10, mode: "new" as const, updated_at: `2026-11-1${id} 10:00:00`, ...over });

  it("une pièce forgée, une review terminée et une fusion : trois sources ; un échec, une question ou une review en cours : rien", () => {
    const events = lootEvents({
      tasks: [task(1, "mr_created"), task(2, "error"), task(3, "blocked"), task(4, "mr_updated"), task(5, "running")],
      reviews: [{ id: 1, status: "auto_ok", updated_at: "2026-11-20 10:00:00" }, { id: 2, status: "running", updated_at: "2026-11-20 11:00:00" }, { id: 3, status: "error", updated_at: "2026-11-20 12:00:00" }],
      mergedTaskIds: [1, 2],
    });
    expect(events.map((e) => e.id).sort()).toEqual(["forge-1", "forge-4", "merge-1", "review-1"]); // la fusion d'une tâche en échec ne compte pas
  });

  it("la qualité de la pièce vient de sa note (travail large et direct = meilleure qualité)", () => {
    const [big] = lootEvents({ tasks: [task(1, "mr_created", { files_changed: 20, num_turns: 5, mode: "followup" })], reviews: [], mergedTaskIds: [] });
    const [small] = lootEvents({ tasks: [task(2, "mr_created", { files_changed: 0, num_turns: 80 })], reviews: [], mergedTaskIds: [] });
    expect(big!.quality).toBe("legendary");
    expect(small!.quality).toBe("common");
  });

  it("le butin d'un historique est toujours le même, et un événement de plus ne change pas le butin des précédents", () => {
    const input = { tasks: [task(1, "mr_created"), task(2, "mr_created")], reviews: [{ id: 1, status: "approved", updated_at: "2026-11-20 10:00:00" }], mergedTaskIds: [1] };
    const before = computeDrops(input);
    expect(computeDrops(input)).toEqual(before);
    const after = computeDrops({ ...input, tasks: [...input.tasks, task(3, "mr_created")] });
    for (const drop of before) expect(after).toContainEqual(drop);
    expect(after.length).toBe(before.length + 1);
  });

  it("un historique vide ne rapporte rien", () => {
    expect(computeDrops({ tasks: [], reviews: [], mergedTaskIds: [] })).toEqual([]);
  });
});
