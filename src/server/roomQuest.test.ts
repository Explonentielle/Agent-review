import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOM_TEMPLATE } from "../rooms/template.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };
interface HeroBody { xp: number; quests: Array<{ id: string }>; extraQuests: Array<{ id: string; done: boolean; xp: number; action: string }>; nextQuest: string | null }

describe("quête « Dessiner ta première salle » dans l'API du héros", () => {
  let h: Harness;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    h = await createHarness();
    app = buildServer({
      config: h.config, forges: h.forges, costs: h.costs, reviews: h.reviews, settings: h.settings, tasks: h.tasks, vault: h.vault, audit: h.audit, accounts: h.accounts, local: h.local,
      enqueueReview: () => undefined, enqueueDev: () => undefined, queueSize: () => 0,
    });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    await h.cleanup();
  });

  const hero = async () => (await app.inject({ method: "GET", url: "/api/hero" })).json<HeroBody>();
  const keep = (name: string) => app.inject({ method: "POST", url: "/api/user-rooms", headers: WRITE, payload: { room: { ...JSON.parse(JSON.stringify(ROOM_TEMPLATE)), name } } });

  it("la quête de l'atelier est à faire au départ, et ne change pas la liste des quêtes de départ", async () => {
    const before = await hero();
    expect(before.extraQuests).toEqual([expect.objectContaining({ id: "room", done: false, action: "architect", xp: 40 })]);
    expect(before.quests.map((q) => q.id)).toEqual(["forge", "claude", "project", "dev", "task", "review"]);
  });

  it("garder une salle accomplit la quête et rapporte de l'XP, plafonnée à trois salles", async () => {
    const before = await hero();
    await keep("Première");
    const one = await hero();
    expect(one.extraQuests[0]!.done).toBe(true);
    expect(one.xp).toBe(before.xp + 40);
    await keep("Deuxième"); await keep("Troisième"); await keep("Quatrième");
    expect((await hero()).xp).toBe(before.xp + 120);
  });

  it("supprimer la dernière salle remet la quête à faire", async () => {
    const { id } = (await keep("Éphémère")).json<{ id: string }>();
    expect((await hero()).extraQuests[0]!.done).toBe(true);
    await app.inject({ method: "POST", url: `/api/user-rooms/${id}/delete`, headers: WRITE });
    expect((await hero()).extraQuests[0]!.done).toBe(false);
  });
});
