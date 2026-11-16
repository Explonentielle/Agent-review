import { levelFor } from "./hero.js";

/**
 * L'armurerie de la forge : chaque projet est une arme dont le niveau et la qualité viennent du travail réel de l'agent, et chaque demande
 * de fusion qu'il a ouverte est une pièce forgée, gradée d'après sa performance. Calcul pur, déduit des tâches et reviews existantes.
 */

export type Grade = "common" | "rare" | "epic" | "legendary";

export interface ArmoryProject {
  source: string;
  projectId: number;
  path: string;
  devEnabled: boolean;
}

export interface ArmoryTask {
  id: number;
  source: string;
  project_id: number;
  issue_iid: number;
  issue_title: string;
  status: string;
  files_changed: number | null;
  num_turns: number | null;
  mode: "new" | "followup";
  updated_at: string;
}

export interface ArmoryReview {
  source: string;
  project_id: number;
  status: string;
}

export interface Weapon {
  /** `source:projectId`, stable et commun au dashboard. */
  key: string;
  source: string;
  projectId: number;
  path: string;
  devEnabled: boolean;
  xp: number;
  level: number;
  grade: Grade;
  forged: number;
  reviews: number;
  failures: number;
  blocked: number;
}

export interface LootItem {
  /** `task-<id>`. */
  id: string;
  taskId: number;
  weaponKey: string;
  iid: number;
  title: string;
  grade: Grade;
  score: number;
  /** Or que le marchand en donne (un décor de jeu : rien de réel n'est vendu ni supprimé). */
  value: number;
  at: string;
}

const FORGED = ["mr_created", "mr_updated"];
const REVIEW_DONE = ["needs_human", "auto_ok", "published", "approved"];
const REVIEW_XP = 5;
export const GOLD: Record<Grade, number> = { common: 10, rare: 35, epic: 90, legendary: 250 };

/**
 * Note de performance d'une pièce forgée : un travail plus large et plus direct vaut plus.
 * @param task Tâche terminée par une demande de fusion.
 * @returns Une note de 20 à 100.
 */
export function itemScore(task: Pick<ArmoryTask, "files_changed" | "num_turns" | "mode" | "status">): number {
  const files = Math.min(Math.max(task.files_changed ?? 0, 0), 20) * 1.5;
  const reprise = task.mode === "followup" || task.status === "mr_updated" ? 5 : 0;
  const turns = task.num_turns;
  const efficiency = turns === null ? 0 : turns <= 15 ? 15 : turns <= 30 ? 8 : turns <= 60 ? 3 : 0;
  return Math.min(100, Math.round(20 + files + reprise + efficiency));
}

/**
 * Qualité d'une pièce d'après sa note.
 * @param score Note de performance.
 * @returns Commun sous 35, rare sous 50, épique sous 65, légendaire au-delà.
 */
export function gradeOfScore(score: number): Grade {
  return score >= 65 ? "legendary" : score >= 50 ? "epic" : score >= 35 ? "rare" : "common";
}

/**
 * Qualité d'une arme (un projet) d'après son niveau.
 * @param level Niveau de l'arme.
 * @returns Commun avant le niveau 3, rare à partir de 3, épique à partir de 6, légendaire à partir de 10.
 */
export function gradeOfLevel(level: number): Grade {
  return level >= 10 ? "legendary" : level >= 6 ? "epic" : level >= 3 ? "rare" : "common";
}

/**
 * Calcule les armes (un projet chacune) et les pièces forgées à vendre.
 * @param input Projets configurés, tâches et reviews récentes.
 * @returns Les armes, les plus hautes en niveau d'abord, et les pièces, les plus récentes d'abord.
 */
export function computeArmory(input: { projects: ArmoryProject[]; tasks: ArmoryTask[]; reviews: ArmoryReview[] }): { weapons: Weapon[]; loot: LootItem[] } {
  const keyOf = (source: string, projectId: number) => `${source}:${projectId}`;
  const weapons = new Map<string, Weapon>();
  for (const p of input.projects) {
    weapons.set(keyOf(p.source, p.projectId), { key: keyOf(p.source, p.projectId), source: p.source, projectId: p.projectId, path: p.path, devEnabled: p.devEnabled, xp: 0, level: 1, grade: "common", forged: 0, reviews: 0, failures: 0, blocked: 0 });
  }

  const loot: LootItem[] = [];
  for (const task of input.tasks) {
    const key = keyOf(task.source, task.project_id);
    const weapon = weapons.get(key);
    if (FORGED.includes(task.status)) {
      const score = itemScore(task);
      const grade = gradeOfScore(score);
      loot.push({ id: `task-${task.id}`, taskId: task.id, weaponKey: key, iid: task.issue_iid, title: task.issue_title, grade, score, value: GOLD[grade], at: task.updated_at });
      if (weapon) {
        weapon.forged++;
        weapon.xp += score;
      }
    } else if (weapon && task.status === "error") weapon.failures++;
    else if (weapon && task.status === "blocked") weapon.blocked++;
  }
  for (const review of input.reviews) {
    const weapon = weapons.get(keyOf(review.source, review.project_id));
    if (weapon && REVIEW_DONE.includes(review.status)) {
      weapon.reviews++;
      weapon.xp += REVIEW_XP;
    }
  }

  const list = [...weapons.values()];
  for (const weapon of list) {
    weapon.level = levelFor(weapon.xp);
    weapon.grade = gradeOfLevel(weapon.level);
  }
  list.sort((a, b) => b.level - a.level || b.xp - a.xp || a.path.localeCompare(b.path));
  loot.sort((a, b) => b.taskId - a.taskId);
  return { weapons: list, loot };
}
