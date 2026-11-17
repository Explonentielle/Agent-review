import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { LOOT_CATALOG } from "../game/loot.js";
import { PROJECT_ROOT } from "../paths.js";
import { validateRoom } from "./schema.js";

/* L'arène : `public/forge/combat.js` est de la logique pure. On le charge comme le serveur charge le moteur de jeu (contexte isolé). */
interface Item { type?: string; rarity: string }
interface Equipment { weapon?: Item; cape?: Item; apron?: Item; hat?: Item }
interface Built {
  level: number;
  base: Record<string, number>;
  bonus: Record<string, number>;
  total: Record<string, number>;
  slots: Record<string, { rarity: string; stat: string; points: number }>;
  weapon: { type: string; rarity: string; training: boolean; spec: { reach?: number; ranged?: boolean; projSpeed?: number; dmg: number; cd: number } };
  derived: { maxHp: number; speed: number; damage: number; cooldown: number; crit: number; dashCd: number; goldMult: number };
}
interface Bot { type: string; x: number; y: number; hp: number; maxHp: number; dmg: number; alive: boolean; windup: number; cd: number; spawnT: number; r: number; tell: unknown; spec: { reach?: number } }
interface Input { left?: boolean; right?: boolean; up?: boolean; down?: boolean; attack?: boolean; dash?: boolean }
interface Fight {
  built: Built;
  hero: { x: number; y: number; hp: number; maxHp: number; inv: number; dashCd: number; face: number[]; r: number };
  bots: Bot[];
  shots: unknown[];
  state: "between" | "fighting" | "won" | "lost";
  wave: number;
  cleared: number;
  kills: number;
  t: number;
  ending: string;
  step(input?: Input, dt?: number): void;
  hud(): { state: string; hp: number; maxHp: number; wave: number; waves: number; botsLeft: number; kills: number };
  result(): { state: string; cleared: number; wave: number; kills: number; time: number; damage: number; gold: number };
  drain(): string[];
}
interface Combat {
  STEP: number;
  STAT_IDS: string[];
  RARITIES: string[];
  RARITY_STAT: Record<string, number>;
  SLOT_STAT: Record<string, string>;
  WEAPONS: Record<string, { reach?: number; ranged?: boolean; projSpeed?: number; dmg: number; cd: number; windup: number; name: string; blurb: string }>;
  BOTS: Record<string, { weapon: string; rarity: string; hp: number; dmg: number }>;
  WAVES: Array<{ name: string; bots: string[] }>;
  BOUNDS: { x0: number; x1: number; y0: number; y1: number };
  OBSTACLES: Array<{ x: number; y: number; w: number; h: number }>;
  pointsFor(level: number): number;
  spent(stats: Record<string, number>): number;
  normalizeStats(raw: unknown, level: number): Record<string, number>;
  build(opts?: { level?: number; stats?: Record<string, number>; equipment?: Equipment }): Built;
  reward(result: { state: string; cleared: number }, built?: Built): number;
  create(opts?: { level?: number; stats?: Record<string, number>; equipment?: Equipment; seed?: number }): Fight;
}

const read = (...p: string[]) => readFileSync(path.join(PROJECT_ROOT, ...p), "utf8");
const context = vm.createContext({});
vm.runInContext(read("public", "forge", "combat.js"), context, { filename: "combat.js", timeout: 1000 });
const C = (context as { ForgeCombat?: Combat }).ForgeCombat as Combat;

const legendary = { weapon: { type: "sword", rarity: "legendary" }, cape: { rarity: "legendary" }, apron: { rarity: "legendary" }, hat: { rarity: "legendary" } };
const spread = (n: number) => ({ force: Math.ceil(n / 4), agilite: Math.ceil(n / 4), vitalite: Math.floor(n / 4), chance: Math.floor(n / 4) });

