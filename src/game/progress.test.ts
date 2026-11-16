import { describe, expect, it } from "vitest";
import { computePrestige, computeProgress, type ProgressInput } from "./progress.js";

/** Mercredi 11 novembre 2026, 12:00 UTC (un jour qui n'est ni un lundi ni un dimanche). */
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const DAY = 86_400_000;
const stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const ago = (days: number, hours = 0): string => stamp(NOW - days * DAY - hours * 3_600_000);

const base = (over: Partial<ProgressInput> = {}): ProgressInput => ({
  now: NOW,
  tzOffsetMin: 0,
  tasks: [],
  reviews: [],
  totals: { forged: 0, reviews: 0 },
  pieceGrades: [],
  weaponLevels: [1],
  ...over,
});
const forged = (updated: string, created = updated) => ({ status: "mr_created", created_at: created, updated_at: updated });

describe("la série de jours", () => {
  it("sans activité, pas de série", () => {
    expect(computeProgress(base()).streak).toEqual({ current: 0, best: 0, activeToday: false, atRisk: false });
  });

  it("compte les jours de suite, et survit jusqu'à la fin de la journée avant de s'éteindre", () => {
    const tasks = [forged(ago(1)), forged(ago(2)), forged(ago(3))];
    const streak = computeProgress(base({ tasks })).streak;
    expect(streak).toMatchObject({ current: 3, best: 3, activeToday: false, atRisk: true });
    const withToday = computeProgress(base({ tasks: [...tasks, forged(ago(0, 1))] })).streak;
    expect(withToday).toMatchObject({ current: 4, activeToday: true, atRisk: false });
  });

  it("un jour sans rien casse la série en cours mais pas le record", () => {
    const tasks = [forged(ago(0, 1)), forged(ago(1)), forged(ago(4)), forged(ago(5)), forged(ago(6)), forged(ago(7))];
    expect(computeProgress(base({ tasks })).streak).toMatchObject({ current: 2, best: 4, atRisk: false });
    expect(computeProgress(base({ tasks: [forged(ago(3)), forged(ago(4))] })).streak.current).toBe(0);
  });

  it("le fuseau décide du jour : 23h30 UTC est déjà demain à Paris, mais encore aujourd'hui à New York", () => {
    const late = stamp(Date.UTC(2026, 10, 11, 23, 30, 0));
    const at = Date.UTC(2026, 10, 12, 0, 10, 0);
    const paris = computeProgress(base({ now: at, tzOffsetMin: -60, tasks: [forged(late)] })).streak;
    expect(paris.activeToday).toBe(true); // 00:10 UTC = 01:10 à Paris, le 12 ; 23:30 UTC = 00:30 le 12 : même jour
    const newYork = computeProgress(base({ now: at, tzOffsetMin: 300, tasks: [forged(late)] })).streak;
    expect(newYork.activeToday).toBe(true); // 19:10 le 11 et 18:30 le 11 : même jour aussi
    const split = computeProgress(base({ now: at, tzOffsetMin: -60, tasks: [forged(stamp(Date.UTC(2026, 10, 11, 21, 0, 0)))] })).streak;
    expect(split).toMatchObject({ activeToday: false, atRisk: true }); // 22:00 à Paris le 11, hier
  });

  it("les reviews terminées comptent, pas celles en attente ou en erreur", () => {
    const reviews = [{ status: "published", created_at: ago(0, 2), updated_at: ago(0, 1) }, { status: "error", created_at: ago(1), updated_at: ago(1) }, { status: "queued", created_at: ago(1), updated_at: ago(1) }];
    expect(computeProgress(base({ reviews })).streak).toMatchObject({ current: 1, best: 1 });
  });
});

