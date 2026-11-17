import { describe, expect, it } from "vitest";
import { loadEngine, type EngineGame, type EngineInput } from "./engine.js";

const E = loadEngine();
const STEP = E.STEP;

/** Niveau de 24 x 15 : un sol plein en bas, plus les rangées données (indice de rangée vers texte de 24 caractères). */
function level(rows: Record<number, string> = {}): string[] {
  const map = Array.from({ length: 15 }, (_, y) => (y === 14 ? "#".repeat(24) : ".".repeat(24)));
  for (const [y, r] of Object.entries(rows)) map[Number(y)] = r.padEnd(24, ".");
  return map;
}
const def = (over: Record<string, unknown> = {}) => ({ mode: "platformer", map: level(), player: { x: 2, y: 13 }, things: [], rules: [], win: [{ score: 99 }], lose: [], ...over });
/** Fait jouer `seconds` secondes avec ces touches (une fonction du numéro d'image, ou des touches fixes). */
function run(g: EngineGame, seconds: number, input: EngineInput | ((i: number) => EngineInput) = {}): void {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n && g.state === "playing"; i++) g.tick(STEP, typeof input === "function" ? input(i) : input);
}
const tileTop = (row: number) => row * E.T;

describe("moteur de jeu : plateforme", () => {
  it("le joueur se pose sur le sol et y reste", () => {
    const g = E.create(def({ player: { x: 2, y: 5 } }));
    run(g, 2);
    expect(g.player.onGround).toBe(true);
    expect(g.player.y + g.player.h).toBeCloseTo(tileTop(14), 0);
    expect(g.player.vy).toBe(0);
  });

  it("un saut monte d'environ v²/2g puis retombe au même endroit", () => {
    const g = E.create(def());
    run(g, 0.3);
    const ground = g.player.y;
    let top = ground;
    for (let i = 0; i < 60 * 2; i++) { g.tick(STEP, { jump: i < 40 }); top = Math.min(top, g.player.y); }
    const expected = (270 * 270) / (2 * 900); // ~40,5 px
    expect(ground - top).toBeGreaterThan(expected * 0.8);
    expect(ground - top).toBeLessThan(expected * 1.1);
    expect(g.player.y).toBeCloseTo(ground, 0);
    expect(g.player.onGround).toBe(true);
  });

  it("lâcher la touche écourte le saut", () => {
    const hold = E.create(def());
    const tap = E.create(def());
    run(hold, 0.3); run(tap, 0.3);
    const y0 = hold.player.y;
    let topHold = y0, topTap = y0;
    for (let i = 0; i < 60; i++) { hold.tick(STEP, { jump: true }); tap.tick(STEP, { jump: i < 3 }); topHold = Math.min(topHold, hold.player.y); topTap = Math.min(topTap, tap.player.y); }
    expect(y0 - topTap).toBeLessThan((y0 - topHold) * 0.6);
  });

  it("un mur arrête le joueur et les bords de la carte aussi", () => {
    const g = E.create(def({ map: level({ 13: "..........#" }), player: { x: 2, y: 13 } }));
    run(g, 3, { right: true });
    expect(g.player.x + g.player.w).toBeCloseTo(10 * E.T, 0); // collé au mur de la colonne 10
    const left = E.create(def());
    run(left, 5, { left: true });
    expect(left.player.x).toBeGreaterThanOrEqual(0);
    expect(left.player.x).toBeLessThan(1);
  });

  it("une plateforme se traverse par en dessous et on s'y pose par au-dessus", () => {
    // plateforme sur la rangée 12 (32 px au-dessus du sol : à portée d'un saut d'environ 40 px), le joueur saute depuis le sol en dessous
    const g = E.create(def({ map: level({ 12: "..====......" }), player: { x: 3, y: 13 } }));
    run(g, 0.3);
    for (let i = 0; i < 60 * 2; i++) g.tick(STEP, { jump: i < 40 });
    run(g, 1);
    expect(g.player.onGround).toBe(true);
    expect(g.player.y + g.player.h).toBeCloseTo(tileTop(12), 0); // il a traversé la plateforme par en dessous et s'est posé dessus, pas sur le sol
  });

  it("tomber dans le vide coûte une vie et ramène au départ", () => {
    const g = E.create(def({ map: level({ 14: "#####.....################" }), player: { x: 3, y: 13 } }));
    // on s'arrête à la première chute : en gardant la touche appuyée, le joueur retomberait dans le trou après sa réapparition
    for (let i = 0; i < 60 * 3 && g.lives === 3; i++) g.tick(STEP, { right: true });
    expect(g.lives).toBe(2);
    expect(g.player.x).toBeLessThan(3 * E.T + 8); // revenu près du départ (x = 3 * 16 + 3)
  });

  it("les piques coûtent une vie et ramènent au départ", () => {
    const g = E.create(def({ map: level({ 13: "...^......" }), player: { x: 1, y: 13 } }));
    run(g, 2, { right: true });
    expect(g.lives).toBe(2);
    expect(g.player.inv).toBeGreaterThanOrEqual(0);
  });
});

