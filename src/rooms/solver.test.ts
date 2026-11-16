import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../paths.js";
import { loadEngine } from "./engine.js";

const E = loadEngine();

function level(rows: Record<number, string> = {}): string[] {
  const map = Array.from({ length: 15 }, (_, y) => (y === 14 ? "#".repeat(24) : ".".repeat(24)));
  for (const [y, r] of Object.entries(rows)) map[Number(y)] = r.padEnd(24, ".");
  return map;
}
const game = (over: Record<string, unknown> = {}) => ({ title: "t", mode: "platformer", map: level(), player: { x: 1, y: 13 }, things: [], rules: [], win: [], lose: [], ...over });

describe("solveur de niveaux : prouve qu'un niveau est gagnable avec les vraies règles", () => {
  it("toutes les salles livrées qui ont un jeu sont gagnables", () => {
    const dir = path.join(PROJECT_ROOT, "public", "rooms");
    const withGame = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { id: string; game?: unknown }).filter((r) => r.game);
    expect(withGame.length).toBeGreaterThan(0);
    for (const room of withGame) {
      const r = E.solve(room.game, { maxNodes: 12000, maxMs: 20000 });
      expect(r.solved).toBe(true);
    }
  });

  it("un niveau simple de plateforme est résolu, en un temps de jeu raisonnable", () => {
    const g = game({ things: [{ kind: "coin", x: 6, y: 13 }, { kind: "goal", x: 12, y: 13 }], win: [{ reach: "goal" }] });
    const r = E.solve(g, { maxNodes: 3000 });
    expect(r.solved).toBe(true);
    expect(r.seconds).toBeGreaterThan(0);
    expect(r.seconds).toBeLessThan(20);
  });

  it("un but hors de portée d'un saut n'est pas prouvé gagnable", () => {
    // le drapeau est sur une plateforme 6 rangées plus haut, sans aucune marche
    const g = game({ map: level({ 8: "..........=====....." }), things: [{ kind: "goal", x: 12, y: 7 }], win: [{ reach: "goal" }] });
    expect(E.solve(g, { maxNodes: 2500, maxMs: 4000 }).solved).toBe(false);
  });

  it("un niveau qui exige de prendre une clé avant d'ouvrir la porte est résolu", () => {
    // un couloir de trois rangées, une porte au milieu, la clé avant la porte, la gemme derrière
    const open = game({ mode: "topdown", map: level({ 7: "..........#", 8: "..........#", 9: "..........#" }), player: { x: 1, y: 8 }, win: [{ collect_all: "gem" }], things: [{ kind: "key", x: 3, y: 8 }, { kind: "door", x: 6, y: 8 }, { kind: "gem", x: 8, y: 8 }] });
    expect(E.solve(open, { maxNodes: 3000 }).solved).toBe(true);
  });

  it("le résultat est le même à chaque fois", () => {
    const g = game({ things: [{ kind: "coin", x: 6, y: 13 }, { kind: "goal", x: 12, y: 13 }], win: [{ reach: "goal" }] });
    expect(E.solve(g, { maxNodes: 3000 })).toEqual(E.solve(g, { maxNodes: 3000 }));
  });
});

describe("instantané d'une partie", () => {
  it("revenir à un instantané redonne exactement la même suite", () => {
    const g = E.create(game({ things: [{ kind: "coin", x: 6, y: 13 }, { kind: "slime", x: 12, y: 13 }], win: [{ score: 99 }] }));
    for (let i = 0; i < 90; i++) g.tick(E.STEP, { right: true });
    const snap = g.snapshot();
    for (let i = 0; i < 120; i++) g.tick(E.STEP, { right: i % 60 < 40, jump: i % 50 < 10 });
    const after = JSON.stringify([g.player, g.score, g.lives, g.things]);
    g.restore(snap);
    for (let i = 0; i < 120; i++) g.tick(E.STEP, { right: i % 60 < 40, jump: i % 50 < 10 });
    expect(JSON.stringify([g.player, g.score, g.lives, g.things])).toBe(after);
  });
});
