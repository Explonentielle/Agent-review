import { describe, expect, it } from "vitest";
import { GamePrefsSchema, WeaponLockedError, chooseWeaponType, readGamePrefs, setGameEnabled, weaponKey, withWeaponTypes } from "./prefs.js";

/** Magasin de réglages en mémoire : seules les deux méthodes de section servent au jeu. */
function fakeStore(initial?: unknown) {
  let value: unknown = initial ?? null;
  return {
    async getSection(name: string): Promise<unknown> {
      expect(name).toBe("game"); // le jeu ne lit que sa propre section
      return value;
    },
    async saveSection(name: string, next: unknown): Promise<void> {
      expect(name).toBe("game");
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

describe("réglages du jeu", () => {
  it("rien d'enregistré, section illisible ou invalide : allumé, aucun type d'arme choisi", async () => {
    const expected = { enabled: true, weaponTypes: {} };
    expect(await readGamePrefs(fakeStore())).toEqual(expected);
    expect(await readGamePrefs(fakeStore("n'importe quoi"))).toEqual(expected);
    expect(await readGamePrefs(fakeStore({ enabled: "oui" }))).toEqual(expected);
    expect(await readGamePrefs(fakeStore({ weaponTypes: { "gitlab:1": "canon" } }))).toEqual(expected); // un type inconnu invalide toute la section
    expect(GamePrefsSchema.parse({})).toEqual(expected);
  });

  it("le drapeau s'écrit sans toucher aux types d'arme choisis, et inversement", async () => {
    const store = fakeStore();
    await chooseWeaponType(store, "gitlab", 7, "spear");
    expect(await setGameEnabled(store, false)).toEqual({ enabled: false, weaponTypes: { "gitlab:7": "spear" } });
    await chooseWeaponType(store, "github", 7, "dagger"); // même numéro chez une autre forge : une autre clé
    expect(await readGamePrefs(store)).toEqual({ enabled: false, weaponTypes: { "gitlab:7": "spear", "github:7": "dagger" } });
    expect((await setGameEnabled(store, true)).weaponTypes).toEqual({ "gitlab:7": "spear", "github:7": "dagger" });
  });

  it("un type d'arme choisi ne change plus : le même est accepté, un autre est refusé et rien n'est écrit", async () => {
    const store = fakeStore();
    await chooseWeaponType(store, "gitlab", 3, "bow");
    await chooseWeaponType(store, "gitlab", 3, "bow");
    await expect(chooseWeaponType(store, "gitlab", 3, "axe")).rejects.toBeInstanceOf(WeaponLockedError);
    expect((await readGamePrefs(store)).weaponTypes).toEqual({ "gitlab:3": "bow" });
  });

  it("les projets reçoivent leur type choisi, les autres restent sans type (le type par défaut est calculé à l'armurerie)", () => {
    const projects = [{ source: "gitlab", projectId: 1, path: "a" }, { source: "github", projectId: 1, path: "b" }];
    const out = withWeaponTypes(projects, { enabled: true, weaponTypes: { [weaponKey("github", 1)]: "staff" } });
    expect(out).toEqual([{ source: "gitlab", projectId: 1, path: "a" }, { source: "github", projectId: 1, path: "b", weaponType: "staff" }]);
    expect(out[0]).not.toHaveProperty("weaponType");
    expect(projects[1]).not.toHaveProperty("weaponType"); // les projets d'origine ne sont pas modifiés
  });
});
