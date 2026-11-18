import { z } from "zod";
import { loadEngine } from "./engine.js";
import { text } from "./text.js";

/**
 * Format d'un jeu décrit en données (voir docs/jeux.md) : une carte, des objets, une physique, des règles « quand X, alors Y » et des conditions de
 * victoire et de défaite. Le moteur (`public/forge/engine.js`) l'exécute ; rien d'autre ne l'exécute jamais. Les listes (objets, effets, limites)
 * viennent du moteur lui-même : pas de copie qui pourrait dériver.
 */
const E = loadEngine();
const tuple = <T extends string>(list: readonly T[]) => list as unknown as [T, ...T[]];

const LOCAL_ID = /^[a-z][a-z0-9-]{0,19}$/;
const tx = z.number().int().min(0).max(E.W - 1);
const ty = z.number().int().min(0).max(E.H - 1);
const kind = z.enum(tuple(Object.keys(E.KINDS)));
const id = z.string().regex(LOCAL_ID, "identifiant : minuscules, chiffres et tirets, commence par une lettre (20 caractères au plus)");
const msg = text(E.LIMITS.text);

const ThingSchema = z
  .object({
    id: id.optional(),
    kind,
    x: tx,
    y: ty,
    /** Points d'une pièce ou d'une gemme (remplace la valeur de base). */
    value: z.number().int().min(0).max(100).optional(),
    /** Déplacement d'un ennemi (remplace celui de base). */
    move: z
      .object({
        pattern: z.enum(tuple(E.PATTERNS)).optional(),
        range: z.number().int().min(1).max(E.LIMITS.patrolRange).optional(),
        speed: z.number().min(8).max(120).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const Condition = z
  .object({ score_gte: z.number().int().optional(), lives_gte: z.number().int().optional(), keys_gte: z.number().int().optional(), flag: id.optional(), not_flag: id.optional() })
  .strict();

/** Un effet = un objet à UNE seule clé. */
const Effect = z.union([
  z.object({ score: z.number().int().min(-100).max(100) }).strict(),
  z.object({ lives: z.number().int().min(-5).max(5) }).strict(),
  z.object({ keys: z.number().int().min(-5).max(5) }).strict(),
  z.object({ say: msg }).strict(),
  z.object({ remove: z.string().min(1).max(20) }).strict(),
  z.object({ spawn: ThingSchema }).strict(),
  z.object({ teleport: z.object({ x: tx, y: ty }).strict() }).strict(),
  z.object({ bounce: z.number().min(50).max(500) }).strict(),
  z.object({ flag: id }).strict(),
  z.object({ win: msg }).strict(),
  z.object({ lose: msg }).strict(),
  z.object({ gravity: z.number().min(E.PHYSICS.gravity[0]).max(E.PHYSICS.gravity[1]) }).strict(),
  z.object({ speed: z.number().min(E.PHYSICS.speed[0]).max(E.PHYSICS.speed[1]) }).strict(),
  z.object({ jump: z.number().min(E.PHYSICS.jump[0]).max(E.PHYSICS.jump[1]) }).strict(),
]);
const actions = z.array(Effect).min(1).max(E.LIMITS.effects);

const RuleSchema = z.discriminatedUnion("on", [
  z.object({ on: z.literal("start"), if: Condition.optional(), do: actions }).strict(),
  z
    .object({ on: z.literal("touch"), kind: kind.optional(), id: id.optional(), from: z.enum(["above", "below", "side"]).optional(), if: Condition.optional(), do: actions })
    .strict()
    .refine((r) => r.kind !== undefined || r.id !== undefined, "une règle « touch » dit quel objet (kind ou id)"),
  z
    .object({ on: z.literal("defeat"), kind: kind.optional(), id: id.optional(), if: Condition.optional(), do: actions })
    .strict()
    .refine((r) => r.kind !== undefined || r.id !== undefined, "une règle « defeat » dit quel ennemi (kind ou id)"),
  z
    .object({ on: z.literal("timer"), every: z.number().min(0.5).max(120).optional(), at: z.number().min(0).max(600).optional(), if: Condition.optional(), do: actions })
    .strict()
    .refine((r) => (r.every === undefined) !== (r.at === undefined), "une règle « timer » a « every » (répéter) OU « at » (une fois), pas les deux"),
  z.object({ on: z.literal("score"), at: z.number().int().min(1).max(E.LIMITS.score), if: Condition.optional(), do: actions }).strict(),
  z.object({ on: z.literal("collected_all"), kind, if: Condition.optional(), do: actions }).strict(),
]);

const WinSchema = z.union([
  z.object({ score: z.number().int().min(1).max(E.LIMITS.score) }).strict(),
  z.object({ reach: z.string().min(1).max(20) }).strict(),
  z.object({ collect_all: kind }).strict(),
  z.object({ defeat_all: kind }).strict(),
  z.object({ survive: z.number().min(5).max(600) }).strict(),
]);
const LoseSchema = z.object({ time: z.number().min(10).max(600) }).strict();

export const GameSchema = z
  .object({
    title: text(E.LIMITS.title),
    intro: text(E.LIMITS.intro).optional(),
    mode: z.enum(tuple(E.MODES)),
    /** 15 rangées de 24 caractères : `.` vide, `#` bloc, `=` plateforme, `^` piques. */
    map: z.array(z.string().length(E.W, `chaque rangée de la carte fait ${E.W} caractères`).regex(/^[.#=^]+$/, "la carte n'accepte que . # = ^")).length(E.H, `la carte a ${E.H} rangées`),
    player: z.object({ x: tx, y: ty, lives: z.number().int().min(1).max(E.LIMITS.lives).optional() }).strict(),
    physics: z
      .object({
        gravity: z.number().min(E.PHYSICS.gravity[0]).max(E.PHYSICS.gravity[1]).optional(),
        speed: z.number().min(E.PHYSICS.speed[0]).max(E.PHYSICS.speed[1]).optional(),
        jump: z.number().min(E.PHYSICS.jump[0]).max(E.PHYSICS.jump[1]).optional(),
      })
      .strict()
      .optional(),
    things: z.array(ThingSchema).max(E.LIMITS.things).default([]),
    rules: z.array(RuleSchema).max(E.LIMITS.rules).default([]),
    win: z.array(WinSchema).max(6).default([]),
    lose: z.array(LoseSchema).max(2).default([]),
  })
  .strict();

export type GameDef = z.infer<typeof GameSchema>;
type Thing = z.infer<typeof ThingSchema>;

/**
 * Règles du jeu que la forme du fichier ne dit pas : tout est à sa place, le joueur ne naît pas dans un mur, la victoire est possible sur le
 * papier, et le niveau ne plante pas quand on le fait jouer (le même moteur que le navigateur). La jouabilité fine d'un saut n'est pas vérifiée :
 * c'est la personne qui joue son niveau avant de le garder.
 * @param def Jeu déjà conforme à `GameSchema`.
 * @returns Les problèmes, en français, tous à la fois (liste vide : rien à signaler).
 */
export function checkGame(def: GameDef): string[] {
  const errors: string[] = [];
  const tile = (x: number, y: number) => def.map[y]?.[x] ?? "#";
  const solid = (c: string) => c === "#" || c === "=";
  const platformer = def.mode === "platformer";

  const p = def.player;
  if (solid(tile(p.x, p.y))) errors.push("player : le joueur apparaît dans un bloc");
  else if (tile(p.x, p.y) === "^") errors.push("player : le joueur apparaît sur des piques");
  if (platformer && !solid(tile(p.x, p.y + 1))) errors.push("player : en plateforme, le joueur doit apparaître posé sur un bloc (la tuile en dessous est vide)");

  // Tous les objets : de départ et ceux que des règles font apparaître
  const placed: Array<{ name: string; t: Thing }> = def.things.map((t, i) => ({ name: `things.${i} (${t.kind})`, t }));
  def.rules.forEach((r, i) => r.do.forEach((e, j) => { if ("spawn" in e) placed.push({ name: `rules.${i}.do.${j} (spawn ${e.spawn.kind})`, t: e.spawn }); }));

  const ids = new Set<string>();
  const kinds = new Map<string, number>();
  for (const { name, t } of placed) {
    const spec = E.KINDS[t.kind]!;
    kinds.set(t.kind, (kinds.get(t.kind) ?? 0) + 1);
    if (t.id) {
      if (ids.has(t.id)) errors.push(`${name} : identifiant « ${t.id} » en double`);
      ids.add(t.id);
    }
    const c = tile(t.x, t.y);
    if (solid(c)) errors.push(`${name} : posé dans un bloc (${t.x},${t.y})`);
    else if (c === "^") errors.push(`${name} : posé sur des piques (${t.x},${t.y})`);
    if (platformer && spec.group === "enemy" && !spec.flying && !solid(tile(t.x, t.y + 1))) errors.push(`${name} : un ennemi qui marche doit être posé sur un bloc (la tuile en dessous est vide)`);
    if (t.value !== undefined && t.kind !== "coin" && t.kind !== "gem") errors.push(`${name} : « value » n'a de sens que pour coin et gem`);
    if (t.move !== undefined && spec.group !== "enemy") errors.push(`${name} : « move » n'a de sens que pour un ennemi`);
  }

  const known = (v: string) => E.KINDS[v] !== undefined || ids.has(v);
  def.rules.forEach((r, i) => {
    r.do.forEach((e, j) => {
      const where = `rules.${i}.do.${j}`;
      if ("remove" in e) {
        const ok = e.remove === "other" ? r.on === "touch" || r.on === "defeat" : known(e.remove);
        if (!ok) errors.push(`${where} : « remove: ${e.remove} » ne désigne ni un identifiant, ni un type d'objet${e.remove === "other" ? " (« other » ne s'emploie que dans une règle touch ou defeat)" : ""}`);
      }
      if ("teleport" in e && solid(tile(e.teleport.x, e.teleport.y))) errors.push(`${where} : « teleport » vers un bloc (${e.teleport.x},${e.teleport.y})`);
      if ("gravity" in e && !platformer) errors.push(`${where} : « gravity » n'a de sens qu'en plateforme`);
    });
    if ((r.on === "touch" || r.on === "defeat") && r.id !== undefined && !ids.has(r.id)) errors.push(`rules.${i} : aucun objet d'identifiant « ${r.id} »`);
  });

  // Victoire : au moins une, et possible sur le papier
  const hasWinRule = def.rules.some((r) => r.do.some((e) => "win" in e));
  if (def.win.length === 0 && !hasWinRule) errors.push("win : aucune condition de victoire (win ou une règle avec l'effet « win »)");
  const addsScore = def.rules.some((r) => r.do.some((e) => "score" in e && e.score > 0));
  const reach = reachable(def, tile);
  const reachableValue = placed.filter(({ t }) => (t.kind === "coin" || t.kind === "gem") && reach.has(`${t.x},${t.y}`)).reduce((n, { t }) => n + (t.value ?? E.KINDS[t.kind]!.value ?? 0), 0);
  def.win.forEach((c, i) => {
    const w = `win.${i}`;
    if ("reach" in c) {
      const goals = placed.filter(({ t }) => t.kind === c.reach || t.id === c.reach);
      if (goals.length === 0) errors.push(`${w} : « reach: ${c.reach} » ne désigne aucun objet posé (il faut par exemple un « goal »)`);
      else if (!goals.some(({ t }) => reach.has(`${t.x},${t.y}`))) errors.push(`${w} : le but « ${c.reach} » est enfermé : aucun chemin ne mène jusqu'à lui`);
    } else if ("collect_all" in c || "defeat_all" in c) {
      const k = "collect_all" in c ? c.collect_all : c.defeat_all;
      const all = placed.filter(({ t }) => t.kind === k);
      if (all.length === 0) errors.push(`${w} : aucun « ${k} » dans le niveau`);
      else if (all.some(({ t }) => !reach.has(`${t.x},${t.y}`))) errors.push(`${w} : au moins un « ${k} » est enfermé : aucun chemin ne mène jusqu'à lui`);
    } else if ("score" in c && !addsScore && reachableValue < c.score) {
      errors.push(`${w} : score ${c.score} inatteignable, les objets accessibles ne rapportent que ${reachableValue}`);
    }
  });

  // Portes : il faut de quoi les ouvrir
  const doors = kinds.get("door") ?? 0, keys = kinds.get("key") ?? 0;
  if (doors > 0 && keys === 0 && !def.rules.some((r) => r.do.some((e) => "keys" in e && e.keys > 0))) errors.push("door : il y a des portes mais aucune clé pour les ouvrir");

  if (errors.length === 0) errors.push(...E.smoke(def));
  return errors;
}

/**
 * Cases qu'on peut atteindre depuis le départ en ignorant la physique (ni saut ni chute) : sert à repérer un objet ou un but enfermé dans la roche,
 * pas à prouver qu'un saut est faisable. Les portes comptent comme ouvertes.
 */
function reachable(def: GameDef, tile: (x: number, y: number) => string): Set<string> {
  const seen = new Set<string>([`${def.player.x},${def.player.y}`]);
  const queue: Array<[number, number]> = [[def.player.x, def.player.y]];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (nx < 0 || nx >= E.W || ny < 0 || ny >= E.H || seen.has(k) || tile(nx, ny) === "#") continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}
