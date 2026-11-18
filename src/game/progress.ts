/**
 * La forge : ce qui donne envie de revenir. Séries de jours, missions du jour et de la semaine, maîtrises à paliers, rangs de prestige.
 * Comme le reste du jeu, tout est déduit de l'activité réelle (tâches, reviews) : aucune table, et le même historique donne la même progression.
 * Seules les récompenses en or (missions, coffre) sont réclamées dans le navigateur, avec le reste du jeu.
 */
import type { Grade } from "./armory.js";
import { REVIEW_DONE, TASK_FORGED, xpForLevel } from "./hero.js";
import { parseDbDate } from "./workers.js";

const DAY_MS = 86_400_000;

export interface ProgressInput {
  /** Maintenant, en millisecondes. */
  now: number;
  /** Décalage du fuseau du joueur, comme `Date.getTimezoneOffset()` (minutes, positif à l'ouest de UTC). */
  tzOffsetMin: number;
  /** Tâches récentes de l'agent dev. */
  tasks: { status: string; created_at: string; updated_at: string }[];
  /** Reviews récentes. */
  reviews: { status: string; created_at: string; updated_at: string }[];
  /** Totaux depuis le début (les listes ci-dessus sont plafonnées). */
  totals: { forged: number; reviews: number };
  /** Rareté de chaque pièce forgée. */
  pieceGrades: Grade[];
  /** Niveau de chaque arme. */
  weaponLevels: number[];
}

export interface Mission {
  id: string;
  scope: "daily" | "weekly" | "chest";
  title: string;
  hint: string;
  progress: number;
  target: number;
  done: boolean;
  /** Or à réclamer au tableau. */
  gold: number;
  /** Jour (ou lundi de la semaine) auquel la mission appartient : la clé d'une réclamation est `id@period`. */
  period: string;
}

export interface Tier {
  at: number;
  xp: number;
  done: boolean;
}

export interface Mastery {
  id: string;
  title: string;
  unit: string;
  value: number;
  tiers: Tier[];
  /** Paliers franchis. */
  reached: number;
  next: Tier | null;
}

export interface Streak {
  current: number;
  best: number;
  activeToday: boolean;
  /** Une série existe mais rien n'a encore été fait aujourd'hui : elle s'éteint à minuit. */
  atRisk: boolean;
}

export interface Progress {
  streak: Streak;
  daily: Mission[];
  weekly: Mission[];
  chest: Mission;
  masteries: Mastery[];
  /** XP des paliers de maîtrise franchis, à ajouter au héros. */
  bonusXp: number;
}

export interface RankInfo {
  id: string;
  name: string;
  from: number;
  goldBonusPct: number;
  aura: string | null;
  reached: boolean;
}

export interface Prestige {
  rank: RankInfo;
  /** Étoiles gagnées au-delà du dernier rang : une tous les 10 niveaux. */
  stars: number;
  ranks: RankInfo[];
  next: { name: string; level: number; levelsLeft: number; xpLeft: number } | null;
}

const RANKS: Omit<RankInfo, "reached">[] = [
  { id: "iron", name: "Fer", from: 1, goldBonusPct: 0, aura: null },
  { id: "bronze", name: "Bronze", from: 4, goldBonusPct: 5, aura: "#c9803a" },
  { id: "silver", name: "Argent", from: 8, goldBonusPct: 10, aura: "#cfd6e0" },
  { id: "gold", name: "Or", from: 12, goldBonusPct: 15, aura: "#f4c542" },
  { id: "mithril", name: "Mithril", from: 18, goldBonusPct: 20, aura: "#58d0e0" },
  { id: "orichalcum", name: "Orichalque", from: 25, goldBonusPct: 30, aura: "#b068ff" },
];
const STAR_EVERY = 10;

/**
 * Rang de prestige d'un niveau : il donne un bonus d'or chez le marchand, un halo autour du héros et des tenues réservées.
 * @param level Niveau du héros.
 * @param xp XP totale du héros.
 * @returns Le rang, ses étoiles et ce qu'il reste à faire pour le suivant.
 */
