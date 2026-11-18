import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GRID, OBJECTS } from "./catalog.js";
import { loadRooms } from "./registry.js";
import { ROOMS_DIR, registerRooms } from "./routes.js";
import { validateRoom, type Room } from "./schema.js";

/** Une salle minimale valide : on y ajoute ce qu'on veut tester. */
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 1,
  id: "essai",
  name: "Salle d'essai",
  theme: "castle",
  spawn: [12, 12],
  objects: [],
  npcs: [],
  doors: [{ x: 11, to: "forge", label: "Retour" }],
  ...over,
});
const errorsOf = (raw: unknown): string[] => {
  const r = validateRoom(raw);
  return r.ok ? [] : r.errors;
};
const has = (errors: string[], part: string): boolean => errors.some((e) => e.includes(part));

describe("validation d'une salle", () => {
  it("une salle minimale est valide, avec ses valeurs par défaut", () => {
    const r = validateRoom(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.room.hub).toBe(false);
      expect(r.room.objects).toEqual([]);
    }
  });

  it("refuse ce que le catalogue ne connaît pas : type d'objet, thème, apparence, champ en trop", () => {
    expect(has(errorsOf(base({ objects: [{ type: "ordinateur", x: 3, y: 5 }] })), "objects.0.type")).toBe(true);
    expect(errorsOf(base({ theme: "espace" })).length > 0).toBe(true);
    expect(errorsOf(base({ npcs: [{ id: "a", name: "A", look: "dragon", x: 5, y: 5, lines: ["Salut"] }] })).length > 0).toBe(true);
    expect(errorsOf(base({ script: "alert(1)" })).length > 0).toBe(true); // aucun champ inconnu, donc aucun code
    expect(errorsOf(base({ objects: [{ type: "chest", x: 3, y: 5, onclick: "x" }] })).length > 0).toBe(true);
  });

  it("les identifiants sont des noms sûrs, et « forge » est réservé", () => {
    expect(errorsOf(base({ id: "../etc" })).length > 0).toBe(true);
    expect(errorsOf(base({ id: "Salle Haute" })).length > 0).toBe(true);
    expect(has(errorsOf(base({ id: "forge" })), "réservé")).toBe(true);
    expect(errorsOf(base({ id: "a" })).length).toBe(0); // un seul caractère est permis
  });

  it("les textes : pas de chevrons, pas de caractère de contrôle, longueur bornée", () => {
    const npc = (lines: string[]) => base({ npcs: [{ id: "a", name: "A", look: "brann", x: 12, y: 6, lines }] });
    expect(has(errorsOf(npc(["<img src=x onerror=alert(1)>"])), "chevrons")).toBe(true);
    expect(has(errorsOf(npc(["ligne\u0000cachée"])), "contrôle")).toBe(true);
    expect(errorsOf(npc(["x".repeat(221)])).length > 0).toBe(true);
    expect(errorsOf(npc([])).length > 0).toBe(true);
    expect(errorsOf(npc(["Bonjour {name}, ça va ? « Oui » — c'est l'été."])).length).toBe(0);
    expect(has(errorsOf(base({ name: "<b>Salle</b>" })), "chevrons")).toBe(true);
  });

  it("un objet reste dans la zone qui lui est propre : sol pour les meubles, mur du fond pour les torches", () => {
    expect(has(errorsOf(base({ objects: [{ type: "chest", x: 3, y: 1 }] })), "sort de la zone")).toBe(true); // un coffre dans le mur
    expect(has(errorsOf(base({ objects: [{ type: "torch", x: 3, y: 6 }] })), "sort de la zone")).toBe(true); // une torche au milieu du sol
    expect(has(errorsOf(base({ objects: [{ type: "throne", x: 23, y: 5 }] })), "sort de la zone")).toBe(true); // déborde à droite
    expect(has(errorsOf(base({ objects: [{ type: "pillar", x: 3, y: 13 }] })), "sort de la zone")).toBe(true); // 1 x 2 : déborde en bas
    expect(errorsOf(base({ objects: [{ type: "torch", x: 3, y: 2 }, { type: "chest", x: 3, y: 5 }] })).length).toBe(0);
  });

  it("la taille d'un objet est celle du catalogue, sauf le tapis ; couleur et texte seulement là où c'est prévu", () => {
    expect(has(errorsOf(base({ objects: [{ type: "chest", x: 3, y: 5, w: 4 }] })), "taille de cet objet est fixe")).toBe(true);
    expect(errorsOf(base({ objects: [{ type: "carpet", x: 3, y: 5, w: 4, h: 6, color: "blue" }] })).length).toBe(0);
    expect(has(errorsOf(base({ objects: [{ type: "chair", x: 3, y: 5, color: "red" }] })), "pas de couleur")).toBe(true);
    expect(has(errorsOf(base({ objects: [{ type: "chair", x: 3, y: 5, text: "Une chaise" }] })), "pas porter de texte")).toBe(true);
    expect(has(errorsOf(base({ objects: [{ type: "carpet", x: 20, y: 5, w: 6, h: 2 }] })), "sort de la zone")).toBe(true);
  });

  it("deux objets pleins ne se chevauchent pas ; un tapis passe sous les meubles", () => {
    expect(has(errorsOf(base({ objects: [{ type: "table", x: 3, y: 5 }, { type: "chair", x: 4, y: 6 }] })), "déjà occupée")).toBe(true);
    expect(errorsOf(base({ objects: [{ type: "carpet", x: 3, y: 5, w: 6, h: 3 }, { type: "table", x: 4, y: 5 }] })).length).toBe(0);
  });

  it("un personnage ne se tient ni dans le mur ni dans un meuble, et son identifiant est unique", () => {
    const npc = (id: string, x: number, y: number) => ({ id, name: id, look: "brann", x, y, lines: ["Salut"] });
    expect(has(errorsOf(base({ npcs: [npc("a", 5, 1)] })), "se tient au sol")).toBe(true);
    expect(has(errorsOf(base({ objects: [{ type: "chest", x: 5, y: 5 }], npcs: [npc("a", 5, 5)] })), "déjà occupée")).toBe(true);
    expect(has(errorsOf(base({ npcs: [npc("a", 5, 5), npc("a", 7, 5)] })), "en double")).toBe(true);
  });

  it("l'arrivée est au sol et libre", () => {
    expect(has(errorsOf(base({ spawn: [5, 1] })), "au sol")).toBe(true);
    expect(has(errorsOf(base({ spawn: [5, 5], objects: [{ type: "chest", x: 5, y: 5 }] })), "occupée")).toBe(true);
  });

  it("les portes : au moins une, dans le mur du bas, sans chevauchement", () => {
    expect(errorsOf(base({ doors: [] })).length > 0).toBe(true);
    expect(has(errorsOf(base({ doors: [{ x: 0, to: "forge", label: "A" }] })), "x doit être entre")).toBe(true);
    expect(has(errorsOf(base({ doors: [{ x: 22, to: "forge", label: "A" }] })), "x doit être entre")).toBe(true);
    expect(has(errorsOf(base({ doors: [{ x: 5, to: "forge", label: "A" }, { x: 6, to: "forge", label: "B" }] })), "chevauche")).toBe(true);
    expect(errorsOf(base({ doors: [{ x: 5, to: "forge", label: "A" }, { x: 8, to: "autre", label: "B", spawn: [4, 6] }] })).length).toBe(0);
  });

  it("une salle injouable est refusée : personnage, objet à lire ou porte enfermés", () => {
    // Un mur de colonnes et de caisses ferme le haut de la salle : le personnage derrière est inatteignable
    const wall = Array.from({ length: GRID.width }, (_, x) => ({ type: "crate", x, y: 7 }));
    const closed = base({ objects: wall, npcs: [{ id: "roi", name: "Le Roi", look: "king", x: 12, y: 5, lines: ["Bonjour"] }] });
    expect(has(errorsOf(closed), "Le Roi est inatteignable")).toBe(true);
    // Un coffre à lire, entouré
    const chestBox = base({
      objects: [{ type: "chest", x: 6, y: 5, text: "Un coffre" }, { type: "crate", x: 5, y: 5 }, { type: "crate", x: 7, y: 5 }, { type: "crate", x: 6, y: 4 }, { type: "crate", x: 6, y: 6 }],
    });
    expect(has(errorsOf(chestBox), "on ne peut pas l'atteindre")).toBe(true);
    // Quatre caisses devant la porte (colonnes 10 à 13, rangée 13) : les deux cases d'où on la touche (11,13 et 12,13) sont prises, elle est murée
    const blocked = base({ objects: [{ type: "crate", x: 11, y: 13 }, { type: "crate", x: 12, y: 13 }, { type: "crate", x: 10, y: 13 }, { type: "crate", x: 13, y: 13 }] });
    expect(has(errorsOf(blocked), "inatteignable depuis l'arrivée")).toBe(true);
    // Une seule caisse devant la porte : on la touche encore depuis l'autre case, la salle reste valide
    const partly = base({ objects: [{ type: "crate", x: 11, y: 13 }] });
    expect(errorsOf(partly).length).toBe(0);
    const sealed = base({ objects: Array.from({ length: GRID.width }, (_, x) => ({ type: "barrel", x, y: 13 })) });
    expect(has(errorsOf(sealed), "inatteignable depuis l'arrivée")).toBe(true);
  });

  it("l'ensemble des textes est borné", () => {
    const npcs = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, look: "brann", x: 2 + i * 2, y: 6, lines: Array.from({ length: 8 }, () => "x".repeat(200)) }));
    expect(has(errorsOf(base({ npcs })), "au total")).toBe(true);
  });

  it("le catalogue ne change pas par accident : tailles et zones des objets", () => {
    expect(OBJECTS.throne).toMatchObject({ w: 2, h: 2, solid: true, where: "floor" });
    expect(OBJECTS.torch).toMatchObject({ solid: false, where: "wall" });
    expect(GRID).toMatchObject({ width: 24, height: 15, floorTop: 3, floorBottom: 13, doorRow: 14 });
  });
});

