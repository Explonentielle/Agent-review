import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };

/** Routes qui n'existent que pour le jeu : éteint, elles répondent toutes 404. */
const GAME_ROUTES = ["/api/hero", "/api/forge/armory", "/api/forge/loot", "/api/rooms"];

/** Routes du noyau (tickets, agent dev, pièces, reviews, réglages) : le jeu éteint n'y change rien. */
const CORE_ROUTES = ["/api/stats", "/api/settings", "/api/projects", "/api/tasks", "/api/pieces", "/api/reviews", "/api/secrets"];

describe("drapeau du jeu : routes isolées, noyau intact, type d'arme choisi une seule fois", () => {
  let h: Harness;
  const apps: FastifyInstance[] = [];

  async function server(): Promise<FastifyInstance> {
    const app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
    });
    apps.push(app);
    await app.ready();
    return app;
  }
  const get = (app: FastifyInstance, url: string) => app.inject({ method: "GET", url });
  const post = (app: FastifyInstance, url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object, headers: WRITE });
  const setFlag = (app: FastifyInstance, enabled: unknown) => post(app, "/api/game", { enabled });

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    h.cleanup();
  });

  it("allumé par défaut : le drapeau le dit et les routes du jeu répondent", async () => {
    const app = await server();
    expect((await get(app, "/api/game")).json()).toEqual({ enabled: true });
    for (const url of GAME_ROUTES) expect((await get(app, url)).statusCode, url).toBe(200);
  });

  it("éteint : chaque route du jeu répond 404, le noyau répond comme avant, et le drapeau reste joignable", async () => {
    const app = await server();
    expect((await setFlag(app, false)).json()).toEqual({ enabled: false });
    for (const url of GAME_ROUTES) {
      const res = await get(app, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json<{ error: string }>().error).toMatch(/éteinte/);
    }
    expect((await post(app, "/api/forge/weapon-type", { source: "gitlab", projectId: 1, weaponType: "bow" })).statusCode).toBe(404);
    for (const url of CORE_ROUTES) expect((await get(app, url)).statusCode, url).toBe(200);
    expect((await get(app, "/api/game")).json()).toEqual({ enabled: false });
  });

  it("rallumé : les routes du jeu répondent de nouveau, et le choix survit à une nouvelle instance du serveur", async () => {
    const app = await server();
    await setFlag(app, false);
    await setFlag(app, true);
    for (const url of GAME_ROUTES) expect((await get(app, url)).statusCode, url).toBe(200);
    await setFlag(app, false);
    expect((await get(await server(), "/api/hero")).statusCode).toBe(404); // même base, autre serveur : le drapeau est enregistré
  });

  it("le drapeau refuse une valeur qui n'est pas vrai ou faux, et ne se change pas sans l'en-tête anti-CSRF", async () => {
    const app = await server();
    for (const bad of ["false", 0, null, undefined, {}]) expect((await setFlag(app, bad)).statusCode, String(bad)).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/game", payload: { enabled: false } })).statusCode).toBe(403);
    expect((await get(app, "/api/game")).json()).toEqual({ enabled: true });
  });

  it("le noyau n'est plus lié au jeu : un projet enregistré n'a aucun type d'arme, avant comme après le choix", async () => {
    const app = await server();
    const project = { source: "gitlab", projectId: 1, path: "groupe/projet", devEnabled: true, baseBranch: "develop", targetBranch: "develop", allowedCommands: [], instructions: "" };
    const saved = await post(app, "/api/projects", { ...project, weaponType: "axe" }); // un vieux navigateur peut encore l'envoyer
    expect(saved.statusCode).toBe(200);
    expect(await h.settings.getProject("gitlab", 1)).not.toHaveProperty("weaponType");
    expect((await get(app, "/api/projects")).json<Array<Record<string, unknown>>>().every((p) => !("weaponType" in p))).toBe(true);
  });

  it("type d'arme : par défaut tiré du projet, choisi une fois, jamais changé, jamais pour un projet inconnu", async () => {
    const app = await server();
    const armory = async () => (await get(app, "/api/forge/armory")).json<{ weapons: Array<{ key: string; weaponType: string }>; chosen: string[] }>();
    const before = await armory();
    expect(before.chosen).toEqual([]);
    const byDefault = before.weapons.find((w) => w.key === "gitlab:1")!.weaponType;
    expect(byDefault).toBeTruthy();

    const target = byDefault === "bow" ? "axe" : "bow";
    expect((await post(app, "/api/forge/weapon-type", { source: "gitlab", projectId: 1, weaponType: target })).json()).toEqual({ weaponType: target });
    const after = await armory();
    expect(after.chosen).toEqual(["gitlab:1"]);
    expect(after.weapons.find((w) => w.key === "gitlab:1")!.weaponType).toBe(target);

    expect((await post(app, "/api/forge/weapon-type", { source: "gitlab", projectId: 1, weaponType: target })).statusCode).toBe(200); // même type : sans effet
    const changed = await post(app, "/api/forge/weapon-type", { source: "gitlab", projectId: 1, weaponType: byDefault });
    expect(changed.statusCode).toBe(409);
    expect(changed.json<{ error: string }>().error).toMatch(/ne peut pas être modifié/);
    expect((await armory()).weapons.find((w) => w.key === "gitlab:1")!.weaponType).toBe(target);

    expect((await post(app, "/api/forge/weapon-type", { source: "gitlab", projectId: 999, weaponType: "bow" })).statusCode).toBe(404);
    for (const bad of [{ source: "gitea", projectId: 1, weaponType: "bow" }, { source: "gitlab", projectId: "1", weaponType: "bow" }, { source: "gitlab", projectId: 1.5, weaponType: "bow" }, { source: "gitlab", projectId: 1, weaponType: "canon" }, {}]) {
      expect((await post(app, "/api/forge/weapon-type", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await armory()).chosen).toEqual(["gitlab:1"]);
  });
});