/** Un joueur automatique raisonnable : approche l'ennemi le plus proche, frappe, roule quand un coup s'arme. */
function autoplay(f: Fight): Input {
  const h = f.hero, wp = f.built.weapon.spec;
  const alive = f.bots.filter((b) => b.alive && b.spawnT <= 0);
  const input: Input = {};
  if (!alive.length) return input;
  let best = alive[0]!, bd = Infinity;
  for (const b of alive) { const d = Math.hypot(b.x - h.x, b.y - h.y); if (d < bd) { bd = d; best = b; } }
  const dx = best.x - h.x, dy = best.y - h.y;
  const menaced = alive.some((b) => b.windup > 0 && Math.hypot(b.x - h.x, b.y - h.y) < (b.spec.reach ?? 30) + 24);
  if (menaced && h.dashCd <= 0) return { dash: true, left: dx > 0, right: dx < 0, up: dy > 0, down: dy < 0 };
  if (wp.ranged) {
    if (bd < 75) Object.assign(input, { left: dx > 0, right: dx < 0, up: dy > 0, down: dy < 0 });
    else if (bd > 130) Object.assign(input, { left: dx < 0, right: dx > 0, up: dy < 0, down: dy > 0 });
    input.attack = true;
  } else {
    if (bd > (wp.reach ?? 20) * 0.7 + best.r + h.r) Object.assign(input, { left: dx < -2, right: dx > 2, up: dy < -2, down: dy > 2 });
    input.attack = bd < (wp.reach ?? 20) + best.r + h.r + 4;
  }
  return input;
}
function play(f: Fight, seconds = 600, ai: (f: Fight) => Input = autoplay): Fight {
  for (let i = 0; i < seconds * 60 && f.state !== "won" && f.state !== "lost"; i++) f.step(ai(f));
  return f;
}
/** Avance jusqu'à la première vague en action (les bots ont fini d'apparaître). */
function toFirstWave(f: Fight): void {
  for (let i = 0; i < 600 && !(f.state === "fighting" && f.bots.every((b) => b.spawnT <= 0)); i++) f.step({});
}

