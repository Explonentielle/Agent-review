import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { FORGE_ROOM_ID, LIMITS } from "./catalog.js";
import { validateRoom, type Room } from "./schema.js";

export interface RoomProblem {
  /** Nom du fichier (ou « rooms » pour un problème d'ensemble). */
  file: string;
  errors: string[];
}

export interface LoadedRooms {
  rooms: Room[];
  /** Fichiers refusés : une salle invalide n'empêche jamais les autres de se charger. */
  problems: RoomProblem[];
}

/**
 * Lit et valide toutes les salles d'un dossier. Une salle invalide est mise de côté avec ses erreurs, jamais chargée à moitié : le
 * navigateur ne reçoit que des salles qui ont passé toutes les vérifications.
 * @param dir Dossier des salles (`public/rooms`).
 * @returns Les salles valides, triées par identifiant, et les problèmes rencontrés.
 */
export async function loadRooms(dir: string): Promise<LoadedRooms> {
  const problems: RoomProblem[] = [];
  const found = new Map<string, Room>();

  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { rooms: [], problems: [] }; // pas de dossier : pas de salle
  }
  if (files.length > LIMITS.files) {
    problems.push({ file: "rooms", errors: [`${files.length} fichiers : ${LIMITS.files} salles au plus, les suivantes sont ignorées`] });
    files = files.slice(0, LIMITS.files);
  }

  for (const file of files) {
    try {
      const full = path.join(dir, file);
      if ((await stat(full)).size > LIMITS.fileBytes) { problems.push({ file, errors: [`fichier trop gros (${LIMITS.fileBytes} octets au plus)`] }); continue; }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(full, "utf8"));
      } catch (err) {
        problems.push({ file, errors: [`JSON illisible : ${(err as Error).message}`] });
        continue;
      }
      const result = validateRoom(raw);
      if (!result.ok) { problems.push({ file, errors: result.errors }); continue; }
      if (`${result.room.id}.json` !== file) { problems.push({ file, errors: [`le fichier doit s'appeler ${result.room.id}.json`] }); continue; }
      found.set(result.room.id, result.room);
    } catch (err) {
      problems.push({ file, errors: [(err as Error).message] });
    }
  }

  // Les portes ne mènent qu'à la forge ou à une salle qui existe
  const rooms = [...found.values()].filter((room) => {
    const missing = room.doors.filter((d) => d.to !== FORGE_ROOM_ID && !found.has(d.to));
    if (missing.length === 0) return true;
    problems.push({ file: `${room.id}.json`, errors: missing.map((d) => `la porte « ${d.label} » mène à « ${d.to} », qui n'existe pas`) });
    return false;
  });
  return { rooms: rooms.sort((a, b) => a.id.localeCompare(b.id)), problems };
}
