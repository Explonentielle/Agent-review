import { describe, expect, it } from "vitest";
import { computeHero, levelFor, xpForLevel, type HeroInput } from "./hero.js";

const empty: HeroInput = { forges: [], claudeConnected: false, projects: 0, devProjects: 0, reviews: {}, tasks: {} };

describe("la forge : héros, niveaux et quêtes déduits de l'état réel", () => {
  it("un outil neuf : apprenti de niveau 1, aucune quête faite, la première est d'allumer une forge", () => {
    const hero = computeHero(empty);
    expect(hero.xp).toBe(0);
    expect(hero.level).toBe(1);
    expect(hero.title).toBe("Apprenti forgeron");
    expect(hero.heroClass).toBe("Forgeron");
    expect(hero.specialty).toBe("Novice");
    expect(hero.nextQuest).toBe("forge");
    expect(hero.quests.every((q) => !q.done)).toBe(true);
    expect(hero.achievements.every((a) => !a.unlocked)).toBe(true);
    expect(hero.percent).toBe(0);
  });

  it("les règles d'XP affichées viennent des mêmes valeurs que le calcul", () => {
    const rules = computeHero(empty).rules;
    expect(rules.length).toBe(8);
    expect(rules[0]).toContain("+50");
    expect(rules[1]).toContain("+100");
    expect(rules[5]).toContain("+40");
  });

  it("l'XP bonus des maîtrises s'ajoute à l'XP du héros et le fait monter de niveau", () => {
    const base = computeHero(empty);
    const boosted = computeHero({ ...empty, bonusXp: 150 });
    expect(boosted.xp).toBe(base.xp + 150);
    expect(boosted.level).toBe(3);
  });

  it("les seuils de niveau sont quadratiques et sans trou", () => {
    expect([1, 2, 3, 4, 5].map(xpForLevel)).toEqual([0, 50, 150, 300, 500]);
    expect([0, 49, 50, 149, 150, 299, 300].map(levelFor)).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect(levelFor(10_000_000)).toBe(99);
  });

  it("un outil bien en route : l'XP vient de chaque action, avec le niveau, le titre et la progression", () => {
    const hero = computeHero({
      forges: ["github", "gitlab"], // 2 x 50
      claudeConnected: true, // 100
      projects: 3, // 3 x 20
      devProjects: 1, // 30
      reviews: { approved: 2, needs_human: 1, error: 4 }, // 3 terminées x 10, 2 publiées x 5 ; les erreurs ne comptent pas
      tasks: { mr_created: 2, blocked: 1, error: 3 }, // 2 pièces x 40, 1 question x 5
    });
    expect(hero.xp).toBe(100 + 100 + 60 + 30 + 30 + 10 + 80 + 5);
    expect(hero.level).toBe(4);
    expect(hero.title).toBe("Compagnon forgeron");
    expect(hero.levelXp).toBe(115);
    expect(hero.levelSize).toBe(200);
    expect(hero.percent).toBe(58);
    expect(hero.specialty).toBe("Contrôleur de lames"); // 3 reviews pour 2 pièces forgées
  });

  it("la spécialité suit l'activité dominante", () => {
    expect(computeHero({ ...empty, reviews: { published: 3 } }).specialty).toBe("Contrôleur de lames");
    expect(computeHero({ ...empty, tasks: { mr_created: 3 } }).specialty).toBe("Maître d'œuvre");
  });

  it("les petites actions sont plafonnées : on ne monte pas en ajoutant des projets à la chaîne", () => {
    const many = computeHero({ ...empty, forges: ["a", "b", "c", "d"], projects: 500, devProjects: 500, tasks: { blocked: 500 } });
    expect(many.xp).toBe(2 * 50 + 5 * 20 + 3 * 30 + 10 * 5);
  });

  it("les quêtes se cochent d'après l'état réel et la suivante avance", () => {
    expect(computeHero({ ...empty, forges: ["github"] }).nextQuest).toBe("claude");
    const afterClaude = computeHero({ ...empty, forges: ["github"], claudeConnected: true });
    expect(afterClaude.nextQuest).toBe("project");
    const done = computeHero({ forges: ["github"], claudeConnected: true, projects: 1, devProjects: 1, reviews: { auto_ok: 1 }, tasks: { running: 1 } });
    expect(done.quests.map((q) => q.done)).toEqual([true, true, true, true, true, true]);
    expect(done.nextQuest).toBeNull();
  });

  it("les hauts faits se débloquent aux bons seuils", () => {
    const unlocked = (input: HeroInput) => computeHero(input).achievements.filter((a) => a.unlocked).map((a) => a.id);
    expect(unlocked({ ...empty, forges: ["github", "gitlab"] })).toEqual(["first_forge", "two_forges"]);
    expect(unlocked({ ...empty, reviews: { approved: 9 } })).toEqual(["first_review"]);
    expect(unlocked({ ...empty, reviews: { approved: 10 } })).toEqual(["first_review", "ten_reviews"]);
    expect(unlocked({ ...empty, tasks: { mr_updated: 5, blocked: 1 } })).toEqual(["first_piece", "five_pieces", "curious"]);
  });
});
