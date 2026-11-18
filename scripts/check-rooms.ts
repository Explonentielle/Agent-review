/**
 * Vérifie les salles du monde de la forge (public/rooms/*.json) : forme, grille, chevauchements, jouabilité, portes.
 * À lancer après avoir créé ou modifié une salle : `npx tsx scripts/check-rooms.ts`. Code de sortie 1 si une salle est refusée.
 */
import { ROOMS_DIR } from "../src/rooms/routes.js";
import { loadRooms } from "../src/rooms/registry.js";

const { rooms, problems } = await loadRooms(ROOMS_DIR);
for (const room of rooms) console.log(`OK     ${room.id} : ${room.name} (${room.objects.length} objets, ${room.npcs.length} personnages, ${room.doors.length} portes${room.hub ? ", porte dans la forge" : ""})`);
for (const p of problems) {
  console.log(`REFUSÉ ${p.file}`);
  for (const e of p.errors) console.log(`         - ${e}`);
}
if (rooms.length === 0 && problems.length === 0) console.log("Aucune salle dans public/rooms.");
if (problems.length) process.exitCode = 1;
