import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../paths.js";

/* Vagues sans fin : après la 5e, des vagues calculées sans hasard, un boss toutes les 5 vagues, de nouveaux ennemis. La campagne de 5 vagues reste identique. */
interface Bot { type: string; hp: number; maxHp: number; alive: boolean; dying: number; spawnT: number; rush: unknown }
interface Fight {
  hero: { hp: number; maxHp: number };
  bots: Bot[];
  shots: unknown[];
  state: string;
  wave: number;
  cleared: number;
  step(input?: Record<string, boolean>, dt?: number): void;
  hud(): { waves: number; boss: boolean; waveName: string; next: number; endless: boolean };
  result(): { state: string; cleared: number; endless: boolean; gold: number };
}
interface Wave { name: string; bots: string[]; boss?: boolean }
interface Combat {
  WAVES: Wave[];
  BOTS: Record<string, { weapon: string; rarity: string; hp: number; speed: number; boss?: boolean; ranged?: boolean }>;
  WEAPONS: Record<string, unknown>;
  RARITIES: string[];
  BOSS_ORDER: string[];
  waveFor(n: number): Wave;
  reward(result: { state: string; cleared: number; endless?: boolean }): number;
  create(opts?: { level?: number; endless?: boolean; seed?: number }): Fight;
}

const context = vm.createContext({});
vm.runInContext(readFileSync(path.join(PROJECT_ROOT, "public", "forge", "combat.js"), "utf8"), context, { filename: "combat.js", timeout: 1000 });
const C = (context as { ForgeCombat?: Combat }).ForgeCombat as Combat;
const COST: Record<string, number> = { gobelin: 1, soldat: 1.6, archer: 1.8, assassin: 1.5, mage: 2.2, brute: 3 };

/** Fait passer les vagues très vite : chaque bot apparu est retiré, et on note ce qui est apparu à chaque numéro de vague. */
function runWaves(f: Fight, last: number): Record<number, string[]> {
  const seen: Record<number, string[]> = {};
  for (let i = 0; i < 20000 && f.wave <= last && f.state !== "won" && f.state !== "lost"; i++) {
    f.hero.hp = f.hero.maxHp = 1e6;
    f.step({}, 0.05);
    if (f.wave > 0 && !seen[f.wave] && f.bots.length) seen[f.wave] = f.bots.map((b) => b.type);
    if (f.state === "fighting") for (const b of f.bots) if (b.spawnT <= 0 && b.alive) { b.alive = false; b.dying = 0; }
  }
  return seen;
}

/** Joue en accéléré jusqu'à l'arrivée de la vague n : celles d'avant sont balayées. */
function advanceTo(f: Fight, n: number): void {
  for (let i = 0; i < 40000 && f.wave < n; i++) {
    f.hero.hp = f.hero.maxHp = 1e6;
    f.step({}, 0.05);
    if (f.state === "fighting" && f.wave < n) for (const b of f.bots) if (b.spawnT <= 0 && b.alive) { b.alive = false; b.dying = 0; }
  }
}

describe("vagues sans fin : la composition", () => {
  it("les cinq premières vagues sont celles de la campagne, et le même numéro donne toujours la même vague", () => {
    for (let n = 1; n <= 5; n++) expect(C.waveFor(n)).toEqual(C.WAVES[n - 1]);
    for (let n = 1; n <= 60; n++) expect(C.waveFor(n)).toEqual(C.waveFor(n));
  });

  it("une vague sur cinq est un boss seul (Seigneur, Colosse, Archimage, puis on recommence) ; les autres sont des groupes", () => {
    expect(C.BOSS_ORDER).toEqual(["seigneur", "colosse", "archimage"]);
    for (let n = 5; n <= 90; n += 5) {
      const w = C.waveFor(n);
      expect(w.boss).toBe(true);
      expect(w.bots).toEqual([C.BOSS_ORDER[(n / 5 - 1) % 3]]);
      expect(C.BOTS[w.bots[0]!]!.boss).toBe(true);
    }
    for (let n = 6; n <= 90; n++) if (n % 5 !== 0) {
      const w = C.waveFor(n);
      expect(w.boss).toBeUndefined();
      expect(w.bots.length).toBeGreaterThanOrEqual(2);
      expect(w.bots.length).toBeLessThanOrEqual(10);
    }
  });

  it("les groupes n'utilisent que des bots connus (jamais un boss), dans un budget qui grandit avec le numéro", () => {
    const power = (n: number) => C.waveFor(n).bots.reduce((a, t) => a + C.BOTS[t]!.hp, 0);
    for (let n = 6; n <= 100; n++) {
      if (n % 5 === 0) continue;
      const w = C.waveFor(n);
      let cost = 0;
      for (const t of w.bots) { expect(COST[t], `${t} (vague ${n})`).toBeDefined(); cost += COST[t]!; }
      expect(cost).toBeLessThanOrEqual(3 + 1.5 * n + 1e-9);
    }
    const avg = (from: number, to: number) => { let s = 0, c = 0; for (let n = from; n <= to; n++) if (n % 5) { s += power(n); c++; } return s / c; };
    expect(avg(26, 30)).toBeGreaterThan(avg(6, 9));
  });

  it("tous les types de bots, dont les nouveaux, ont une arme et une rareté qui existent", () => {
    for (const [type, spec] of Object.entries(C.BOTS)) {
      expect(C.WEAPONS[spec.weapon], type).toBeDefined();
      expect(C.RARITIES).toContain(spec.rarity);
    }
    expect(C.BOTS.assassin!.speed).toBeGreaterThan(C.BOTS.gobelin!.speed);
    expect(C.BOTS.assassin!.hp).toBeLessThan(C.BOTS.soldat!.hp);
    expect(C.BOTS.colosse!.boss && C.BOTS.archimage!.boss && C.BOTS.archimage!.ranged).toBe(true);
  });
});