describe("moteur de jeu : objets, ennemis et règles", () => {
  it("une pièce rapporte sa valeur et disparaît ; ramasser toutes les pièces fait gagner", () => {
    // `win` est une liste dont la première condition vraie gagne : il faut donc deux pièces, sinon la première suffirait à gagner
    const g = E.create(def({ things: [{ kind: "coin", x: 4, y: 13 }, { kind: "gem", x: 6, y: 13 }, { kind: "coin", x: 8, y: 13 }], win: [{ collect_all: "coin" }] }));
    run(g, 3, { right: true });
    expect(g.score).toBe(7); // 1 + 5 + 1
    expect(g.things.filter((t) => t.alive && t.group === "item")).toHaveLength(0);
    expect(g.state).toBe("won");
  });

  it("une règle sur le toucher ajoute ses effets à ceux de base (valeur de la pièce, message, point bonus)", () => {
    const g = E.create(def({
      things: [{ kind: "coin", x: 4, y: 13, value: 3 }],
      rules: [{ on: "touch", kind: "coin", do: [{ score: 10 }, { say: "Bravo !" }] }],
    }));
    run(g, 2, { right: true });
    expect(g.score).toBe(13);
    expect(g.hud().message).toBe("Bravo !");
  });

  it("écraser un ennemi par le dessus le tue et fait rebondir ; il rapporte via la règle « defeat »", () => {
    const g = E.create(def({
      things: [{ kind: "slime", x: 8, y: 13, move: { pattern: "none" } }],
      rules: [{ on: "defeat", kind: "slime", do: [{ score: 5 }] }],
      player: { x: 8, y: 9 },
    }));
    run(g, 2);
    expect(g.things[0]!.alive).toBe(false);
    expect(g.score).toBe(5);
    expect(g.lives).toBe(3);
  });

  it("toucher un ennemi de côté coûte une vie, puis le joueur est protégé un instant ; zéro vie fait perdre", () => {
    const g = E.create(def({ things: [{ kind: "slime", x: 6, y: 13, move: { pattern: "none" } }], player: { x: 3, y: 13 } }));
    run(g, 1.5, { right: true });
    expect(g.lives).toBe(2);
    expect(g.player.inv).toBeGreaterThan(0);
    const dead = E.create(def({ player: { x: 3, y: 13, lives: 1 }, things: [{ kind: "slime", x: 6, y: 13, move: { pattern: "none" } }] }));
    run(dead, 2, { right: true });
    expect(dead.state).toBe("lost");
  });

  it("un ennemi patrouille entre ses limites sans tomber d'un bord", () => {
    const g = E.create(def({ map: level({ 13: "", 14: "#".repeat(24) }), things: [{ kind: "slime", x: 10, y: 13, move: { pattern: "patrol-x", range: 2, speed: 40 } }], player: { x: 20, y: 13 } }));
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < 60 * 8; i++) { g.tick(STEP, {}); const t = g.things[0]!; min = Math.min(min, t.x); max = Math.max(max, t.x); }
    expect(max - min).toBeGreaterThan(E.T); // il bouge
    expect(max - min).toBeLessThan(E.T * 5); // dans ses limites (± 2 tuiles)
  });

  it("une clé ouvre une porte, qui est un mur tant qu'elle est fermée", () => {
    const g = E.create(def({ map: level({ 12: "..........#", 13: "..........#" }), things: [{ kind: "door", x: 6, y: 13 }, { kind: "door", x: 6, y: 12 }, { kind: "key", x: 3, y: 13 }, { kind: "goal", x: 8, y: 13 }], win: [{ reach: "goal" }], player: { x: 1, y: 13 } }));
    run(g, 3, { right: true });
    expect(g.keys).toBe(0);
    expect(g.things.filter((t) => t.kind === "door" && t.alive)).toHaveLength(1); // une seule clé : une seule porte ouverte
    expect(g.state).toBe("won"); // le passage du bas est ouvert
  });

  it("des règles agissent sur le temps, le score et les drapeaux", () => {
    const g = E.create(def({
      rules: [
        { on: "timer", at: 1, do: [{ spawn: { kind: "coin", x: 12, y: 13 } }, { flag: "ouvert" }] },
        { on: "timer", every: 0.5, if: { flag: "ouvert" }, do: [{ score: 1 }] },
        { on: "score", at: 4, do: [{ say: "Quatre !" }, { win: "Fini" }] },
      ],
    }));
    run(g, 4);
    expect(g.flags.ouvert).toBe(true);
    expect(g.things.some((t) => t.kind === "coin")).toBe(true);
    expect(g.state).toBe("won");
    expect(g.ending).toBe("Fini");
  });

  it("le ressort propulse, un coeur rend une vie, un but fait gagner", () => {
    const spring = E.create(def({ things: [{ kind: "spring", x: 3, y: 13 }], player: { x: 3, y: 10 } }));
    run(spring, 0.8);
    expect(spring.player.y).toBeLessThan(tileTop(13)); // propulsé en l'air (pas au sol)
    const heart = E.create(def({ things: [{ kind: "heart", x: 4, y: 13 }, { kind: "goal", x: 7, y: 13 }], win: [{ reach: "goal" }], player: { x: 2, y: 13, lives: 2 } }));
    run(heart, 3, { right: true });
    expect(heart.lives).toBe(3);
    expect(heart.state).toBe("won");
  });

  it("la défaite arrive au bout du temps limite ; survivre un certain temps fait gagner", () => {
    const timed = E.create(def({ lose: [{ time: 2 }], win: [{ score: 99 }] }));
    run(timed, 3);
    expect(timed.state).toBe("lost");
    expect(timed.ending).toBe("Temps écoulé.");
    const survive = E.create(def({ win: [{ survive: 2 }] }));
    run(survive, 3);
    expect(survive.state).toBe("won");
  });
});

