import { describe, expect, it } from "vitest";
import { GameSchema, checkGame } from "./game.js";
import { validateRoom } from "./schema.js";

/** Carte de 24 x 15 : sol plein en bas, plus les rangées données. */
function level(rows: Record<number, string> = {}): string[] {
  const map = Array.from({ length: 15 }, (_, y) => (y === 14 ? "#".repeat(24) : ".".repeat(24)));
  for (const [y, r] of Object.entries(rows)) map[Number(y)] = r.padEnd(24, ".");
  return map;
}

/** Un niveau de plateforme sain : des pièces, un ennemi, un ressort, un but. */
const platform = (over: Record<string, unknown> = {}) => ({
  title: "La grotte aux pièces",
  intro: "Ramasse les pièces puis atteins le drapeau.",
  mode: "platformer",
  map: level({ 11: "......====......", 13: "" }),
  player: { x: 1, y: 13, lives: 3 },
  things: [
    { kind: "coin", x: 6, y: 13 },
    { kind: "coin", x: 8, y: 10 },
    { kind: "slime", x: 10, y: 13 },
    { kind: "goal", x: 20, y: 13, id: "arrivee" },
  ],
  rules: [{ on: "touch", kind: "coin", do: [{ say: "Une pièce !" }] }],
  win: [{ reach: "arrivee" }],
  lose: [{ time: 120 }],
  ...over,
});
/** Un labyrinthe vu de dessus sain. */
const maze = (over: Record<string, unknown> = {}) => ({
  title: "Le labyrinthe",
  mode: "topdown",
  map: level({ 3: "#########.#########", 4: "#.......#.#.......#", 5: "#.#####.#.#.#####.#" }),
  player: { x: 1, y: 8 },
  things: [{ kind: "key", x: 3, y: 8 }, { kind: "door", x: 6, y: 8 }, { kind: "gem", x: 10, y: 8 }, { kind: "skull", x: 15, y: 10 }],
  rules: [],
  win: [{ collect_all: "gem" }],
  ...over,
});
const parse = (raw: unknown) => {
  const r = GameSchema.safeParse(raw);
  if (!r.success) return { forme: r.error.issues.map((i) => `${i.path.join(".")} : ${i.message}`), regles: [] as string[] };
  return { forme: [] as string[], regles: checkGame(r.data) };
};
const problems = (raw: unknown): string[] => { const r = parse(raw); return [...r.forme, ...r.regles]; };

describe("jeu décrit en données : niveaux sains", () => {
  it("accepte un niveau de plateforme et un labyrinthe vu de dessus", () => {
    expect(problems(platform())).toEqual([]);
    expect(problems(maze())).toEqual([]);
  });

  it("accepte des règles variées : temps, score, drapeau, apparition, téléportation, message", () => {
    const rules = [
      { on: "start", do: [{ say: "C'est parti !" }] },
      { on: "timer", every: 5, if: { flag: "ouvert" }, do: [{ spawn: { kind: "bat", x: 12, y: 8 } }] },
      { on: "score", at: 2, do: [{ flag: "ouvert" }, { teleport: { x: 2, y: 13 } }, { gravity: 600 }] },
      { on: "collected_all", kind: "coin", do: [{ win: "Toutes les pièces !" }] },
      { on: "defeat", kind: "slime", do: [{ score: 5 }, { remove: "coin" }] },
    ];
    expect(problems(platform({ rules }))).toEqual([]);
  });
});

