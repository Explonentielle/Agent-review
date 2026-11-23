import { PlanInputError } from "./errors.js";

/** Date avec fuseau explicite (`2026-12-01T09:30:00Z` ou `+01:00`) : sans fuseau, la date serait comprise différemment selon la machine. */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const MAX_AHEAD_MS = 366 * 24 * 3600_000;
/** Une date qui vient de passer (horloge du navigateur en retard, clic tardif) reste acceptée. */
const PAST_TOLERANCE_MS = 5 * 60_000;

/**
 * Date au format de la base : `AAAA-MM-JJ HH:MM:SS` en UTC (comparable comme du texte).
 * @param date Date à convertir.
 * @returns Le texte.
 */
export function toDbTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Date de la base vers le format ISO que le navigateur sait lire.
 * @param value Date de la base (UTC), ou null.
 * @returns La date ISO, ou null.
 */
export function toIso(value: string | null): string | null {
  return value ? `${value.replace(" ", "T")}Z` : null;
}

/**
 * Lit une date de lancement envoyée par le navigateur.
 * @param value Date ISO avec fuseau, ou vide pour « tout de suite ».
 * @param now Date de référence (remplaçable dans les tests).
 * @returns La date au format de la base, ou null si la valeur est vide (ou si la date est déjà passée de peu : à lancer tout de suite).
 * @throws PlanInputError Si la valeur n'est pas une date ISO avec fuseau, est déjà passée depuis longtemps, ou trop lointaine.
 */
export function parseWhen(value: unknown, now: Date = new Date()): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value) || Number.isNaN(Date.parse(value))) throw new PlanInputError("Date invalide.");
  const at = Date.parse(value);
  if (at < now.getTime() - PAST_TOLERANCE_MS) throw new PlanInputError("Cette date est déjà passée.");
  if (at > now.getTime() + MAX_AHEAD_MS) throw new PlanInputError("Cette date est trop lointaine (un an au plus).");
  return at <= now.getTime() ? null : toDbTime(new Date(at));
}