describe("vagues sans fin : le combat", () => {
  it("sans fin, la partie continue après le seigneur ; aucune victoire finale", () => {
    const f = C.create({ level: 5, endless: true, seed: 11 });
    const seen = runWaves(f, 12);
    expect(f.state).not.toBe("won");
    expect(f.wave).toBeGreaterThan(11);
    expect(seen[5]).toEqual(["seigneur"]);
    expect(seen[10]).toEqual(["colosse"]);
    expect(seen[6]!.length).toBeGreaterThanOrEqual(2);
    expect(f.hud().waves).toBe(0); // 0 : pas de dernière vague
    expect(f.hud().endless).toBe(true);
  });

  it("la campagne (sans l'option) finit toujours en victoire à la 5e vague", () => {
    const f = C.create({ level: 5, seed: 11 });
    runWaves(f, 8);
    expect(f.state).toBe("won");
    expect(f.cleared).toBe(5);
    expect(f.hud().waves).toBe(5);
    expect(f.result().endless).toBe(false);
  });

  it("le HUD annonce un boss les vagues 5, 10 et 15", () => {
    const f = C.create({ level: 5, endless: true, seed: 4 });
    const flags: Record<number, boolean> = {};
    for (let i = 0; i < 20000 && f.wave <= 15; i++) {
      f.hero.hp = f.hero.maxHp = 1e6;
      f.step({}, 0.05);
      if (f.wave > 0) flags[f.wave] = f.hud().boss;
      if (f.state === "fighting") for (const b of f.bots) if (b.spawnT <= 0 && b.alive) { b.alive = false; b.dying = 0; }
    }
    expect([flags[4], flags[5], flags[9], flags[10], flags[14], flags[15]]).toEqual([false, true, false, true, false, true]);
  });

  it("les ennemis montent en puissance, plus vite encore au-delà de la 5e vague", () => {
    const ratio = (wave: number) => { const f = C.create({ level: 1, endless: true, seed: 2 }); advanceTo(f, wave); const boss = f.bots[0]!; return boss.maxHp / C.BOTS[boss.type]!.hp; };
    const w5 = ratio(5), w10 = ratio(10), w20 = ratio(20); // les vagues 5, 10 et 20 sont des boss : un seul bot, facile à lire
    expect(w5).toBeCloseTo(1 + 0.06 * 4, 1); // la campagne : inchangée
    expect(w10).toBeGreaterThan(w5);
    expect(w20 - w10).toBeGreaterThan(w10 - w5); // la hausse s'accélère
  });

  it("l'Archimage tire de loin au lieu de charger", () => {
    const f = C.create({ level: 3, endless: true, seed: 8 });
    advanceTo(f, 15);
    expect(f.bots.map((b) => b.type)).toEqual(["archimage"]);
    let shots = 0, rush = false;
    for (let i = 0; i < 160; i++) {
      f.hero.hp = f.hero.maxHp = 1e6;
      f.step({}, 0.05);
      shots = Math.max(shots, f.shots.length);
      if (f.bots.some((b) => b.rush)) rush = true;
    }
    expect(rush).toBe(false);
    expect(shots).toBeGreaterThan(0);
  });
});

describe("vagues sans fin : l'or", () => {
  it("sans fin : l'or de chaque vague terminée, plus 25 par boss vaincu ; la campagne ne change pas", () => {
    const base = (cleared: number) => { let g = 0; for (let w = 1; w <= cleared; w++) g += 3 + 2 * w; return g; };
    expect(C.reward({ state: "lost", cleared: 10, endless: true })).toBe(base(10) + 25 * 2);
    expect(C.reward({ state: "retreat", cleared: 4, endless: true })).toBe(base(4)); // pas encore de boss
    expect(C.reward({ state: "lost", cleared: 5, endless: false })).toBe(base(5)); // campagne : pas de prime
    expect(C.reward({ state: "won", cleared: 5 })).toBe(base(5) + 25); // 70 or, comme avant
  });
});