describe("arène : caractéristiques", () => {
  it("un point par niveau, jamais plus, et des entrées douteuses sont nettoyées", () => {
    expect(C.pointsFor(1)).toBe(1);
    expect(C.pointsFor(30)).toBe(30);
    expect(C.pointsFor(500)).toBe(99);
    expect(C.pointsFor(-4)).toBe(1);
    expect(C.normalizeStats({ force: 50 }, 10)).toEqual({ force: 10, agilite: 0, vitalite: 0, chance: 0 });
    expect(C.normalizeStats({ force: 6, agilite: 6, vitalite: 6 }, 10)).toEqual({ force: 6, agilite: 4, vitalite: 0, chance: 0 });
    expect(C.normalizeStats({ force: -3, agilite: "x", vitalite: NaN, chance: 2.9 }, 10)).toEqual({ force: 0, agilite: 0, vitalite: 0, chance: 2 });
    expect(C.normalizeStats(null, 5)).toEqual({ force: 0, agilite: 0, vitalite: 0, chance: 0 });
    expect(C.normalizeStats([9, 9], 5)).toEqual({ force: 0, agilite: 0, vitalite: 0, chance: 0 });
    expect(C.normalizeStats({ __proto__: { force: 9 }, constructor: 4 }, 9)).toEqual({ force: 0, agilite: 0, vitalite: 0, chance: 0 });
  });

  it("chaque emplacement nourrit sa caractéristique, selon la rareté de l'objet", () => {
    const b = C.build({ level: 1, stats: {}, equipment: { weapon: { type: "axe", rarity: "rare" }, cape: { rarity: "common" }, apron: { rarity: "epic" }, hat: { rarity: "legendary" } } });
    expect(b.bonus).toEqual({ force: 2, agilite: 1, vitalite: 4, chance: 7 });
    expect(b.total).toEqual(b.bonus);
    expect(b.slots["hat"]).toEqual({ rarity: "legendary", stat: "chance", points: 7 });
    expect(C.RARITY_STAT).toEqual({ common: 1, rare: 2, epic: 4, legendary: 7 });
  });

  it("un objet inconnu ne donne rien, une arme inconnue est remplacée par l'épée d'entraînement", () => {
    const b = C.build({ level: 1, equipment: { weapon: { type: "canon", rarity: "legendary" }, cape: { rarity: "mythique" } } });
    expect(b.bonus).toEqual({ force: 0, agilite: 0, vitalite: 0, chance: 0 });
    expect(b.weapon).toMatchObject({ type: "sword", rarity: "common", training: true });
    expect(C.build({ level: 1 }).weapon.training).toBe(true);
    expect(C.build({ level: 1, equipment: { weapon: { type: "bow", rarity: "rare" } } }).weapon.training).toBe(false);
  });

  it("chaque caractéristique améliore bien ce qu'elle annonce", () => {
    const none = C.build({ level: 20 }).derived;
    expect(C.build({ level: 20, stats: { force: 10 } }).derived.damage).toBeGreaterThan(none.damage);
    expect(C.build({ level: 20, stats: { vitalite: 10 } }).derived.maxHp).toBeGreaterThan(none.maxHp);
    const agi = C.build({ level: 20, stats: { agilite: 10 } }).derived;
    expect(agi.speed).toBeGreaterThan(none.speed);
    expect(agi.cooldown).toBeLessThan(none.cooldown);
    expect(agi.dashCd).toBeLessThan(none.dashCd);
    const luck = C.build({ level: 20, stats: { chance: 10 } }).derived;
    expect(luck.crit).toBeGreaterThan(none.crit);
    expect(luck.goldMult).toBeGreaterThan(none.goldMult);
  });

  it("les plafonds tiennent : critique, or, roulade, vitesse", () => {
    const d = C.build({ level: 99, stats: { chance: 99 }, equipment: legendary }).derived;
    expect(d.crit).toBeLessThanOrEqual(0.5);
    expect(d.goldMult).toBeLessThanOrEqual(1.5);
    expect(C.build({ level: 99, stats: { agilite: 99 }, equipment: legendary }).derived.dashCd).toBeGreaterThanOrEqual(0.7);
    expect(C.build({ level: 99, stats: { agilite: 99 }, equipment: legendary }).derived.speed).toBeLessThanOrEqual(62 * 1.6 + 0.1);
  });

  it("une arme plus rare frappe plus fort, à caractéristiques égales", () => {
    const dmg = (rarity: string) => C.build({ level: 1, equipment: { weapon: { type: "sword", rarity } } }).derived.damage;
    expect(dmg("rare")).toBeGreaterThan(dmg("common"));
    expect(dmg("epic")).toBeGreaterThan(dmg("rare"));
    expect(dmg("legendary")).toBeGreaterThan(dmg("epic"));
  });
});

