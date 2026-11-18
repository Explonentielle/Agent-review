import { existsSync } from "node:fs";
import path from "node:path";
import { TerminalError, type TerminalLaunch } from "./session.js";

/** Taille fixe du terminal : l'outil `script` ne transmet pas les changements de taille de la fenêtre. */
export const TERMINAL_COLS = 100;
export const TERMINAL_ROWS = 30;

/**
 * Entoure un texte de guillemets simples pour un shell.
 * @param value Texte à protéger.
 * @returns Le texte, utilisable tel quel dans une commande shell.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Cherche un programme dans le PATH.
 * @param name Nom du programme.
 * @param pathEnv Valeur du PATH.
 * @param exists Test d'existence (remplaçable dans les tests).
 * @returns Le chemin complet, ou null s'il est introuvable.
 */
export function findExecutable(name: string, pathEnv: string = process.env.PATH ?? "", exists: (file: string) => boolean = existsSync): string | null {
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, name);
    if (exists(file)) return file;
  }
  return null;
}

/**
 * Prépare le lancement du terminal : la CLI `claude` seule, dans un pseudo-terminal fourni par l'outil `script` (présent dans Debian et
 * Ubuntu, donc dans l'image de l'outil), sans paquet natif à compiler. Ce n'est jamais un shell : la commande est construite ici, rien de
 * ce que le navigateur envoie n'y entre. L'environnement est celui, filtré, des agents.
 * @param options `claudeBin` : la CLI ; `env` : environnement filtré ; `cwd` : dossier courant ; `platform` et `which` : remplaçables dans les tests.
 * @returns De quoi lancer la session.
 * @throws TerminalError Si le système n'est pas Linux ou si `script` est introuvable.
 */
export function claudeTerminalLaunch(options: {
  claudeBin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  which?: (name: string) => string | null;
}): TerminalLaunch {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") throw new TerminalError("Le terminal n'est disponible que sur Linux (l'outil tourne ici sur un autre système)");
  const script = (options.which ?? ((name) => findExecutable(name, options.env.PATH)))("script");
  if (!script) throw new TerminalError("Le terminal exige l'outil « script » (paquet bsdutils ou util-linux), introuvable sur cette machine");
  const command = `stty cols ${TERMINAL_COLS} rows ${TERMINAL_ROWS}; exec ${shellQuote(options.claudeBin)}`;
  return {
    file: script,
    args: ["-q", "-f", "-e", "-c", command, "/dev/null"],
    // SHELL forcé : `script -c` s'en sert, et l'utilisateur du conteneur a un shell de connexion désactivé (nologin)
    env: { ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor", SHELL: "/bin/sh" },
    cwd: options.cwd,
  };
}