describe("chargement des salles d'un dossier", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "rooms-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const write = (file: string, content: unknown) => writeFileSync(path.join(dir, file), typeof content === "string" ? content : JSON.stringify(content));

  it("charge les salles valides par ordre d'identifiant ; une salle invalide ne bloque pas les autres", async () => {
    write("beta.json", base({ id: "beta" }));
    write("alpha.json", base({ id: "alpha" }));
    write("cassee.json", base({ id: "cassee", theme: "espace" }));
    write("illisible.json", "{ pas du json");
    write("notes.txt", "ignoré");
    const { rooms, problems } = await loadRooms(dir);
    expect(rooms.map((r: Room) => r.id)).toEqual(["alpha", "beta"]);
    expect(problems.map((p) => p.file).sort()).toEqual(["cassee.json", "illisible.json"]);
    expect(problems.find((p) => p.file === "illisible.json")!.errors[0]).toContain("JSON illisible");
  });

  it("le fichier porte le nom de la salle", async () => {
    write("autre-nom.json", base({ id: "essai" }));
    const { rooms, problems } = await loadRooms(dir);
    expect(rooms.length).toBe(0);
    expect(problems[0]!.errors[0]).toContain("essai.json");
  });

  it("une porte vers une salle qui n'existe pas fait refuser la salle ; vers une autre salle ou la forge, c'est permis", async () => {
    write("a.json", base({ id: "a", doors: [{ x: 5, to: "b", label: "Vers B" }, { x: 9, to: "forge", label: "Forge" }] }));
    write("b.json", base({ id: "b" }));
    write("c.json", base({ id: "c", doors: [{ x: 5, to: "fantome", label: "Vers le vide" }] }));
    const { rooms, problems } = await loadRooms(dir);
    expect(rooms.map((r: Room) => r.id)).toEqual(["a", "b"]);
    expect(problems[0]!.errors[0]).toContain("« fantome », qui n'existe pas");
  });

  it("un fichier démesuré est refusé sans être lu, et un dossier absent donne zéro salle", async () => {
    write("gros.json", base({ id: "gros", name: "x".repeat(70 * 1024) }));
    expect((await loadRooms(dir)).problems[0]!.errors[0]).toContain("trop gros");
    expect(await loadRooms(path.join(dir, "inexistant"))).toEqual({ rooms: [], problems: [] });
  });
});

