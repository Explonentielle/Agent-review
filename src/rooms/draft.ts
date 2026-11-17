import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentRunner } from "../agent/runner.js";
import type { AgentRunConfig } from "../claude/process.js";
import { PROJECT_ROOT } from "../paths.js";
import { COLORS, LIMITS, NPC_LOOKS, OBJECTS, THEMES } from "./catalog.js";
import { loadEngine } from "./engine.js";
import { validateRoom, type Room } from "./schema.js";
import { normalizeUserRoom } from "./userRooms.js";

const E = loadEngine();

/** Ce que l'agent renvoie : la salle sous forme de chaîne JSON (plus robuste qu'un schéma imbriqué) et quelques remarques pour la personne. */
export const DraftOutputSchema = z.object({
  /** La salle complète, sous forme d'une chaîne JSON valide. */
  room_json: z.string(),
  /** De zéro à trois remarques courtes pour la personne. */
  notes: z.array(z.string()),
});
export const draftOutputJsonSchema = z.toJSONSchema(DraftOutputSchema, { target: "draft-7" }) as Record<string, unknown>;

/** Plafond de taille de la chaîne reçue : une salle valide tient dans 64 Ko, au-delà on ne tente même pas de la lire. */
const MAX_JSON_CHARS = 80_000;

/**
 * Catalogue donné à l'agent, GÉNÉRÉ depuis le code (catalogue des salles et moteur de jeu) : il ne peut pas être en retard sur ce que le serveur accepte.
 * @returns Le texte à ajouter au prompt système.
 */
export function roomCatalogPrompt(): string {
  const decor = Object.entries(OBJECTS).map(([type, o]) => {
    const spec = o as { w: number; h: number; solid: boolean; where: string; resizable?: boolean; color?: boolean; text?: boolean };
    const bits = [spec.resizable ? "taille libre (w et h)" : `${spec.w} x ${spec.h}`, spec.where === "wall" ? "mur du fond (rangées 0 à 2)" : "sol (rangées 3 à 13)", spec.solid ? "plein" : "traversable", spec.color ? "color" : null, spec.text ? "text" : null].filter(Boolean);
    return `- \`${type}\` : ${bits.join(", ")}`;
  });
  const game = Object.entries(E.KINDS).map(([kind, k]) => `- \`${kind}\` (${k.group}${k.value ? `, ${k.value} point${k.value > 1 ? "s" : ""}` : ""}${k.flying ? ", vole" : ""})`);
  return [
    "# Catalogue (généré par l'outil : c'est la seule référence)",
    "## Décor de la salle (champ `type` des `objects`)",
    ...decor,
    `Thèmes : ${THEMES.join(", ")}. Apparences de personnages (\`look\`) : ${NPC_LOOKS.join(", ")}. Couleurs (\`color\`) : ${COLORS.join(", ")}. Directions (\`dir\`) : up, down, left, right.`,
    `Limites : ${LIMITS.objects} objets, ${LIMITS.npcs} personnages, ${LIMITS.doors} portes ; 1 à ${LIMITS.lines} répliques de ${LIMITS.lineLength} caractères au plus ; texte d'un objet ${LIMITS.textLength} caractères au plus ; nom de salle ${LIMITS.nameLength}, nom de personnage ${LIMITS.npcNameLength}.`,
    "## Objets du jeu (champ `kind` des `things` et de l'effet `spawn`)",
    ...game,
    `Modes : ${E.MODES.join(", ")}. Déplacements d'un ennemi (\`move.pattern\`) : ${E.PATTERNS.join(", ")} (\`range\` en tuiles, \`speed\` en pixels par seconde). Tuiles de la carte : ${Object.keys(E.TILES).join(" ")}.`,
    `Déclencheurs de règle : ${E.EVENTS.join(", ")}. Effets : ${E.EFFECTS.join(", ")}. Conditions de victoire : ${E.WIN_CONDITIONS.join(", ")}.`,
    `Limites du jeu : ${E.LIMITS.things} objets, ${E.LIMITS.rules} règles, ${E.LIMITS.effects} effets par règle, ${E.LIMITS.text} caractères par message, ${E.LIMITS.lives} vies au plus, physique : gravity ${E.PHYSICS.gravity.join(" à ")}, speed ${E.PHYSICS.speed.join(" à ")}, jump ${E.PHYSICS.jump.join(" à ")}.`,
  ].join("\n");
}

