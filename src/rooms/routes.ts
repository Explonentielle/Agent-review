import path from "node:path";
import type { FastifyInstance } from "fastify";
import { PROJECT_ROOT } from "../paths.js";
import { COLORS, FORGE_ROOM_ID, GRID, LIMITS, NPC_LOOKS, OBJECTS, THEMES } from "./catalog.js";
import { loadRooms } from "./registry.js";

/** Dossier des salles : dans `public/` pour être livré avec l'image, mais jamais lu tel quel par le navigateur (il passe par l'API). */
export const ROOMS_DIR = path.join(PROJECT_ROOT, "public", "rooms");

/**
 * Route des salles : le catalogue et les salles qui ont passé toutes les vérifications. Les fichiers invalides sont listés à part, pour
 * que celui qui les écrit voie ses erreurs.
 * @param app Serveur.
 * @param dir Dossier des salles (remplaçable dans les tests).
 */
export function registerRooms(app: FastifyInstance, dir: string = ROOMS_DIR): void {
  app.get("/api/rooms", async () => {
    const { rooms, problems } = await loadRooms(dir);
    return {
      catalog: { grid: GRID, objects: OBJECTS, themes: THEMES, looks: NPC_LOOKS, colors: COLORS, limits: LIMITS, forge: FORGE_ROOM_ID },
      rooms,
      problems,
    };
  });
}
