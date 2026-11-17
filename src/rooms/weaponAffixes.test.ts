import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../paths.js";

/* Les effets spéciaux des armes uniques (brûlure, recul, vol de vie, givre, étourdissement, foudre, précision) : tirés selon la rareté, appliqués en combat. */
interface Affix { id: string; name: string; value: number; text: string }
interface Roll { affixes: Affix[]; epithet: string; quality: number; bonus: Record<string, number> }
interface Bot { x: number; y: number; hp: number; maxHp: number; alive: boolean; stun: number; cd: number; slowT: number; slowMult: number; kb: unknown; burn: { dps: number; t: number } | null; spawnT: number; windup: number; r: number }
interface Fight {
  hero: { x: number; y: number; hp: number; maxHp: number; face: number[]; inv: number };
  bots: Bot[];
  fx: Array<{ kind: string }>;
  step(input?: { attack?: boolean }, dt?: number): void;
}
interface Combat {
  STEP: number;
  AFFIXES: Record<string, { name: string; range: [number, number] }>;
  RARITIES: string[];
  rollWeapon(type: string, rarity: string, seed?: string): Roll;
  build(opts?: { level?: number; stats?: Record<string, number>; equipment?: { weapon?: { type: string; rarity: string; seed?: string } } }): { derived: { crit: number } };
  create(opts?: { level?: number; equipment?: { weapon?: { type: string; rarity: string; seed?: string } }; seed?: number }): Fight;
}

const context = vm.createContext({});
vm.runInContext(readFileSync(path.join(PROJECT_ROOT, "public", "forge", "combat.js"), "utf8"), context, { filename: "combat.js", timeout: 1000 });
const C = (context as { ForgeCombat?: Combat }).ForgeCombat as Combat;
const COUNT: Record<string, number> = { common: 0, rare: 1, epic: 2, legendary: 3 };
const TIER: Record<string, number> = { common: 1, rare: 0.85, epic: 1, legendary: 1.2 };

/** Cherche une graine de sabre légendaire dont les effets répondent au critère (le tirage est déterministe : la graine trouvée est toujours la même). */
function seedWith(has: string | null, without: string | null = null): string {
  for (let i = 1; i < 20000; i++) {
    const ids = C.rollWeapon("sword", "legendary", `test-${i}`).affixes.map((a) => a.id);
    if ((has === null || ids.includes(has)) && (without === null || !ids.includes(without))) return `test-${i}`;
  }
  throw new Error(`aucune graine trouvée pour ${has}`);
}
const affix = (seed: string, id: string): Affix => C.rollWeapon("sword", "legendary", seed).affixes.find((a) => a.id === id)!;

/** Un duel de laboratoire : le forgeron face à un bot solide et immobile (assommé), les autres bots loin, assommés. Le sabre frappe vers la droite. */
function lab(seed: string, opts: { stunned?: boolean } = {}) {
  const f = C.create({ level: 1, equipment: { weapon: { type: "sword", rarity: "legendary", seed } }, seed: 3 });
  f.step({}, 3); // la première vague arrive et finit d'apparaître
  const stunned = opts.stunned ?? true;
  f.bots.forEach((b, i) => { b.hp = b.maxHp = 100000; b.x = 40 + 14 * i; b.y = 40; b.stun = 9999; b.cd = 1e9; });
  f.hero.x = 200; f.hero.y = 120; f.hero.face = [1, 0]; f.hero.inv = 0;
  const target = f.bots[0]!, other = f.bots[1]!;
  target.x = 214; target.y = 120; target.stun = stunned ? 9999 : 0;
  /** Remet la cible devant le forgeron (un coup la repousse hors de portée) : à appeler avant chaque coup d'une série. */
  const place = (otherAt?: [number, number]) => {
    target.x = 214; target.y = 120; target.kb = null;
    if (otherAt) { other.x = otherAt[0]; other.y = otherAt[1]; other.kb = null; }
  };
  return { f, target, other, place };
}
/** Un coup : la fenêtre d'armement (0,08 s) puis l'impact, sans laisser le temps d'un second coup. */
const strike = (f: Fight) => f.step({ attack: true }, 0.1);