describe("arène : cohérence avec le reste de la forge", () => {
  it("toute arme et toute tenue du butin a une place dans l'arène", () => {
    for (const item of LOOT_CATALOG) {
      expect(C.RARITIES, item.id).toContain(item.rarity);
      expect(C.RARITY_STAT[item.rarity], item.id).toBeGreaterThan(0);
      if (item.kind === "weapon") expect(C.WEAPONS[item.weapon ?? ""], item.id).toBeDefined();
      else expect(C.SLOT_STAT[item.part ?? ""], item.id).toBeDefined();
    }
    expect(Object.keys(C.WEAPONS).sort()).toEqual(LOOT_CATALOG.filter((i) => i.kind === "weapon" && i.rarity === "common").map((i) => i.weapon).sort());
  });

  it("chaque arme a un profil complet et une description", () => {
    for (const [id, w] of Object.entries(C.WEAPONS)) {
      expect(w.dmg, id).toBeGreaterThan(0);
      expect(w.cd, id).toBeGreaterThan(w.windup);
      expect(w.name.length, id).toBeGreaterThan(0);
      expect(w.blurb.length, id).toBeGreaterThan(10);
      if (w.ranged) expect(w.projSpeed, id).toBeGreaterThan(0); else expect(w.reach, id).toBeGreaterThan(0);
    }
    expect(C.WEAPONS["spear"]!.reach!).toBeGreaterThan(C.WEAPONS["sword"]!.reach!);
    expect(C.WEAPONS["sword"]!.reach!).toBeGreaterThan(C.WEAPONS["dagger"]!.reach!);
  });

  it("chaque bot a une apparence, une arme connue, et chaque vague ne cite que des bots qui existent", () => {
    const sandbox = { window: { ForgeSprites: { px: () => undefined }, ForgeCombat: C } as Record<string, unknown> };
    vm.runInContext(read("public", "forge", "arena.js"), vm.createContext(sandbox), { filename: "arena.js", timeout: 1000 });
    const looks = (sandbox.window["ForgeArena"] as { BOT_LOOKS: Record<string, unknown> }).BOT_LOOKS;
    for (const [id, bot] of Object.entries(C.BOTS)) {
      expect(Object.keys(looks), id).toContain(id);
      expect(Object.keys(C.WEAPONS), id).toContain(bot.weapon);
      expect(C.RARITIES, id).toContain(bot.rarity);
    }
    for (const wave of C.WAVES) for (const id of wave.bots) expect(Object.keys(C.BOTS)).toContain(id);
    expect(C.WAVES.at(-1)!.bots).toEqual(["seigneur"]);
  });

  it("la salle de l'arène est valide et le jeu y retrouve son Maître d'armes et sa porte de fer", () => {
    const res = validateRoom(JSON.parse(read("public", "rooms", "arene.json")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const game = read("public", "forge", "game.js");
    expect(game).toContain(`ARENA_ROOM = "${res.room.id}"`);
    const master = /ARENA_MASTER = "([a-z-]+)"/.exec(game)?.[1];
    expect(res.room.npcs.map((n) => n.id)).toContain(master);
    expect(res.room.hub).toBe(false); // pas de porte magique : l'arène a sa herse
    expect(res.room.doors.every((d) => d.style === "iron" && d.to === "forge")).toBe(true);
    expect(res.room.npcs.find((n) => n.id === master)?.look).toBe("armurier");
  });

  it("le style de porte est une liste fermée", () => {
    const base = { format: 1, id: "test", name: "Test", theme: "castle", spawn: [12, 12], doors: [{ x: 11, to: "forge", label: "Sortir" }] };
    expect(validateRoom({ ...base, doors: [{ x: 11, to: "forge", label: "Sortir", style: "iron" }] }).ok).toBe(true);
    expect(validateRoom({ ...base, doors: [{ x: 11, to: "forge", label: "Sortir", style: "wood" }] }).ok).toBe(true);
    expect(validateRoom({ ...base, doors: [{ x: 11, to: "forge", label: "Sortir", style: "<script>" }] }).ok).toBe(false);
    expect(validateRoom({ ...base, doors: [{ x: 11, to: "forge", label: "Sortir", style: "or" }] }).ok).toBe(false);
  });
});

describe("arène : le combat", () => {
  it("un même combat avec la même graine se rejoue à l'identique, une autre graine donne un autre combat", () => {
    const a = play(C.create({ level: 10, stats: spread(10), seed: 7 })).result();
    const b = play(C.create({ level: 10, stats: spread(10), seed: 7 })).result();
    expect(a).toEqual(b);
    const results = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(play(C.create({ level: 10, stats: spread(10), seed })).result()));
    expect(new Set(results).size).toBeGreaterThan(1);
  });

  it("les vagues s'enchaînent dans l'ordre et un héros bien équipé gagne l'arène", () => {
    const f = C.create({ level: 30, stats: spread(30), equipment: legendary, seed: 3 });
    const seen: number[] = [];
    for (let i = 0; i < 60 * 600 && f.state !== "won" && f.state !== "lost"; i++) {
      f.step(autoplay(f));
      if (!seen.includes(f.wave)) seen.push(f.wave);
    }
    expect(f.state).toBe("won");
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(f.hud()).toMatchObject({ wave: 5, waves: 5, botsLeft: 0 });
    const r = f.result();
    expect(r.cleared).toBe(5);
    expect(r.kills).toBeGreaterThanOrEqual(10);
    expect(r.gold).toBe(C.reward({ state: "won", cleared: 5 }, f.built)); // 5 + 7 + 9 + 11 + 13 + 25 de victoire, majoré par la Chance
    expect(r.gold).toBeGreaterThanOrEqual(70);
  });

  it("les caractéristiques changent vraiment l'issue : sans point, la même épreuve échoue", () => {
    const wins = (stats: Record<string, number>, equipment?: Equipment) =>
      [1, 2, 3, 4, 5, 6].filter((seed) => play(C.create({ level: 30, stats, equipment, seed })).state === "won").length;
    expect(wins(spread(30))).toBeGreaterThan(wins({}));
    expect(wins(spread(30), legendary)).toBeGreaterThanOrEqual(wins(spread(30)));
    expect(wins({})).toBe(0);
  });

  it("un héros sans défense perd et le combat ne se relance pas tout seul", () => {
    const f = C.create({ level: 1, seed: 2 });
    f.hero.hp = 3;
    play(f, 120, () => ({}));
    expect(f.state).toBe("lost");
    expect(f.hero.hp).toBe(0);
    expect(f.ending.length).toBeGreaterThan(0);
    const t = f.t;
    f.step({ attack: true });
    expect(f.t).toBe(t);
    expect(f.result().state).toBe("lost");
  });

  it("une partie perdue rapporte moins d'or qu'une victoire, et la Chance l'augmente", () => {
    const base = C.build({ level: 1 }), lucky = C.build({ level: 99, stats: { chance: 40 } });
    expect(C.reward({ state: "lost", cleared: 0 }, base)).toBe(0);
    expect(C.reward({ state: "lost", cleared: 2 }, base)).toBe(12);
    expect(C.reward({ state: "won", cleared: 5 }, base)).toBe(70);
    expect(C.reward({ state: "won", cleared: 5 }, lucky)).toBeGreaterThan(70);
    expect(C.reward({ state: "won", cleared: 5 }, lucky)).toBeLessThanOrEqual(105);
  });

  it("les bots sont plus solides quand le niveau monte", () => {
    const at = (level: number) => { const f = C.create({ level, seed: 1 }); toFirstWave(f); return f.bots[0]!; };
    expect(at(40).maxHp).toBeGreaterThan(at(1).maxHp);
    expect(at(40).dmg).toBeGreaterThan(at(1).dmg);
  });

  it("un coup d'épée touche un bot devant soi, avec son signal sonore, et le tue", () => {
    const f = C.create({ level: 1, seed: 1, stats: { force: 1 } });
    toFirstWave(f);
    const b = f.bots[0]!;
    b.x = f.hero.x; b.y = f.hero.y - 18; b.cd = 99; // un gobelin devant le héros, qui n'attaque pas
    f.hero.face = [0, -1];
    const hp = b.hp;
    for (let i = 0; i < 40; i++) f.step({ attack: true });
    expect(b.hp).toBeLessThan(hp);
    const events = f.drain();
    expect(events).toContain("swing-hit");
    expect(f.drain()).toEqual([]); // la file est vidée
    for (let i = 0; i < 300 && b.alive; i++) f.step({ attack: true });
    expect(b.alive).toBe(false);
    expect(f.kills).toBeGreaterThanOrEqual(1);
  });

  it("un coup dans le vide, derrière soi, ne touche personne", () => {
    const f = C.create({ level: 1, seed: 1 });
    toFirstWave(f);
    const b = f.bots[0]!;
    b.x = f.hero.x; b.y = f.hero.y + 18; b.cd = 99; // derrière le héros
    const others = f.bots.slice(1);
    for (const o of others) { o.x = 40; o.y = 40; o.cd = 99; }
    f.hero.face = [0, -1];
    const hp = b.hp;
    // Sans visée assistée possible (aucun ennemi à portée devant), le héros frappe là où il regarde : on le tient face au mur du haut
    for (let i = 0; i < 30; i++) f.step({ attack: true, up: true });
    expect(b.hp).toBe(hp);
  });

  it("l'arc tire de loin : la flèche touche un bot éloigné", () => {
    const f = C.create({ level: 1, seed: 1, equipment: { weapon: { type: "bow", rarity: "common" } } });
    toFirstWave(f);
    const [near, far] = [f.bots[0]!, f.bots[1]!];
    near.x = f.hero.x; near.y = f.hero.y - 120; near.cd = 99;
    far.x = 40; far.y = 40; far.cd = 99;
    const hp = near.hp;
    for (let i = 0; i < 120; i++) f.step({ attack: true });
    expect(near.hp).toBeLessThan(hp);
    expect(f.drain()).toContain("shoot");
  });

  it("la roulade rend intouchable le temps de l'esquive : un coup armé pendant la roulade ne blesse pas", () => {
    const hurt = (dodge: boolean): number => {
      const f = C.create({ level: 1, seed: 1 });
      toFirstWave(f);
      for (const o of f.bots.slice(1)) { o.x = 40; o.y = 40; o.cd = 99; }
      const b = f.bots[0]!;
      b.x = f.hero.x + 10; b.y = f.hero.y; b.cd = 0;
      const hp = f.hero.hp;
      // Le bot arme son coup ; au dernier instant, le héros roule (ou reste planté là)
      for (let i = 0; i < 90 && b.windup <= 0; i++) f.step({});
      for (let i = 0; i < 90 && b.windup > 0.05; i++) f.step({});
      for (let i = 0; i < 20; i++) f.step({ dash: dodge, right: dodge }); // la roulade passe à travers le bot : sans elle, le coup le toucherait
      return hp - f.hero.hp;
    };
    expect(hurt(false)).toBeGreaterThan(0);
    expect(hurt(true)).toBe(0);
  });

  it("les murs et les piliers arrêtent le héros, qui reste dans l'arène", () => {
    const f = C.create({ level: 1, seed: 1 });
    for (let i = 0; i < 60 * 8; i++) f.step({ left: true });
    expect(f.hero.x - f.hero.r).toBeGreaterThanOrEqual(C.BOUNDS.x0 - 0.001);
    for (let i = 0; i < 60 * 8; i++) f.step({ up: true });
    expect(f.hero.y - f.hero.r).toBeGreaterThanOrEqual(C.BOUNDS.y0 - 0.001);
    // Un pilier : le héros posé juste à gauche d'un pilier n'y entre pas
    const o = C.OBSTACLES[0]!, g = C.create({ level: 1, seed: 1 });
    g.hero.x = o.x - g.hero.r - 1; g.hero.y = o.y + o.h / 2;
    for (let i = 0; i < 60; i++) g.step({ right: true });
    expect(g.hero.x + g.hero.r).toBeLessThanOrEqual(o.x + 0.001);
  });

  it("le Seigneur des braises annonce sa charge puis appelle du renfort quand il faiblit", () => {
    const f = C.create({ level: 20, stats: spread(20), equipment: legendary, seed: 5 });
    f.wave = 4; f.state = "between";
    const events = new Set<string>();
    for (let i = 0; i < 60 * 300 && !(["won", "lost"] as string[]).includes(f.hud().state); i++) { f.step(autoplay(f)); for (const e of f.drain()) events.add(e); }
    expect(events.has("tell")).toBe(true);
    expect(events.has("charge")).toBe(true);
    expect(events.has("summon")).toBe(true);
    expect(f.state).toBe("won");
  });

  it("un pas plus long est découpé en pas fixes : même résultat qu'en petits pas", () => {
    const a = C.create({ level: 5, seed: 9 }), b = C.create({ level: 5, seed: 9 });
    for (let i = 0; i < 300; i++) a.step({ right: true }, C.STEP);
    for (let i = 0; i < 100; i++) b.step({ right: true }, C.STEP * 3);
    expect(b.hero.x).toBeCloseTo(a.hero.x, 3);
    expect(b.t).toBeCloseTo(a.t, 3);
  });
});