describe("jeu décrit en données : forme refusée", () => {
  it("refuse une carte qui n'a pas la bonne taille ou un caractère inconnu", () => {
    expect(problems(platform({ map: level().slice(0, 14) })).join(" ")).toMatch(/15 rangées/);
    expect(problems(platform({ map: level({ 5: "....X" }) })).join(" ")).toMatch(/n'accepte que/);
    const shortRow = level(); // `level` complète les rangées : on raccourcit la rangée à la main
    shortRow[5] = "....";
    expect(problems(platform({ map: shortRow })).join(" ")).toMatch(/24 caractères/);
  });

  it("refuse un champ inconnu, un type d'objet inconnu, un mode inconnu et du code déguisé", () => {
    expect(problems(platform({ script: "alert(1)" })).length).toBeGreaterThan(0);
    expect(problems(platform({ things: [{ kind: "dragon", x: 3, y: 13 }] })).length).toBeGreaterThan(0);
    expect(problems(platform({ mode: "3d" })).length).toBeGreaterThan(0);
    expect(problems(platform({ rules: [{ on: "touch", kind: "coin", do: [{ eval: "alert(1)" }] }] })).length).toBeGreaterThan(0);
    expect(problems(platform({ rules: [{ on: "touch", kind: "coin", do: [{ score: 1, win: "x" }] }] })).length).toBeGreaterThan(0); // deux clés dans un effet
  });

  it("refuse les chevrons dans les textes et les nombres hors limites", () => {
    expect(problems(platform({ title: "<b>gras</b>" })).join(" ")).toMatch(/chevrons/);
    expect(problems(platform({ rules: [{ on: "touch", kind: "coin", do: [{ say: "<img src=x onerror=alert(1)>" }] }] })).join(" ")).toMatch(/chevrons/);
    expect(problems(platform({ physics: { gravity: 99999 } })).length).toBeGreaterThan(0);
    expect(problems(platform({ player: { x: 30, y: 13 } })).length).toBeGreaterThan(0);
  });

  it("refuse une règle mal formée : touch sans objet, timer avec deux déclencheurs, trop d'effets", () => {
    expect(problems(platform({ rules: [{ on: "touch", do: [{ score: 1 }] }] })).join(" ")).toMatch(/dit quel objet/);
    expect(problems(platform({ rules: [{ on: "timer", every: 2, at: 3, do: [{ score: 1 }] }] })).join(" ")).toMatch(/pas les deux/);
    expect(problems(platform({ rules: [{ on: "start", do: Array.from({ length: 7 }, () => ({ score: 1 })) }] })).length).toBeGreaterThan(0);
  });
});

describe("jeu décrit en données : règles du niveau", () => {
  it("refuse un joueur dans un bloc, sur des piques, ou en l'air en plateforme", () => {
    expect(problems(platform({ player: { x: 10, y: 14 } })).join(" ")).toMatch(/dans un bloc/);
    expect(problems(platform({ map: level({ 13: ".^" }), player: { x: 1, y: 13 } })).join(" ")).toMatch(/piques/);
    expect(problems(platform({ player: { x: 1, y: 6 } })).join(" ")).toMatch(/posé sur un bloc/);
  });

  it("refuse un objet dans un bloc, sur des piques, et un ennemi qui flotte", () => {
    expect(problems(platform({ things: [{ kind: "coin", x: 7, y: 11 }], win: [{ collect_all: "coin" }] })).join(" ")).toMatch(/posé dans un bloc/); // dans la plateforme
    expect(problems(platform({ map: level({ 13: ".....^" }), things: [{ kind: "coin", x: 5, y: 13 }], win: [{ collect_all: "coin" }] })).join(" ")).toMatch(/piques/);
    expect(problems(platform({ things: [{ kind: "slime", x: 10, y: 5 }, { kind: "goal", x: 20, y: 13, id: "arrivee" }] })).join(" ")).toMatch(/ennemi qui marche/);
    expect(problems(platform({ things: [{ kind: "bat", x: 10, y: 5 }, { kind: "goal", x: 20, y: 13, id: "arrivee" }] }))).toEqual([]); // une chauve-souris vole
  });

  it("refuse deux objets de même identifiant, une valeur ou un déplacement mal placés", () => {
    expect(problems(platform({ things: [{ kind: "goal", x: 20, y: 13, id: "a" }, { kind: "goal", x: 21, y: 13, id: "a" }], win: [{ reach: "a" }] })).join(" ")).toMatch(/en double/);
    expect(problems(platform({ things: [{ kind: "key", x: 6, y: 13, value: 3 }, { kind: "goal", x: 20, y: 13, id: "arrivee" }] })).join(" ")).toMatch(/« value »/);
    expect(problems(platform({ things: [{ kind: "coin", x: 6, y: 13, move: { pattern: "patrol-x" } }, { kind: "goal", x: 20, y: 13, id: "arrivee" }] })).join(" ")).toMatch(/« move »/);
  });

  it("exige une victoire possible : au moins une condition, un but qui existe, un but pas enfermé, un score atteignable", () => {
    expect(problems(platform({ win: [] })).join(" ")).toMatch(/aucune condition de victoire/);
    expect(problems(platform({ win: [{ reach: "fantome" }] })).join(" ")).toMatch(/ne désigne aucun objet/);
    expect(problems(platform({ win: [{ collect_all: "gem" }] })).join(" ")).toMatch(/aucun « gem »/);
    expect(problems(platform({ win: [{ score: 500 }] })).join(" ")).toMatch(/inatteignable/);
    // un but muré : le drapeau est entouré de blocs
    const walled = platform({ map: level({ 12: "...................###", 13: "...................#.#" }), things: [{ kind: "goal", x: 20, y: 13, id: "arrivee" }] });
    expect(problems(walled).join(" ")).toMatch(/enfermé/);
    // une règle qui gagne remplace la condition de victoire
    expect(problems(platform({ win: [], rules: [{ on: "score", at: 1, do: [{ win: "Gagné" }] }] }))).toEqual([]);
  });

  it("vérifie les références des règles : remove, objet par identifiant, téléportation, gravité", () => {
    expect(problems(platform({ rules: [{ on: "start", do: [{ remove: "other" }] }] })).join(" ")).toMatch(/other/);
    expect(problems(platform({ rules: [{ on: "start", do: [{ remove: "inconnu" }] }] })).join(" ")).toMatch(/ne désigne ni un identifiant/);
    expect(problems(platform({ rules: [{ on: "touch", id: "fantome", do: [{ score: 1 }] }] })).join(" ")).toMatch(/aucun objet d'identifiant/);
    expect(problems(platform({ rules: [{ on: "start", do: [{ teleport: { x: 10, y: 14 } }] }] })).join(" ")).toMatch(/teleport/);
    expect(problems(maze({ rules: [{ on: "start", do: [{ gravity: 400 }] }] })).join(" ")).toMatch(/gravity/);
  });

  it("exige une clé pour ouvrir une porte", () => {
    expect(problems(maze({ things: [{ kind: "door", x: 6, y: 8 }, { kind: "gem", x: 10, y: 8 }] })).join(" ")).toMatch(/aucune clé/);
  });
});

describe("jeu dans une salle", () => {
  const room = (over: Record<string, unknown> = {}) => ({
    format: 1,
    id: "arcade",
    name: "La salle d'arcade",
    theme: "tavern",
    hub: false,
    spawn: [12, 12],
    objects: [],
    npcs: [{ id: "maitre", name: "Maître du jeu", look: "marchand", x: 12, y: 8, dir: "down", lines: ["Tu veux jouer ?"], plays: true }],
    doors: [{ x: 11, to: "forge", label: "Retour à la forge" }],
    game: platform(),
    ...over,
  });
  const errors = (raw: unknown) => { const r = validateRoom(raw); return r.ok ? [] : r.errors; };

  it("accepte une salle avec un jeu proposé par un personnage", () => {
    expect(errors(room())).toEqual([]);
  });

  it("exige un personnage qui propose le jeu, et un seul ; refuse « plays » sans jeu", () => {
    const npcs = [{ id: "maitre", name: "Maître du jeu", look: "marchand", x: 12, y: 8, dir: "down", lines: ["Salut"] }];
    expect(errors(room({ npcs })).join(" ")).toMatch(/personne ne propose ce jeu/);
    expect(errors(room({ game: undefined })).join(" ")).toMatch(/n'a pas de « game »/);
    const two = [...room().npcs, { id: "autre", name: "Autre", look: "noble", x: 14, y: 8, dir: "down", lines: ["Moi aussi"], plays: true }];
    expect(errors(room({ npcs: two })).join(" ")).toMatch(/un seul personnage/);
  });

  it("préfixe les problèmes du jeu pour que celui qui écrit sache où chercher", () => {
    expect(errors(room({ game: platform({ win: [] }) })).join(" ")).toMatch(/game\.win/);
  });
});
