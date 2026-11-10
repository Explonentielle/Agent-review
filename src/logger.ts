import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

let logDir: string | null = null;

/** Active l'écriture des logs dans DATA_DIR/logs (un fichier JSON lines par jour). */
export function initFileLogging(dataDir: string): void {
  logDir = path.join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
}

/** Valeurs secrètes connues (jetons, clés) : remplacées par « [secret] » dans les journaux et les messages d'erreur. */
const secretValues = new Set<string>();
/** Longueur minimale d'un secret masqué : en dessous, le masquage ferait disparaître des mots courants. */
const MIN_SECRET_LENGTH = 8;

/**
 * Déclare une valeur secrète à ne jamais écrire dans les journaux.
 * @param value Jeton ou clé ; ignoré s'il est vide ou trop court pour être distinctif.
 * @returns Rien.
 */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= MIN_SECRET_LENGTH) secretValues.add(value);
}

/**
 * Remplace les secrets connus dans un texte.
 * @param text Texte brut (message d'erreur...).
 * @returns Le texte, les secrets remplacés par « [secret] ».
 */
export function maskSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues) out = out.split(secret).join("[secret]");
  return out;
}

/**
 * Remplace les secrets connus dans une ligne JSON, où ils apparaissent avec les échappements JSON.
 * @param line Ligne de journal sérialisée.
 * @returns La ligne, les secrets remplacés par « [secret] ».
 */
function maskJsonLine(line: string): string {
  let out = line;
  for (const secret of secretValues) out = out.split(JSON.stringify(secret).slice(1, -1)).join("[secret]");
  return out;
}

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  const line = maskJsonLine(JSON.stringify(entry));

  if (level === "error") console.error(line);
  else console.log(line);

  if (logDir) {
    const file = path.join(logDir, `${entry.ts.slice(0, 10)}.jsonl`);
    try {
      appendFileSync(file, line + "\n");
    } catch {
      // Le log fichier ne doit jamais faire tomber le process
    }
  }
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => write("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => write("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => write("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => write("error", event, data),
};

export function errorMessage(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}