describe("les missions", () => {
  it("trois missions du jour distinctes, qui changent d'un jour à l'autre", () => {
    const today = computeProgress(base()).daily;
    expect(new Set(today.map((m) => m.id)).size).toBe(3);
    const tomorrow = computeProgress(base({ now: NOW + DAY })).daily;
    expect(tomorrow.map((m) => m.id).join() === today.map((m) => m.id).join()).toBe(false);
    expect(tomorrow[0]!.period === today[0]!.period).toBe(false);
  });

  it("une mission se remplit avec l'activité d'aujourd'hui seulement, et plafonne à sa cible", () => {
    // Sur six jours de suite, le tirage fait passer toutes les missions « forge » : chacune voit quatre pièces (pas celle d'hier), jamais plus que sa cible.
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const day = NOW + i * DAY;
      const sameDayTasks = Array.from({ length: 4 }, (_, k) => forged(stamp(day - (k + 1) * 3_600_000))).concat([forged(stamp(day - DAY))]);
      for (const m of computeProgress(base({ tasks: sameDayTasks, now: day })).daily.filter((x) => x.id.startsWith("forge"))) { expect(m.progress).toBe(Math.min(m.target, 4)); seen.push(m.id); }
    }
    expect(seen.length > 0).toBe(true);
  });

  it("le coffre s'ouvre quand les trois missions du jour sont faites", () => {
    // Une journée très chargée : 6 pièces, 6 reviews, 6 tâches lancées. Toutes les missions du pool sont remplies, quel que soit le tirage.
    const tasks = Array.from({ length: 6 }, (_, i) => forged(ago(0, i + 1)));
    const reviews = Array.from({ length: 6 }, (_, i) => ({ status: "approved", created_at: ago(0, i + 1), updated_at: ago(0, i + 1) }));
    const p = computeProgress(base({ tasks, reviews }));
    expect(p.daily.every((m) => m.done)).toBe(true);
    expect(p.chest).toMatchObject({ done: true, progress: 3, target: 3 });
    expect(computeProgress(base()).chest).toMatchObject({ done: false, progress: 0 });
  });

  it("les missions de la semaine repartent chaque lundi", () => {
    // NOW est un mercredi : lundi et mardi sont dans la semaine, le dimanche d'avant non.
    const tasks = [forged(ago(0, 1)), forged(ago(1)), forged(ago(2)), forged(ago(3)), forged(ago(4))];
    const weekly = computeProgress(base({ tasks })).weekly;
    expect(weekly.find((m) => m.id === "forge5")).toMatchObject({ progress: 3, target: 5, done: false });
    expect(weekly.find((m) => m.id === "days4")).toMatchObject({ progress: 3, done: false });
    const nextWeek = computeProgress(base({ tasks, now: NOW + 7 * DAY })).weekly;
    expect(nextWeek.find((m) => m.id === "forge5")!.progress).toBe(0);
    expect(nextWeek[0]!.period === weekly[0]!.period).toBe(false);
  });

  it("la réclamation d'une mission est liée à sa période : id@jour", () => {
    const p = computeProgress(base());
    expect(new Set(p.daily.map((m) => m.period)).size).toBe(1);
    expect(p.daily[0]!.period).toBe(String(Math.floor(NOW / DAY)));
  });
});

describe("les maîtrises", () => {
  it("chaque palier franchi donne de l'XP bonus, une seule fois", () => {
    const p = computeProgress(base({ totals: { forged: 10, reviews: 1 } }));
    const forgedLadder = p.masteries.find((m) => m.id === "forged")!;
    expect(forgedLadder).toMatchObject({ value: 10, reached: 3 });
    expect(forgedLadder.next).toEqual({ at: 25, xp: 150, done: false });
    expect(p.masteries.find((m) => m.id === "reviews")!.reached).toBe(1);
    expect(p.bonusXp).toBe(20 + 40 + 80 + 15);
  });

  it("les raretés et le niveau d'arme ont leurs paliers", () => {
    const p = computeProgress(base({ pieceGrades: ["common", "epic", "legendary", "rare"], weaponLevels: [2, 6] }));
    expect(p.masteries.find((m) => m.id === "epics")).toMatchObject({ value: 2, reached: 1 });
    expect(p.masteries.find((m) => m.id === "legends")).toMatchObject({ value: 1, reached: 1 });
    expect(p.masteries.find((m) => m.id === "weapon")).toMatchObject({ value: 6, reached: 2 });
  });

  it("la meilleure série de jours est une maîtrise", () => {
    const tasks = [forged(ago(0, 1)), forged(ago(1)), forged(ago(2))];
    expect(computeProgress(base({ tasks })).masteries.find((m) => m.id === "streak")).toMatchObject({ value: 3, reached: 1 });
  });

  it("sans arme, le niveau d'arme vaut 1 et rien ne plante", () => {
    expect(computeProgress(base({ weaponLevels: [] })).masteries.find((m) => m.id === "weapon")!.value).toBe(1);
  });
});

describe("le prestige", () => {
  it("le rang suit le niveau, avec son bonus d'or et son halo", () => {
    expect(computePrestige(1, 0).rank).toMatchObject({ id: "iron", goldBonusPct: 0, aura: null });
    expect(computePrestige(3, 200).rank.id).toBe("iron");
    expect(computePrestige(4, 300).rank).toMatchObject({ id: "bronze", goldBonusPct: 5, aura: "#c9803a" });
    expect(computePrestige(12, 3300).rank.id).toBe("gold");
    expect(computePrestige(25, 15000).rank).toMatchObject({ id: "orichalcum", goldBonusPct: 30 });
  });

  it("dit ce qu'il reste pour le rang suivant", () => {
    const p = computePrestige(2, 100);
    expect(p.next).toEqual({ name: "Bronze", level: 4, levelsLeft: 2, xpLeft: 300 - 100 });
    expect(p.stars).toBe(0);
  });

  it("au dernier rang, une étoile tous les dix niveaux", () => {
    expect(computePrestige(34, 0)).toMatchObject({ stars: 0, next: { name: "Étoile 1", level: 35, levelsLeft: 1 } });
    expect(computePrestige(35, 0)).toMatchObject({ stars: 1, next: { name: "Étoile 2", level: 45 } });
    expect(computePrestige(25, 0).ranks.every((r) => r.reached)).toBe(true);
  });
});