describe("effets des armes : le tirage", () => {
  it("le nombre d'effets dépend de la rareté (aucun, 1, 2, 3), tous différents, avec une valeur dans la fourchette de leur rareté", () => {
    for (const rarity of C.RARITIES) {
      for (let i = 1; i <= 400; i++) {
        const r = C.rollWeapon("axe", rarity, `forge-${i}`);
        expect(r.affixes).toHaveLength(COUNT[rarity]!);
        expect(new Set(r.affixes.map((a) => a.id)).size).toBe(r.affixes.length);
        for (const a of r.affixes) {
          const spec = C.AFFIXES[a.id]!;
          expect(a.value).toBeGreaterThanOrEqual(Math.round(spec.range[0] * TIER[rarity]! * 1000) / 1000);
          expect(a.value).toBeLessThanOrEqual(Math.round(spec.range[1] * TIER[rarity]! * 1000) / 1000);
          expect(a.text.length).toBeGreaterThan(5);
        }
      }
    }
  });

  it("tous les effets existent à chaque rareté qui en donne, et les mêmes graines donnent les mêmes effets", () => {
    for (const rarity of ["rare", "epic", "legendary"]) {
      const seen = new Set<string>();
      for (let i = 1; i <= 600; i++) for (const a of C.rollWeapon("bow", rarity, `forge-${i}`).affixes) seen.add(a.id);
      expect([...seen].sort()).toEqual(Object.keys(C.AFFIXES).sort());
    }
    expect(C.rollWeapon("spear", "epic", "merge-9")).toEqual(C.rollWeapon("spear", "epic", "merge-9"));
  });

  it("une arme épique ou légendaire prend un surnom de son premier effet ; une arme commune ou rare, non ; sans graine, aucun effet", () => {
    for (let i = 1; i <= 200; i++) {
      expect(C.rollWeapon("sword", "common", `p-${i}`).epithet).toBe("");
      expect(C.rollWeapon("sword", "rare", `p-${i}`).epithet).toBe("");
      expect(C.rollWeapon("sword", "epic", `p-${i}`).epithet.length).toBeGreaterThan(3);
      expect(C.rollWeapon("sword", "legendary", `p-${i}`).epithet.length).toBeGreaterThan(3);
    }
    for (const rarity of C.RARITIES) expect(C.rollWeapon("sword", rarity).affixes).toEqual([]);
  });
});