export function computePrestige(level: number, xp: number): Prestige {
  const ranks: RankInfo[] = RANKS.map((r) => ({ ...r, reached: level >= r.from }));
  const rank = [...ranks].reverse().find((r) => r.reached)!;
  const last = RANKS[RANKS.length - 1]!;
  const stars = level >= last.from ? Math.floor((level - last.from) / STAR_EVERY) : 0;
  const upcoming = ranks.find((r) => !r.reached);
  const next = upcoming
    ? { name: upcoming.name, level: upcoming.from, levelsLeft: upcoming.from - level, xpLeft: Math.max(0, xpForLevel(upcoming.from) - xp) }
    : (() => {
        const target = last.from + (stars + 1) * STAR_EVERY;
        return { name: `Étoile ${stars + 1}`, level: target, levelsLeft: target - level, xpLeft: Math.max(0, xpForLevel(target) - xp) };
      })();
  return { rank, stars, ranks, next };
}

/** Numéro du jour local d'un instant (0 = 1er janvier 1970). */
const dayOf = (ms: number, tzOffsetMin: number): number => Math.floor((ms - tzOffsetMin * 60_000) / DAY_MS);
/** Numéro du lundi de la semaine d'un jour (le 1er janvier 1970 est un jeudi). */
const mondayOf = (day: number): number => day - ((day + 3) % 7);

interface Counts {
  forged: number;
  reviews: number;
  launched: number;
  actions: number;
}
const empty = (): Counts => ({ forged: 0, reviews: 0, launched: 0, actions: 0 });

/** Séries de jours d'activité : la série en cours (qui survit jusqu'à la fin de la journée) et la meilleure. */
function streakOf(days: Set<number>, today: number): Streak {
  const activeToday = days.has(today);
  let current = 0;
  for (let d = activeToday ? today : today - 1; days.has(d); d--) current++;
  let best = 0;
  for (const day of days) {
    if (days.has(day - 1)) continue; // pas le début d'une série
    let n = 0;
    while (days.has(day + n)) n++;
    best = Math.max(best, n);
  }
  return { current, best, activeToday, atRisk: !activeToday && current > 0 };
}

const DAILY_POOL: { id: string; title: string; hint: string; metric: keyof Counts; target: number; gold: number }[] = [
  { id: "forge1", title: "Forger une pièce", hint: "Confie un ticket à l'apprenti : une demande de fusion ouverte aujourd'hui.", metric: "forged", target: 1, gold: 40 },
  { id: "review2", title: "Contrôler deux lames", hint: "Deux reviews terminées aujourd'hui.", metric: "reviews", target: 2, gold: 40 },
  { id: "launch1", title: "Confier un ticket", hint: "Lance une tâche de l'agent dev aujourd'hui.", metric: "launched", target: 1, gold: 25 },
  { id: "forge2", title: "Double coup", hint: "Deux pièces forgées aujourd'hui.", metric: "forged", target: 2, gold: 80 },
  { id: "review1", title: "Contrôler une lame", hint: "Une review terminée aujourd'hui.", metric: "reviews", target: 1, gold: 25 },
  { id: "busy", title: "Atelier en feu", hint: "Trois actions de tes agents aujourd'hui (tickets lancés, pièces, reviews).", metric: "actions", target: 3, gold: 50 },
];
const CHEST_GOLD = 60;

const WEEKLY: { id: string; title: string; hint: string; metric: keyof Counts | "days"; target: number; gold: number }[] = [
  { id: "forge5", title: "Cinq pièces cette semaine", hint: "Cinq demandes de fusion ouvertes ou mises à jour depuis lundi.", metric: "forged", target: 5, gold: 150 },
  { id: "review10", title: "Dix lames contrôlées", hint: "Dix reviews terminées depuis lundi.", metric: "reviews", target: 10, gold: 150 },
  { id: "days4", title: "Quatre jours à la forge", hint: "Du travail de tes agents quatre jours différents depuis lundi.", metric: "days", target: 4, gold: 200 },
];