/** Salle d'exemple donnée à l'agent : `prompts/rooms-example.json`, qui n'est PAS une salle livrée (aucune porte n'y mène). Les tests la valident et prouvent son jeu gagnable, pour qu'elle ne dérive pas. */
export async function roomExamplePrompt(): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path.join(PROJECT_ROOT, "prompts", "rooms-example.json"), "utf8")) as Record<string, unknown>;
    return `# Exemple complet et valide (une salle avec un platformer)\n\n\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``;
  } catch {
    return "";
  }
}

const idea = (text: string): string => `<demande>\n${text.replaceAll("</demande>", "</demande_>")}\n</demande>`;

/** Retour d'un contrôle raté, à donner à l'agent pour qu'il corrige. */
interface Feedback {
  json: string;
  problems: string[];
}

/**
 * Message envoyé à l'agent.
 * @param text Demande de la personne.
 * @param feedback Proposition précédente et problèmes trouvés, pour une nouvelle tentative.
 * @returns Le prompt.
 */
export function buildDraftPrompt(text: string, feedback: Feedback | null): string {
  const parts = ["Crée la salle décrite dans la demande ci-dessous, au format JSON du catalogue.", idea(text)];
  if (feedback) {
    parts.push(
      "Ta proposition précédente a été refusée par les contrôles de l'outil. La voici, puis les problèmes à corriger. Corrige-les et garde le reste de la salle.",
      `<proposition_precedente>\n${feedback.json.slice(0, 20_000).replaceAll("</proposition_precedente>", "</proposition_precedente_>")}\n</proposition_precedente>`,
      `Problèmes :\n${feedback.problems.slice(0, 12).map((p) => `- ${p}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export interface DraftInput {
  idea: string;
  systemPrompt: string;
  engine: AgentRunConfig;
  runner: AgentRunner;
  /** Nombre d'essais (l'agent corrige à chaque retour des contrôles). */
  maxAttempts?: number;
  /** Budget du solveur de niveaux. */
  solver?: { maxNodes: number; maxMs: number };
}

export interface DraftResult {
  /** La salle contrôlée et normalisée (identifiant provisoire, pas de porte magique, portes vers la forge). */
  room: Room;
  notes: string[];
  attempts: number;
  costUsd: number | null;
  /** Le jeu a-t-il été gagné par la recherche automatique ? `null` : la salle n'a pas de jeu. `false` : pas prouvé gagnable, à jouer avant de garder. */
  solved: boolean | null;
  warnings: string[];
}

/** L'agent n'a pas réussi à produire une salle valide après tous ses essais. */
export class RoomDraftError extends Error {
  constructor(message: string, readonly problems: string[]) {
    super(message);
    this.name = "RoomDraftError";
  }
}

/** Exécute l'agent. Il n'a AUCUN outil et travaille dans un dossier temporaire vide : il ne peut rien lire ni rien écrire, il ne renvoie que sa proposition. */
async function runArchitect(input: DraftInput, prompt: string): Promise<{ structured: unknown; costUsd: number | null }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "rooms-"));
  try {
    const out = await input.runner.run({
      cwd,
      systemPrompt: input.systemPrompt,
      prompt,
      outputSchema: draftOutputJsonSchema,
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      ...input.engine,
      persistSession: false,
      stream: false,
    });
    return { structured: out.structured, costUsd: out.costUsd };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/**
 * Fait créer une salle (et son jeu) par l'agent, puis la contrôle, et le renvoie à l'agent tant qu'elle n'est pas bonne : d'abord les erreurs de
 * validation (forme, grille, jouabilité de la salle et du jeu), puis, pour un jeu, la recherche automatique d'une victoire. Un niveau qui n'est pas
 * prouvé gagnable après tous les essais est rendu AVEC un avertissement : la personne le joue avant de le garder.
 * @param input Demande, prompts, moteur et exécuteur d'agent.
 * @returns La salle contrôlée.
 * @throws RoomDraftError Si aucune proposition valide après tous les essais (avec les derniers problèmes).
 */
export async function draftRoom(input: DraftInput): Promise<DraftResult> {
  const max = Math.max(1, input.maxAttempts ?? 3);
  const budget = input.solver ?? { maxNodes: 5000, maxMs: 2500 };
  let feedback: Feedback | null = null;
  let cost: number | null = null;
  let lastProblems: string[] = [];
  let kept: { room: Room; notes: string[]; unsolved: boolean } | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    const out = await runArchitect(input, buildDraftPrompt(input.idea, feedback));
    if (out.costUsd !== null) cost = (cost ?? 0) + out.costUsd;

    const parsed = DraftOutputSchema.safeParse(out.structured);
    const json = parsed.success ? parsed.data.room_json : "";
    const fail = (problems: string[]) => { lastProblems = problems; feedback = { json, problems }; };
    if (!parsed.success) { fail(["Ta réponse n'a pas le bon format : il faut `room_json` (une chaîne JSON) et `notes` (une liste de textes)."]); continue; }
    if (json.length > MAX_JSON_CHARS) { fail([`La salle est démesurée (${json.length} caractères) : fais-en une plus petite.`]); continue; }
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      fail([`room_json n'est pas du JSON valide : ${(err as Error).message}. Pas de commentaire, pas de virgule finale.`]);
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { fail(["room_json doit être un objet JSON (la salle)."]); continue; }

    const result = validateRoom(normalizeUserRoom(raw as Record<string, unknown>, "essai"));
    if (!result.ok) { fail(result.errors.slice(0, 12)); continue; }

    const notes = parsed.data.notes.slice(0, 3);
    if (!result.room.game) return { room: result.room, notes, attempts: attempt, costUsd: cost, solved: null, warnings: [] };

    const solved = E.solve(result.room.game, budget);
    if (solved.solved) return { room: result.room, notes, attempts: attempt, costUsd: cost, solved: true, warnings: [] };
    kept = { room: result.room, notes, unsolved: true };
    fail([`game : la recherche automatique n'a pas réussi à gagner ce niveau (${solved.nodes} positions essayées). Rends-le plus facile à atteindre : plateformes plus proches (2 tuiles de haut et de trou au plus), but accessible, moins d'ennemis.`]);
  }

  // Dernier essai : un niveau valide mais pas prouvé gagnable est rendu avec un avertissement plutôt que refusé
  if (kept) {
    return { room: kept.room, notes: kept.notes, attempts: max, costUsd: cost, solved: false, warnings: ["Je n'ai pas réussi à gagner ce niveau automatiquement : joue-le avant de le garder, il est peut-être trop difficile ou impossible."] };
  }
  throw new RoomDraftError("L'architecte n'a pas réussi à produire une salle valide.", lastProblems);
}