describe("moteur de jeu : vue de dessus", () => {
  it("le joueur se déplace dans les quatre directions sans gravité et se heurte aux blocs", () => {
    const g = E.create(def({ mode: "topdown", map: level({ 7: ".........#" }), player: { x: 2, y: 7 } }));
    const y0 = g.player.y;
    run(g, 1);
    expect(g.player.y).toBeCloseTo(y0, 3); // pas de gravité
    run(g, 3, { right: true });
    expect(g.player.x + g.player.w).toBeCloseTo(9 * E.T, 0);
    run(g, 0.5, { up: true });
    expect(g.player.y).toBeLessThan(y0);
  });

  it("un coup devant soi tue un ennemi proche ; un ennemi qui poursuit blesse s'il touche", () => {
    const g = E.create(def({ mode: "topdown", map: level(), things: [{ kind: "slime", x: 5, y: 7, move: { pattern: "none" } }], player: { x: 3, y: 7 } }));
    run(g, 0.5, { right: true });
    for (let i = 0; i < 30; i++) g.tick(STEP, { right: true, act: i === 0 });
    expect(g.things[0]!.alive).toBe(false);
    const chaser = E.create(def({ mode: "topdown", things: [{ kind: "skull", x: 8, y: 7 }], player: { x: 4, y: 7 } })); // dans sa portée de poursuite (6 cases)
    run(chaser, 6);
    expect(chaser.lives).toBeLessThan(3);
  });
});

describe("moteur de jeu : régularité", () => {
  it("deux parties avec les mêmes touches donnent exactement le même résultat", () => {
    const d = def({ things: [{ kind: "coin", x: 6, y: 13 }, { kind: "slime", x: 12, y: 13 }, { kind: "bat", x: 15, y: 9 }], win: [{ score: 99 }] });
    const input = (i: number): EngineInput => ({ right: i % 200 < 120, left: i % 200 >= 120, jump: i % 37 < 8 });
    const a = E.create(d), b = E.create(d);
    run(a, 12, input); run(b, 12, input);
    expect(a.player).toEqual(b.player);
    expect(a.score).toBe(b.score);
    expect(a.lives).toBe(b.lives);
    expect(a.things.map((t) => [t.x, t.y, t.alive])).toEqual(b.things.map((t) => [t.x, t.y, t.alive]));
  });

  it("le contrôle sans écran ne signale rien sur un niveau sain, et signale un niveau qui plante", () => {
    expect(E.smoke(def({ things: [{ kind: "coin", x: 4, y: 13 }, { kind: "slime", x: 10, y: 13 }] }))).toEqual([]);
    expect(E.smoke(def({ things: [{ kind: "dragon", x: 4, y: 13 }] })).length).toBeGreaterThan(0);
  });

  it("un pas de durée variable donne le même résultat qu'une suite de pas fixes", () => {
    const d = def({ things: [{ kind: "coin", x: 5, y: 13 }] });
    const a = E.create(d), b = E.create(d);
    for (let i = 0; i < 120; i++) a.step(STEP, { right: true });
    for (let i = 0; i < 24; i++) b.step(STEP * 5, { right: true });
    expect(b.player.x).toBeCloseTo(a.player.x, 0);
    expect(b.score).toBe(a.score);
  });
});