describe("effets des armes : en combat", () => {
  it("Brûlure : le bot continue de perdre de la vie après le coup, pendant 3 s environ, puis cesse", () => {
    const seed = seedWith("burn"), { f, target } = lab(seed);
    strike(f);
    expect(target.burn).not.toBeNull();
    const afterHit = target.hp, tick = Math.round(target.burn!.dps * 0.5 * 10) / 10;
    f.step({}, 3.4);
    const lost = afterHit - target.hp;
    expect(target.burn).toBeNull(); // éteinte
    // Environ 6 ticks d'une demi-seconde en 3 s (5 à 7 selon l'instant du premier)
    expect(lost).toBeGreaterThanOrEqual(5 * tick - 0.01);
    expect(lost).toBeLessThanOrEqual(7 * tick + 0.01);
    expect(affix(seed, "burn").value).toBeGreaterThan(0.1);
    const settled = target.hp;
    f.step({}, 1.5);
    expect(target.hp).toBe(settled); // plus aucune perte une fois éteinte
  });

  it("Brûlure : un bot qui meurt brûlé compte comme vaincu", () => {
    const { f, target } = lab(seedWith("burn"));
    target.hp = 3; target.maxHp = 100000;
    strike(f);
    f.step({}, 0.1);
    f.step({}, 3.5);
    expect(target.alive).toBe(false);
  });

  it("Recul : l'ennemi est repoussé plus loin qu'avec une arme sans cet effet", () => {
    const withKb = seedWith("knockback"), without = seedWith(null, "knockback");
    const push = (seed: string) => { const { f, target } = lab(seed); const x0 = target.x; strike(f); f.step({}, 1); return target.x - x0; };
    const a = push(withKb), b = push(without);
    expect(b).toBeGreaterThan(0);
    expect(a).toBeGreaterThan(b * 1.4);
  });

  it("Vol de vie : frapper rend des points de vie, et jamais au-delà du maximum", () => {
    const { f, place } = lab(seedWith("lifesteal"));
    f.hero.hp = 10;
    for (let i = 0; i < 12; i++) { place(); strike(f); f.step({}, 0.4); }
    expect(f.hero.hp).toBeGreaterThan(10);
    f.hero.hp = f.hero.maxHp - 1;
    for (let i = 0; i < 12; i++) { place(); strike(f); f.step({}, 0.4); }
    expect(f.hero.hp).toBeLessThanOrEqual(f.hero.maxHp);
    const calm = lab(seedWith(null, "lifesteal"));
    calm.f.hero.hp = 10;
    for (let i = 0; i < 12; i++) { calm.place(); strike(calm.f); calm.f.step({}, 0.4); }
    expect(calm.f.hero.hp).toBe(10);
  });

  it("Givre : le bot touché est ralenti du pourcentage de l'effet", () => {
    const seed = seedWith("freeze", "stun"), { f, target } = lab(seed);
    strike(f);
    expect(target.slowT).toBeGreaterThan(0.9);
    expect(target.slowMult).toBeCloseTo(1 - affix(seed, "freeze").value, 1);
    const plain = lab(seedWith(null, "freeze"));
    strike(plain.f);
    expect(plain.target.slowT).toBe(0);
  });

  it("Étourdissement : une partie des coups assomme, pas tous", () => {
    const { f, target } = lab(seedWith("stun"), { stunned: false });
    let stunned = 0;
    for (let i = 0; i < 160; i++) {
      target.stun = 0; target.x = 214; target.y = 120;
      strike(f);
      if (target.stun > 0) stunned++;
      f.step({}, 0.4);
    }
    expect(stunned).toBeGreaterThan(5);
    expect(stunned).toBeLessThan(110);
  });

  it("Foudre : un éclair touche l'ennemi le plus proche (la moitié des dégâts), parfois seulement ; sans l'effet, jamais", () => {
    const seed = seedWith("lightning", "burn"), { f, target, other, place } = lab(seed);
    let bolts = 0;
    for (let i = 0; i < 120; i++) {
      place([214, 158]); // l'autre bot est à 38 px du bot frappé, hors de l'arc du coup
      const t0 = target.hp, o0 = other.hp;
      strike(f);
      f.step({}, 0.4);
      const hit = t0 - target.hp, arc = o0 - other.hp;
      if (arc > 0) { bolts++; expect(arc).toBeLessThanOrEqual(hit * 0.5 + 0.2); expect(arc).toBeGreaterThanOrEqual(hit * 0.5 - 0.2); }
    }
    expect(bolts).toBeGreaterThan(5);
    expect(bolts).toBeLessThan(90);
    const calm = lab(seedWith(null, "lightning"));
    const o0 = calm.other.hp;
    for (let i = 0; i < 60; i++) { calm.place([214, 158]); strike(calm.f); calm.f.step({}, 0.4); }
    expect(calm.other.hp).toBe(o0);
  });

  it("Précision : la chance de critique monte de la valeur de l'effet, plafond relevé d'autant", () => {
    const crit = (seed: string) => C.build({ level: 1, equipment: { weapon: { type: "sword", rarity: "legendary", seed } } }).derived.crit;
    const withSeed = seedWith("precision"), v = affix(withSeed, "precision").value;
    const chance = C.rollWeapon("sword", "legendary", withSeed).bonus.chance ?? 0;
    expect(crit(withSeed)).toBe(Math.round(Math.min(0.5 + v, 0.05 + 0.012 * chance + v) * 1000) / 1000);
    const plainSeed = seedWith(null, "precision"), plainChance = C.rollWeapon("sword", "legendary", plainSeed).bonus.chance ?? 0;
    expect(crit(plainSeed)).toBe(Math.round(Math.min(0.5, 0.05 + 0.012 * plainChance) * 1000) / 1000);
  });

  it("le même combat se rejoue à l'identique, avec ou sans effets", () => {
    const run = (seed: string) => { const { f, target, place } = lab(seed); for (let i = 0; i < 8; i++) { place(); strike(f); f.step({}, 0.4); } return [target.hp, f.hero.hp, target.x]; };
    const plainSeed = seedWith(null, "lifesteal");
    // Le même combat deux fois : identique (déterministe)
    expect(run(plainSeed)).toEqual(run(plainSeed));
  });
});
