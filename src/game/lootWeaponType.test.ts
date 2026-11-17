import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../paths.js";
import { WEAPON_TYPE_IDS, computeArmory, defaultWeaponType, type ArmoryProject } from "./armory.js";
import { LOOT_CATALOG, computeDrops, rollDrop, type LootEvent } from "./loot.js";

const weaponOf = (itemId: string) => LOOT_CATALOG.find((i) => i.id === itemId)?.weapon;
const project = (projectId: number, weaponType?: ArmoryProject["weaponType"]): ArmoryProject => ({ source: "gitlab", projectId, path: `g/p${projectId}`, devEnabled: true, ...(weaponType ? { weaponType } : {}) });
const task = (id: number, projectId: number, status = "mr_created") => ({ id, source: "gitlab", project_id: projectId, status, files_changed: 5, num_turns: 10, mode: "new" as const, updated_at: "2026-11-16 10:00:00" });

describe("le type d'arme d'un projet", () => {
  it("les types du serveur sont ceux du catalogue du butin", () => {
    const inCatalog = new Set(LOOT_CATALOG.flatMap((i) => (i.weapon ? [i.weapon] : [])));
    expect([...inCatalog].sort()).toEqual([...WEAPON_TYPE_IDS].sort());
  });

  it("les types et les noms du navigateur (sprites, sélecteur du dashboard) sont ceux du serveur", () => {
    const read = (file: string) => readFileSync(path.join(PROJECT_ROOT, file), "utf8");
    const sprites = read("public/forge/sprites.js");
    const spriteTypes = [...sprites.slice(sprites.indexOf("const TYPES = ["), sprites.indexOf("];", sprites.indexOf("const TYPES = [")) ).matchAll(/id: "(\w+)"/g)].map((m) => m[1]);
    expect([...spriteTypes].sort()).toEqual([...WEAPON_TYPE_IDS].sort());
    const html = read("public/index.html");
    const names = html.match(/const WEAPON_TYPE_NAMES = \{([^}]*)\}/)?.[1] ?? "";
    expect([...names.matchAll(/(\w+):/g)].map((m) => m[1]).sort()).toEqual([...WEAPON_TYPE_IDS].sort());
  });

  it("un projet sans type en reçoit un fixe, toujours le même", () => {
    expect(defaultWeaponType("gitlab", 7)).toBe(defaultWeaponType("gitlab", 7));
    expect(WEAPON_TYPE_IDS).toContain(defaultWeaponType("github", 12345));
    const weapons = computeArmory({ projects: [project(1, "bow"), project(2)], tasks: [], reviews: [] }).weapons;
    expect(weapons.find((w) => w.projectId === 1)?.weaponType).toBe("bow");
    expect(weapons.find((w) => w.projectId === 2)?.weaponType).toBe(defaultWeaponType("gitlab", 2));
  });

  it("une arme qui tombe d'un événement est toujours du type du projet", () => {
    for (const type of WEAPON_TYPE_IDS) {
      for (let i = 0; i < 400; i++) {
        const drop = rollDrop({ id: `forge-${type}-${i}`, kind: "merge", at: "2026-11-16", quality: "epic", weaponType: type });
        const weapon = drop && weaponOf(drop.itemId);
        if (weapon) expect(weapon).toBe(type);
      }
    }
  });

  it("le travail des agents (forge, fusion, review) et la création de projet donnent des armes du type de leur projet", () => {
    const projects = [project(1, "axe"), project(2, "staff")];
    const tasks = Array.from({ length: 300 }, (_, i) => task(i + 1, (i % 2) + 1));
    const reviews = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, status: "approved", updated_at: "2026-11-16 11:00:00", source: "gitlab", project_id: (i % 2) + 1 }));
    const created = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, created_at: "2026-11-16 12:00:00", source: "gitlab", path: `g/p${(i % 2) + 1}` }));
    const drops = computeDrops({ tasks, reviews, mergedTaskIds: tasks.map((t) => t.id), projects: created, weaponProjects: projects });
    // Les identifiants d'événements (`forge-5`, `review-5`, `project-5`...) suivent la parité de celui du projet
    const expected = (eventId: string) => (((Number(eventId.split("-")[1]) - 1) % 2) + 1 === 1 ? "axe" : "staff");
    let weapons = 0;
    for (const drop of drops) {
      const weapon = weaponOf(drop.itemId);
      if (!weapon) continue;
      weapons++;
      expect(weapon).toBe(expected(drop.eventId));
    }
    expect(weapons).toBeGreaterThan(50);
  });

  it("un projet qui n'est plus configuré garde un type fixe, et un événement sans projet reste libre", () => {
    const drops = computeDrops({ tasks: Array.from({ length: 200 }, (_, i) => task(i + 1, 99)), reviews: [], mergedTaskIds: [], weaponProjects: [project(1, "axe")] });
    const types = new Set(drops.flatMap((d) => weaponOf(d.itemId) ?? []));
    expect([...types]).toEqual([defaultWeaponType("gitlab", 99)]);

    const free = computeDrops({ tasks: Array.from({ length: 300 }, (_, i) => ({ ...task(i + 1, 1), source: undefined, project_id: undefined })), reviews: [], mergedTaskIds: [] });
    expect(new Set(free.flatMap((d) => weaponOf(d.itemId) ?? [])).size).toBeGreaterThan(1);
  });

  it("un projet créé dont le type n'est pas encore fixé ne rapporte aucune arme", () => {
    const created = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, created_at: "2026-11-16 12:00:00", source: "gitlab", path: `g/inconnu${i}` }));
    for (let i = 0; i < 300; i++) {
      const drop = rollDrop({ id: `project-${i}`, kind: "project", at: "2026-11-16", quality: "common" });
      if (drop) expect(weaponOf(drop.itemId)).toBeUndefined();
    }
    const drops = computeDrops({ tasks: [], reviews: [], mergedTaskIds: [], projects: created, weaponProjects: [project(1, "axe")] });
    expect(drops.every((d) => weaponOf(d.itemId) === undefined)).toBe(true);
  });

  it("le tirage reste déterministe", () => {
    const e: LootEvent = { id: "forge-1", kind: "forge", at: "2026-11-16", quality: "rare", weaponType: "dagger" };
    expect(rollDrop(e)).toEqual(rollDrop({ ...e }));
  });
});
