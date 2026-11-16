import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOM_TEMPLATE } from "../rooms/template.js";
import { createHarness, type Harness } from "../testing/harness.js";
import { buildServer } from "./app.js";

const WRITE = { "x-review-agent": "1" };
const room = (over: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(ROOM_TEMPLATE)), ...over });

describe("API des salles créées par les personnes", () => {
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

  const post = (url: string, payload: unknown, headers: Record<string, string> = WRITE) => app.inject({ method: "POST", url, headers, payload: payload as object });
  const list = async () => (await app.inject({ method: "GET", url: "/api/user-rooms" })).json<{ rooms: Array<{ room: { id: string; hub: boolean; doors: Array<{ to: string }> }; owner: { id: number; name: string }; visibility: string; mine: boolean }>; mine: number; max: number }>();

  it("garde une salle privée, la liste avec son auteur, et range le fichier sous l'espace et l'auteur", async () => {
    const res = await post("/api/user-rooms", { room: room({ name: "Ma taverne" }) });
    expect(res.statusCode).toBe(200);
    const saved = res.json<{ id: string; visibility: string }>();
    expect(saved.visibility).toBe("private");
    expect(saved.id).toBe(`u${h.local.userId}-ma-taverne`);

    const out = await list();
    expect(out.mine).toBe(1);
    expect(out.max).toBe(20);
    expect(out.rooms).toHaveLength(1);
    expect(out.rooms[0]).toMatchObject({ visibility: "private", mine: true, owner: { id: h.local.userId } });
    expect(out.rooms[0]!.owner.name.length).toBeGreaterThan(0);
    expect(existsSync(path.join(h.config.dataDir, "rooms", String(h.local.workspaceId), String(h.local.userId), `${saved.id}.json`))).toBe(true);
  });

  it("refuse une demande sans l'en-tête anti-CSRF", async () => {
    expect((await post("/api/user-rooms", { room: room() }, {})).statusCode).toBe(403);
    expect((await post("/api/user-rooms/x/delete", {}, {})).statusCode).toBe(403);
    expect((await list()).rooms).toEqual([]);
  });

  it("impose les règles quoi que dise la salle : pas de porte magique, portes vers la forge, identifiant de l'auteur", async () => {
    const res = await post("/api/user-rooms", { room: room({ id: "throne", hub: true, doors: [{ x: 11, to: "throne", label: "Vers le trône" }] }) });
    expect(res.statusCode).toBe(200);
    const mine = (await list()).rooms[0]!.room;
    expect(mine.hub).toBe(false);
    expect(mine.doors.every((d) => d.to === "forge")).toBe(true);
    expect(mine.id).toMatch(/^u\d+-/);
  });

  it("refuse une salle invalide en donnant les erreurs, et n'écrit rien", async () => {
    const res = await post("/api/user-rooms", { room: room({ theme: "espace" }) });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: string; errors: string[] }>();
    expect(body.error).toMatch(/invalide/);
    expect(body.errors.length).toBeGreaterThan(0);
    expect((await post("/api/user-rooms", {})).statusCode).toBe(400);
    expect((await list()).rooms).toEqual([]);
  });

  it("partage à l'équipe puis reprend en privé, refuse une visibilité inconnue, et supprime", async () => {
    const { id } = (await post("/api/user-rooms", { room: room({ name: "Visite" }) })).json<{ id: string }>();
    expect((await post(`/api/user-rooms/${id}/visibility`, { visibility: "team" })).json()).toEqual({ id, visibility: "team" });
    expect((await list()).rooms[0]!.visibility).toBe("team");
    expect((await post(`/api/user-rooms/${id}/visibility`, { visibility: "public" })).statusCode).toBe(400);
    expect((await post(`/api/user-rooms/${id}/visibility`, { visibility: "private" })).json()).toEqual({ id, visibility: "private" });
    expect((await post(`/api/user-rooms/${id}/delete`, {})).json()).toEqual({ ok: true });
    expect((await list()).rooms).toEqual([]);
    expect((await post(`/api/user-rooms/${id}/delete`, {})).statusCode).toBe(404);
  });

  it("met à jour une de ses salles avec son identifiant, et refuse un identifiant piégé", async () => {
    const { id } = (await post("/api/user-rooms", { room: room({ name: "Avant" }) })).json<{ id: string }>();
    const updated = await post("/api/user-rooms", { id, room: room({ name: "Après" }), visibility: "team" });
    expect(updated.json<{ id: string }>().id).toBe(id);
    expect((await list()).rooms[0]).toMatchObject({ visibility: "team" });
    expect((await list()).rooms).toHaveLength(1);
    expect((await post("/api/user-rooms", { id: "../../x", room: room() })).statusCode).toBe(404);
    expect((await post("/api/user-rooms/..%2F..%2Fx/delete", {})).statusCode).toBe(404);
  });
});
