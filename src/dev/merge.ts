/**
 * Quand une pièce (la MR faite par l'agent dev) peut-elle être fusionnée depuis l'outil ? Ces règles sont dans du code déterministe, rejouées
 * par le serveur à chaque demande : l'interface ne fait que les afficher, elle ne décide jamais.
 *
 * Une fusion exige, ensemble :
 * - une MR ouverte, qui part de la branche de la tâche et vise la branche cible réglée pour le projet ;
 * - une review de l'agent faite sur le commit de tête actuel, terminée, sans point qui demande l'analyse de la personne ;
 * - une intégration continue qui n'a rien de rouge ni d'en cours.
 * La fusion elle-même est conditionnée au commit relu (voir \`ForgeConnector.mergeChangeRequest\`).
 */
import type { CheckStatus, ChangeRequestState } from "../connectors/types.js";
import type { ReviewStatus } from "../db/reviews.js";

export interface PieceFacts {
  mr: { state: ChangeRequestState; draft: boolean; headSha: string; sourceBranch: string; targetBranch: string };
  /** Branche enregistrée par la tâche de l'agent. */
  taskBranch: string | null;
  /** Branche cible réglée pour le projet (Paramètres > Projets). */
  projectTargetBranch: string;
  /** Dernière review de cette MR (tous commits confondus), ou null. */
  review: { status: ReviewStatus; headSha: string } | null;
  checks: CheckStatus[];
  /** L'état de l'intégration continue n'a pas pu être lu : par prudence, la fusion est refusée plutôt que de supposer que tout va bien. */
  checksError?: string;
}

export interface Readiness {
  /** `merged` : déjà fusionnée. `closed` : fermée sans fusion. `ready` : la fusion est permise. `blocked` : une règle l'interdit (voir `reasons`). */
  state: "merged" | "closed" | "ready" | "blocked";
  ok: boolean;
  /** Ce qui manque, en français, dans l'ordre où la personne peut le régler. */
  reasons: string[];
}

/** Statuts de review qui valent « OK » : l'agent n'a rien trouvé qui demande l'analyse de la personne. */
export const REVIEW_OK: ReviewStatus[] = ["auto_ok", "published", "approved"];
const REVIEW_PENDING: ReviewStatus[] = ["detected", "queued", "running"];
const CI_BAD = ["failed", "canceled", "cancelled"];
const CI_PENDING = ["running", "pending", "created", "waiting_for_resource", "preparing", "scheduled"];

/**
 * Décide si la pièce peut être fusionnée.
 * @param f Faits lus chez la forge et dans l'outil (jamais fournis par le navigateur).
 * @returns L'état de la pièce et les raisons qui bloquent la fusion.
 */
export function mergeReadiness(f: PieceFacts): Readiness {
  if (f.mr.state === "merged") return { state: "merged", ok: false, reasons: ["La MR est déjà fusionnée."] };
  if (f.mr.state === "closed") return { state: "closed", ok: false, reasons: ["La MR est fermée : elle ne peut pas être fusionnée."] };

  const reasons: string[] = [];
  if (!f.taskBranch || f.mr.sourceBranch !== f.taskBranch) {
    reasons.push(`La MR ne part plus de la branche de la tâche (« ${f.taskBranch ?? "inconnue"} », MR : « ${f.mr.sourceBranch} ») : fusionne-la chez la forge.`);
  }
  if (f.mr.targetBranch !== f.projectTargetBranch) {
    reasons.push(`La MR vise « ${f.mr.targetBranch} » mais le projet est réglé sur « ${f.projectTargetBranch} » : l'outil ne fusionne que vers la branche cible du projet.`);
  }

  if (!f.review) reasons.push("Aucune review : lance d'abord la relecture par le Maître juré.");
  else if (f.review.headSha !== f.mr.headSha) reasons.push("La MR a changé depuis la dernière review : relance la relecture sur la version actuelle.");
  else if (REVIEW_PENDING.includes(f.review.status)) reasons.push("La review est en cours : attends son résultat.");
  else if (f.review.status === "needs_human") reasons.push("La review a relevé des points qui demandent ton analyse : lis-la, corrige avec « Corriger avec la relecture » (ou « Reprendre la MR » avec tes consignes), ou fusionne chez la forge si tu les acceptes.");
  else if (f.review.status === "error") reasons.push("La review a échoué : relance-la.");
  else if (f.review.status === "dismissed") reasons.push("La review a été ignorée : relance-la.");

  if (f.checksError) reasons.push(`Impossible de lire l'intégration continue (${f.checksError}) : réessaie dans un instant.`);
  const bad = f.checks.filter((c) => CI_BAD.includes(c.status.toLowerCase()));
  const pending = f.checks.filter((c) => CI_PENDING.includes(c.status.toLowerCase()));
  if (bad.length) reasons.push(`L'intégration continue a échoué : ${bad.map((c) => c.name).slice(0, 4).join(", ")}.`);
  else if (pending.length) reasons.push("L'intégration continue tourne encore : attends sa fin.");

  return reasons.length ? { state: "blocked", ok: false, reasons } : { state: "ready", ok: true, reasons: [] };
}
