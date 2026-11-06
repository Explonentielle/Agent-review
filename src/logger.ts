import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

let logDir: string | null = null;

/** Active l'écriture des logs dans DATA_DIR/logs (un fichier JSON lines par jour). */
export function initFileLogging(dataDir: string): void {
  logDir = path.join(dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
}

function write(level: Level, event: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, event, ...data };
  const line = JSON.stringify(entry);

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
  return err instanceof Error ? err.message : String(err);
}
