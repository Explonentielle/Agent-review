import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOM_TEMPLATE } from "./template.js";
import { MAX_ROOMS_PER_USER, RoomStoreError, createRoomStore, ownerOfRoomId } from "./userRooms.js";

const room = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...JSON.parse(JSON.stringify(ROOM_TEMPLATE)), ...over });
async function errorOf(fn: () => unknown): Promise<RoomStoreError> {
  try { await fn(); } catch (err) { return err as RoomStoreError; }
  throw new Error("aucune erreur levée");
}

describe("salles des utilisateurs", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ra-rooms-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("garde une salle PRIVÉE par défaut, avec l'identifiant de son auteur", async () => {
    const store = createRoomStore(root, 1);
    const saved = await store.save(7, room({ name: "La Taverne d'Élodie !" }));
    expect(saved.room.id).toBe("u7-la-taverne-d-elodie");
    expect(saved.meta.visibility).toBe("private");
    expect(ownerOfRoomId(saved.room.id)).toBe(7);
    expect(existsSync(path.join(root, "1", "7", "u7-la-taverne-d-elodie.json"))).toBe(true);
  });

  it("IMPOSE les règles de sécurité quoi que dise la salle : pas de porte magique, portes vers la forge seulement, identifiant de l'auteur", async () => {
    const store = createRoomStore(root, 1);
    const saved = await store.save(7, room({ id: "throne", hub: true, doors: [{ x: 11, to: "autre-salle", label: "Ailleurs", spawn: [5, 5] }] }));
    expect(saved.room.hub).toBe(false);
    expect(saved.room.doors.every((d) => d.to === "forge" && d.spawn === undefined)).toBe(true);
    expect(saved.room.id.startsWith("u7-")).toBe(true);
  });

  it("deux salles de même nom ne s'écrasent pas, et on évite les identifiants déjà pris", async () => {
    const store = createRoomStore(root, 1);
    const a = await store.save(7, room({ name: "Ma salle" }));
    const b = await store.save(7, room({ name: "Ma salle" }));
    expect(new Set([a.room.id, b.room.id]).size).toBe(2);
    const c = await store.save(7, room({ name: "Autre" }), {}, new Set(["u7-autre"]));
    expect(c.room.id).not.toBe("u7-autre");
  });

  it("refuse une salle invalide avec la liste des erreurs, et n'écrit rien", async () => {
    const store = createRoomStore(root, 1);
    const err = await errorOf(() => store.save(7, room({ npcs: [{ id: "x", name: "X", look: "marchand", x: 40, y: 5, dir: "down", lines: ["a"] }] })));
    expect(err.status).toBe(422);
    expect(err.errors.length).toBeGreaterThan(0);
    expect(await store.count(7)).toBe(0);
    expect((await errorOf(() => store.save(7, "pas une salle"))).status).toBe(400);
    expect((await errorOf(() => store.save(7, room(), { visibility: "public" as never }))).message).toMatch(/Visibilité inconnue/);
  });

  it("plafonne le nombre de salles par personne", async () => {
    const store = createRoomStore(root, 1);
    for (let i = 0; i < MAX_ROOMS_PER_USER; i++) await store.save(7, room({ name: `Salle ${i}` }));
    expect((await errorOf(() => store.save(7, room({ name: "Une de trop" })))).status).toBe(409);
    await store.save(8, room({ name: "Une autre personne" })); // le plafond est par personne
  });

  it("une salle privée n'est vue que par son auteur ; partagée à l'équipe, tout l'espace la voit, mais seul l'auteur la modifie", async () => {
    const store = createRoomStore(root, 1);
    const mine = await store.save(7, room({ name: "Secrète" }));
    expect((await store.list(8)).map((s) => s.room.id)).toEqual([]);
    expect(await store.get(8, mine.room.id)).toBeNull();
    expect((await store.list(7)).map((s) => s.room.id)).toEqual([mine.room.id]);

    await store.setVisibility(7, mine.room.id, "team");
    expect((await store.list(8)).map((s) => s.room.id)).toEqual([mine.room.id]);
    expect((await store.get(8, mine.room.id))?.meta.visibility).toBe("team");
    // l'autre personne ne peut ni la changer, ni la supprimer, ni la remplacer
    expect((await errorOf(() => store.setVisibility(8, mine.room.id, "private"))).status).toBe(404);
    expect((await errorOf(() => store.remove(8, mine.room.id))).status).toBe(404);
    expect((await errorOf(() => store.save(8, room(), { id: mine.room.id }))).status).toBe(404);
    expect((await store.get(7, mine.room.id))?.meta.visibility).toBe("team");

    await store.setVisibility(7, mine.room.id, "private");
    expect(await store.get(8, mine.room.id)).toBeNull();
  });

  it("deux espaces ne voient jamais les salles l'un de l'autre, même partagées à l'équipe", async () => {
    const one = createRoomStore(root, 1), two = createRoomStore(root, 2);
    const shared = await one.save(7, room({ name: "Partagée" }), { visibility: "team" });
    expect(await two.list(7)).toEqual([]);
    expect(await two.list(8)).toEqual([]);
    expect(await two.get(8, shared.room.id)).toBeNull();
  });

  it("met à jour une salle en gardant sa date de création, et la supprime", async () => {
    const store = createRoomStore(root, 1);
    const first = await store.save(7, room({ name: "Évolutive" }));
    const again = await store.save(7, room({ name: "Évolutive v2", spawn: [10, 12] }), { id: first.room.id, visibility: "team" });
    expect(again.room.id).toBe(first.room.id);
    expect(again.room.name).toBe("Évolutive v2");
    expect(again.meta.createdAt).toBe(first.meta.createdAt);
    expect(again.meta.visibility).toBe("team");
    await store.remove(7, first.room.id);
    expect(await store.count(7)).toBe(0);
    expect((await errorOf(() => store.remove(7, first.room.id))).status).toBe(404);
  });

  it("ignore un fichier abîmé, modifié à la main ou rangé chez un autre auteur : jamais servi", async () => {
    const store = createRoomStore(root, 1);
    const good = await store.save(7, room({ name: "Bonne" }), { visibility: "team" });
    const dir7 = path.join(root, "1", "7"), dir9 = path.join(root, "1", "9");
    // salle devenue invalide à la main
    const raw = JSON.parse(await readFile(path.join(dir7, `${good.room.id}.json`), "utf8"));
    raw.room.theme = "espace";
    await writeFile(path.join(dir7, "u7-cassee.json"), JSON.stringify({ meta: raw.meta, room: { ...raw.room, id: "u7-cassee" } }));
    await writeFile(path.join(dir7, "u7-illisible.json"), "{pas du json");
    // fichier de l'auteur 7 posé dans le dossier de l'auteur 9
    await mkdir(dir9, { recursive: true });
    await writeFile(path.join(dir9, `${good.room.id}.json`), await readFile(path.join(dir7, `${good.room.id}.json`), "utf8"));
    // meta qui prétend une autre visibilité
    await writeFile(path.join(dir7, "u7-bizarre.json"), JSON.stringify({ meta: { ...raw.meta, visibility: "tout-le-monde" }, room: { ...raw.room, id: "u7-bizarre", theme: "tavern" } }));
    expect((await store.list(8)).map((s) => s.room.id)).toEqual([good.room.id]);
    expect(await store.get(9, "u7-cassee")).toBeNull();
  });

  it("refuse les identifiants piégés : aucun chemin n'est construit depuis une saisie", async () => {
    const store = createRoomStore(root, 1);
    for (const bad of ["../../etc/passwd", "..", "u7-../x", "u7-a/b", "U7-x", "u-x", ""]) {
      expect(ownerOfRoomId(bad)).toBeNull();
      expect(await store.get(7, bad)).toBeNull();
      expect((await errorOf(() => store.remove(7, bad))).status).toBe(404);
      expect((await errorOf(() => store.setVisibility(7, bad, "team"))).status).toBe(404);
    }
    expect((await errorOf(() => store.save(7, room(), { id: "../../x" }))).status).toBe(404);
    expect(() => createRoomStore(root, 0)).toThrow(/Espace invalide/);
    expect((await errorOf(() => store.count(-1))).message).toMatch(/Personne invalide/);
  });

  it("une salle avec un jeu est gardée et relue avec son jeu", async () => {
    const store = createRoomStore(root, 1);
    const game = {
      title: "Mini", mode: "platformer", map: Array.from({ length: 15 }, (_, y) => (y === 14 ? "#".repeat(24) : ".".repeat(24))),
      player: { x: 1, y: 13 }, things: [{ kind: "goal", x: 5, y: 13 }], rules: [], win: [{ reach: "goal" }], lose: [],
    };
    const npcs = [{ id: "mj", name: "Maître", look: "marchand", x: 12, y: 8, dir: "down", lines: ["Joue !"], plays: true }];
    const saved = await store.save(7, room({ name: "Avec jeu", game, npcs }));
    expect((await store.get(7, saved.room.id))?.room.game?.title).toBe("Mini");
    // un jeu injouable est refusé avec un message clair
    const bad = await errorOf(() => store.save(7, room({ name: "Cassé", game: { ...game, win: [] }, npcs })));
    expect(bad.errors.join(" ")).toMatch(/game\.win/);
  });
});
