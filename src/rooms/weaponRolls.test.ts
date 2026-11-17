import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../paths.js";

/* Les armes uniques : `public/forge/combat.js` tire les valeurs d'une arme dans les fourchettes de sa rareté, de façon déterministe. */
interface Roll {
  type: string; rarity: string; seed: string; dmgMult: number; cdMult: number; bonus: Record<string, number>; lines: Array<{ stat: string; points: number }>; quality: number; label: string; standard: boolean;
}
interface Range { dmg: [number, number]; cd: [number, number]; force: [number, number]; extra: [number, number]; extraPts: [number, number] }
interface Card { damage: number; cooldown: number; dps: number; lines: Array<{ stat: string; points: number }>; quality: number; standard: boolean; name: string }
interface Built {
  bonus: Record<string, number>;
  total: Record<string, number>;
  slots: Record<string, { points: number; lines?: Array<{ stat: string; points: number }> }>;
  weapon: { type: string; training: boolean; spec: { dmg: number; cd: number }; roll: Roll };
  derived: { damage: number; cooldown: number };
}
interface Combat {
  RARITIES: string[];
  RARITY_STAT: Record<string, number>;
  RARITY_DMG: Record<string, number>;
  STAT_IDS: string[];
  WEAPONS: Record<string, { dmg: number; cd: number }>;
  ROLL_RANGES: Record<string, Range>;
  rollWeapon(type: string, rarity: string, seed?: string): Roll | null;
  weaponCard(type: string, rarity: string, seed?: string): Card | null;
  build(opts?: { level?: number; stats?: Record<string, number>; equipment?: { weapon?: { type: string; rarity: string; seed?: string } } }): Built;
}

const context = vm.createContext({});
vm.runInContext(readFileSync(path.join(PROJECT_ROOT, "public", "forge", "combat.js"), "utf8"), context, { filename: "combat.js", timeout: 1000 });
const C = (context as { ForgeCombat?: Combat }).ForgeCombat as Combat;
const roll = (type: string, rarity: string, seed?: string) => C.rollWeapon(type, rarity, seed) as Roll;
const seeds = (n: number) => Array.from({ length: n }, (_, i) => `forge-${i + 1}`);
const TYPES = Object.keys(C.WEAPONS);

describe("armes uniques : des tirages dans des fourchettes", () => {
  it("le même (type, rareté, graine) donne toujours le même tirage ; une autre graine, un autre", () => {
    expect(roll("sword", "epic", "forge-7")).toEqual(roll("sword", "epic", "forge-7"));
    const distinct = new Set(seeds(60).map((s) => JSON.stringify(roll("sword", "epic", s))));
    expect(distinct.size).toBeGreaterThan(40);
    expect(JSON.stringify(roll("sword", "epic", "forge-7"))).not.toBe(JSON.stringify(roll("axe", "epic", "forge-7")));
  });

  it("chaque valeur reste dans la fourchette de sa rareté", () => {
    for (const rarity of C.RARITIES) {
      const rg = C.ROLL_RANGES[rarity]!;
      for (const type of TYPES) for (const seed of seeds(80)) {
        const r = roll(type, rarity, seed);
        expect(r.dmgMult).toBeGreaterThanOrEqual(rg.dmg[0]);
        expect(r.dmgMult).toBeLessThanOrEqual(rg.dmg[1]);
        // cd va de la pire valeur (lente) à la meilleure (rapide) : le minimum et le maximum peuvent être dans un sens ou l'autre
        expect(r.cdMult).toBeGreaterThanOrEqual(Math.min(...rg.cd));
        expect(r.cdMult).toBeLessThanOrEqual(Math.max(...rg.cd));
        const [force, ...extras] = r.lines;
        expect(force!.stat).toBe("force");
        expect(force!.points).toBeGreaterThanOrEqual(rg.force[0]);
        expect(force!.points).toBeLessThanOrEqual(rg.force[1]);
        expect(extras.length).toBeGreaterThanOrEqual(rg.extra[0]);
        expect(extras.length).toBeLessThanOrEqual(rg.extra[1]);
        expect(new Set(extras.map((l) => l.stat)).size).toBe(extras.length); // jamais deux fois la même caractéristique
        for (const l of extras) {
          expect(l.stat).not.toBe("force");
          expect(l.points).toBeGreaterThanOrEqual(rg.extraPts[0]);
          expect(l.points).toBeLessThanOrEqual(rg.extraPts[1]);
        }
        // Le total par caractéristique est cohérent avec les lignes
        expect(Object.values(r.bonus).reduce((a, b) => a + b, 0)).toBe(r.lines.reduce((a, l) => a + l.points, 0));
        expect(r.quality).toBeGreaterThanOrEqual(0);
        expect(r.quality).toBeLessThanOrEqual(1);
      }
    }
  });

  it("de mauvais jets et des jets quasi parfaits existent à chaque rareté", () => {
    for (const rarity of C.RARITIES) {
      const rg = C.ROLL_RANGES[rarity]!, span = rg.dmg[1] - rg.dmg[0];
      const all = seeds(1500).map((s) => roll("sword", rarity, s));
      expect(Math.min(...all.map((r) => r.dmgMult))).toBeLessThan(rg.dmg[0] + 0.05 * span);
      expect(Math.max(...all.map((r) => r.dmgMult))).toBeGreaterThan(rg.dmg[1] - 0.05 * span);
      expect(all.some((r) => r.quality >= 0.8)).toBe(true);
      expect(all.some((r) => r.quality <= 0.25)).toBe(true);
      expect(all.some((r) => r.label === "jet exceptionnel")).toBe(true);
      expect(all.some((r) => r.label === "jet faible")).toBe(true);
    }
  });

  it("les raretés se chevauchent : un bon rare vaut mieux qu'un mauvais épique, mais la moyenne monte avec la rareté", () => {
    const mean = (rarity: string) => seeds(400).reduce((a, s) => a + roll("sword", rarity, s).dmgMult, 0) / 400;
    const means = C.RARITIES.map(mean);
    for (let i = 1; i < means.length; i++) expect(means[i]!).toBeGreaterThan(means[i - 1]!);
    const bestRare = Math.max(...seeds(400).map((s) => roll("sword", "rare", s).dmgMult));
    const worstEpic = Math.min(...seeds(400).map((s) => roll("sword", "epic", s).dmgMult));
    expect(bestRare).toBeGreaterThan(worstEpic);
  });

  it("sans graine, une arme vaut la valeur moyenne de sa rareté, comme avant les tirages", () => {
    for (const rarity of C.RARITIES) {
      const r = roll("sword", rarity);
      expect(r.standard).toBe(true);
      expect(r.dmgMult).toBe(C.RARITY_DMG[rarity]);
      expect(r.cdMult).toBe(1);
      expect(r.bonus.force).toBe(C.RARITY_STAT[rarity]);
    }
  });

  it("un type ou une rareté inconnus ne donnent rien (jamais d'objet venu du navigateur pris tel quel)", () => {
    expect(C.rollWeapon("lasergun", "rare", "forge-1")).toBeNull();
    expect(C.rollWeapon("sword", "mythic", "forge-1")).toBeNull();
    expect(C.rollWeapon("constructor", "rare", "forge-1")).toBeNull();
    expect(C.rollWeapon("__proto__", "rare", "forge-1")).toBeNull();
    expect(C.weaponCard("lasergun", "rare", "x")).toBeNull();
  });
});