describe("les salles livrées avec l'outil", () => {
  it("toutes passent les vérifications (c'est aussi ce qui protège une salle écrite par un agent)", async () => {
    const { rooms, problems } = await loadRooms(ROOMS_DIR);
    expect(problems).toEqual([]);
    expect(rooms.some((r: Room) => r.id === "throne")).toBe(true);
  });

  it("la salle du trône a une porte vers la forge, une apparition libre et se montre dans la forge", async () => {
    const { rooms } = await loadRooms(ROOMS_DIR);
    const throne = rooms.find((r: Room) => r.id === "throne")!;
    expect(throne.hub).toBe(true);
    expect(throne.doors.some((d) => d.to === "forge")).toBe(true);
    expect(throne.npcs.some((n) => n.look === "king")).toBe(true);
  });
});

describe("GET /api/rooms", () => {
  it("renvoie le catalogue, les salles valides et les problèmes", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rooms-api-"));
    try {
      writeFileSync(path.join(dir, "essai.json"), JSON.stringify(base()));
      writeFileSync(path.join(dir, "mauvaise.json"), JSON.stringify(base({ id: "mauvaise", theme: "espace" })));
      const app = Fastify();
      registerRooms(app, dir);
      await app.ready();
      const body = (await app.inject({ method: "GET", url: "/api/rooms" })).json<{ catalog: { grid: { width: number }; objects: Record<string, unknown>; forge: string }; rooms: Array<{ id: string }>; problems: Array<{ file: string }> }>();
      expect(body.rooms.map((r) => r.id)).toEqual(["essai"]);
      expect(body.problems.map((p) => p.file)).toEqual(["mauvaise.json"]);
      expect(body.catalog.grid.width).toBe(24);
      expect(Object.keys(body.catalog.objects)).toContain("throne");
      expect(body.catalog.forge).toBe("forge");
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
