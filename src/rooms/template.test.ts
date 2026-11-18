import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { FORGE_ROOM_ID } from "./catalog.js";
import { loadRooms } from "./registry.js";
import { registerRooms } from "./routes.js";
import { validateRoom } from "./schema.js";
import { ROOM_TEMPLATE } from "./template.js";

describe("salle modèle de l'Architecte", () => {
  it("passe toutes les vérifications : forme, grille, jouabilité", () => {
    const result = validateRoom(JSON.parse(JSON.stringify(ROOM_TEMPLATE)));
    expect(result.ok).toBe(true);
  });

  it("se charge comme n'importe quelle salle une fois enregistrée sous son nom, sans aucun problème", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rooms-template-"));
    try {
      writeFileSync(path.join(dir, `${ROOM_TEMPLATE.id}.json`), JSON.stringify(ROOM_TEMPLATE, null, 2));
      const { rooms, problems } = await loadRooms(dir);
      expect(problems).toEqual([]);
      expect(rooms.map((r) => r.id)).toEqual([ROOM_TEMPLATE.id]);
      expect(rooms[0]!.doors.every((d) => d.to === FORGE_ROOM_ID)).toBe(true); // la seule porte ramène à la forge : le modèle n'en suppose aucune autre
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ne porte pas l'identifiant d'une salle livrée : le coller tel quel n'écrase pas la salle du trône", () => {
    expect(ROOM_TEMPLATE.id).not.toBe("throne");
    expect(ROOM_TEMPLATE.id).not.toBe(FORGE_ROOM_ID);
  });

  it("est livré avec les salles par GET /api/rooms", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rooms-template-api-"));
    try {
      const app = Fastify();
      registerRooms(app, dir);
      await app.ready();
      const body = (await app.inject({ method: "GET", url: "/api/rooms" })).json<{ template: { id: string; objects: unknown[] } }>();
      expect(body.template.id).toBe(ROOM_TEMPLATE.id);
      expect(body.template.objects.length).toBe(ROOM_TEMPLATE.objects.length);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