describe("armes uniques : effet sur le forgeron", () => {
  it("deux armes du même modèle mais de graines différentes ne donnent pas le même forgeron", () => {
    const built = seeds(30).map((seed) => C.build({ level: 5, equipment: { weapon: { type: "spear", rarity: "epic", seed } } }));
    expect(new Set(built.map((b) => b.derived.damage)).size).toBeGreaterThan(5);
    expect(new Set(built.map((b) => JSON.stringify(b.bonus))).size).toBeGreaterThan(5);
  });

  it("les dégâts et la cadence suivent le tirage, les points de l'arme s'ajoutent aux caractéristiques", () => {
    for (const seed of seeds(20)) {
      const b = C.build({ level: 5, stats: { force: 2, agilite: 1, vitalite: 0, chance: 0 }, equipment: { weapon: { type: "axe", rarity: "legendary", seed } } });
      const r = b.weapon.roll, force = 2 + r.bonus.force!, agi = 1 + r.bonus.agilite!;
      expect(b.total.force).toBe(force);
      expect(b.total.agilite).toBe(agi);
      expect(b.derived.damage).toBe(Math.round(C.WEAPONS.axe!.dmg * r.dmgMult * (1 + 0.06 * force) * 10) / 10);
      expect(b.derived.cooldown).toBe(Math.round(((C.WEAPONS.axe!.cd * r.cdMult) / (1 + 0.01 * agi)) * 1000) / 1000);
      expect(b.slots.weapon!.lines).toEqual(r.lines);
    }
  });

  it("une arme sans graine se comporte comme avant : dégâts x rareté, points de Force de la rareté", () => {
    for (const rarity of C.RARITIES) {
      const b = C.build({ level: 1, equipment: { weapon: { type: "sword", rarity } } });
      expect(b.bonus.force).toBe(C.RARITY_STAT[rarity]);
      expect(b.derived.damage).toBe(Math.round(C.WEAPONS.sword!.dmg * C.RARITY_DMG[rarity]! * (1 + 0.06 * C.RARITY_STAT[rarity]!) * 10) / 10);
    }
  });

  it("sans arme : l'épée d'entraînement, sans bonus", () => {
    const b = C.build({ level: 1 });
    expect(b.weapon.training).toBe(true);
    expect(Object.values(b.bonus).every((v) => v === 0)).toBe(true);
    expect(b.derived.damage).toBe(C.WEAPONS.sword!.dmg);
  });

  it("la fiche d'une arme (pour comparer) est cohérente avec son tirage", () => {
    const r = roll("dagger", "rare", "forge-12"), card = C.weaponCard("dagger", "rare", "forge-12")!;
    expect(card.damage).toBe(Math.round(C.WEAPONS.dagger!.dmg * r.dmgMult * 10) / 10);
    expect(card.cooldown).toBe(Math.round(C.WEAPONS.dagger!.cd * r.cdMult * 1000) / 1000);
    expect(card.dps).toBe(Math.round((card.damage / card.cooldown) * 10) / 10);
    expect(card.lines).toEqual(r.lines);
    expect(card.standard).toBe(false);
  });
});