const ladder = (id: string, title: string, unit: string, value: number, steps: [number, number][]): Mastery => {
  const tiers = steps.map(([at, xp]) => ({ at, xp, done: value >= at }));
  const reached = tiers.filter((t) => t.done).length;
  return { id, title, unit, value, tiers, reached, next: tiers.find((t) => !t.done) ?? null };
};

/**
 * Calcule la progression qui donne envie de revenir : série, missions, maîtrises.
 * @param input Activité récente, totaux, raretés et niveaux d'armes.
 * @returns Série, missions du jour et de la semaine, coffre, maîtrises et XP bonus.
 */
export function computeProgress(input: ProgressInput): Progress {
  const today = dayOf(input.now, input.tzOffsetMin);
  const monday = mondayOf(today);
  const days = new Set<number>();
  const day = empty();
  const week = empty();
  const weekDays = new Set<number>();

  const note = (ms: number, metric: "forged" | "reviews" | "launched") => {
    if (!Number.isFinite(ms)) return;
    const d = dayOf(ms, input.tzOffsetMin);
    days.add(d);
    if (d === today) { day[metric]++; day.actions++; }
    if (d >= monday && d <= today) { week[metric]++; week.actions++; weekDays.add(d); }
  };
  for (const task of input.tasks) {
    note(parseDbDate(task.created_at), "launched");
    if (TASK_FORGED.includes(task.status)) note(parseDbDate(task.updated_at), "forged");
  }
  for (const review of input.reviews) if (REVIEW_DONE.includes(review.status)) note(parseDbDate(review.updated_at), "reviews");

  const streak = streakOf(days, today);

  const start = ((today % DAILY_POOL.length) + DAILY_POOL.length) % DAILY_POOL.length;
  const daily: Mission[] = [0, 2, 4].map((step) => {
    const def = DAILY_POOL[(start + step) % DAILY_POOL.length]!;
    const progress = Math.min(def.target, day[def.metric]);
    return { id: def.id, scope: "daily", title: def.title, hint: def.hint, progress, target: def.target, done: progress >= def.target, gold: def.gold, period: String(today) };
  });
  const finished = daily.filter((m) => m.done).length;
  const chest: Mission = { id: "chest", scope: "chest", title: "Coffre du jour", hint: "S'ouvre quand les trois missions du jour sont accomplies.", progress: finished, target: daily.length, done: finished === daily.length, gold: CHEST_GOLD, period: String(today) };

  const weekly: Mission[] = WEEKLY.map((def) => {
    const value = def.metric === "days" ? weekDays.size : week[def.metric];
    const progress = Math.min(def.target, value);
    return { id: def.id, scope: "weekly", title: def.title, hint: def.hint, progress, target: def.target, done: progress >= def.target, gold: def.gold, period: String(monday) };
  });

  const count = (grade: Grade) => input.pieceGrades.filter((g) => g === grade).length;
  const masteries: Mastery[] = [
    ladder("forged", "Forgeron", "pièces forgées", input.totals.forged, [[1, 20], [5, 40], [10, 80], [25, 150], [50, 300], [100, 600], [250, 1000]]),
    ladder("reviews", "Œil de maître", "lames contrôlées", input.totals.reviews, [[1, 15], [10, 40], [25, 80], [50, 150], [100, 300], [250, 600]]),
    ladder("streak", "Flamme fidèle", "jours de suite (record)", streak.best, [[3, 30], [7, 80], [14, 150], [30, 300], [60, 600]]),
    ladder("epics", "Chasseur d'éclats", "pièces épiques ou mieux", count("epic") + count("legendary"), [[1, 40], [5, 100], [15, 250]]),
    ladder("legends", "Légende vivante", "pièces légendaires", count("legendary"), [[1, 100], [3, 250], [10, 600]]),
    ladder("weapon", "Maître d'armes", "niveau de la meilleure arme", Math.max(1, ...input.weaponLevels), [[3, 30], [6, 80], [10, 200], [15, 400]]),
  ];
  const bonusXp = masteries.reduce((sum, m) => sum + m.tiers.filter((t) => t.done).reduce((s, t) => s + t.xp, 0), 0);

  return { streak, daily, weekly, chest, masteries, bonusXp };
}
