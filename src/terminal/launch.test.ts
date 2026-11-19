import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DockerRuntime } from "../agent/dockerRunner.js";
import { TERMINAL_COLS, TERMINAL_ROWS, claudeTerminalLaunch, containerTerminalLaunch, findExecutable, shellQuote } from "./launch.js";
import { TerminalError } from "./session.js";

const base = { claudeBin: "/home/app/.local/bin/claude", env: { PATH: "/usr/bin", HOME: "/app/data/home" }, cwd: "/app/data" };

describe("lancement du terminal Claude", () => {
  it("shellQuote protège les apostrophes", () => {
    expect(shellQuote("simple")).toBe("'simple'");
    expect(shellQuote("l'ami")).toBe(`'l'\\''ami'`);
  });

  it("findExecutable parcourt le PATH dans l'ordre", () => {
    const pathEnv = ["/a", "/b", "/c"].join(path.delimiter);
    const target = path.join("/b", "script");
    expect(findExecutable("script", pathEnv, (file) => file === target)).toBe(target);
    expect(findExecutable("script", pathEnv, () => false)).toBeNull();
  });

  it("lance la CLI seule dans un pseudo-terminal de taille fixe, avec TERM et SHELL imposés", () => {
    const launch = claudeTerminalLaunch({ ...base, platform: "linux", which: () => "/usr/bin/script" });
    expect(launch.file).toBe("/usr/bin/script");
    expect(launch.args.slice(0, 4)).toEqual(["-q", "-f", "-e", "-c"]);
    expect(launch.args[4]).toBe(`stty cols ${TERMINAL_COLS} rows ${TERMINAL_ROWS}; exec '/home/app/.local/bin/claude'`);
    expect(launch.args[5]).toBe("/dev/null");
    expect(launch.env.TERM).toBe("xterm-256color");
    expect(launch.env.SHELL).toBe("/bin/sh");
    expect(launch.env.HOME).toBe("/app/data/home");
    expect(launch.cwd).toBe("/app/data");
  });

  it("le chemin de la CLI ne peut pas injecter de commande", () => {
    const launch = claudeTerminalLaunch({ ...base, claudeBin: "/x/cl'; rm -rf /; '", platform: "linux", which: () => "/usr/bin/script" });
    expect(launch.args[4]).toContain(`exec '/x/cl'\\''; rm -rf /; '\\'''`);
  });

  it("refuse hors Linux ou sans l'outil script, avec un message clair", () => {
    expect(() => claudeTerminalLaunch({ ...base, platform: "win32", which: () => "x" })).toThrow(TerminalError);
    expect(() => claudeTerminalLaunch({ ...base, platform: "linux", which: () => null })).toThrow(/script/);
  });
});

describe("lancement du terminal Claude dans un conteneur", () => {
  const RUNTIME: DockerRuntime = { image: "review-agent:local", memory: "1536m", cpus: 1, pids: 256, network: null, dockerBin: "/usr/bin/docker", containerUser: "host" };
  const TOKEN = "jeton-abonnement-du-terminal-a-ne-pas-montrer";
  const dirs: string[] = [];
  const workDir = () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "terminal-conteneur-")), "terminal");
    dirs.push(path.dirname(dir));
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("la CLI seule dans un conteneur isolé en pseudo-terminal, avec un seul dossier monté et le jeton hors des arguments", async () => {
    const dir = workDir();
    process.env.GITLAB_TOKEN = "jeton-gitlab-de-l-outil";
    try {
      const launch = await containerTerminalLaunch({ runtime: RUNTIME, credentials: { oauthToken: TOKEN }, workDir: dir, platform: "linux", which: () => "/usr/bin/script" });
      expect(launch.file).toBe("/usr/bin/script");
      expect(launch.args.slice(0, 4)).toEqual(["-q", "-f", "-e", "-c"]);
      const command = launch.args[4]!;
      expect(command.startsWith(`stty cols ${TERMINAL_COLS} rows ${TERMINAL_ROWS}; exec '/usr/bin/docker' 'run' '--rm' '-it'`)).toBe(true);
      for (const protection of ["'--read-only'", "'--cap-drop'", "'no-new-privileges'", "'--pids-limit'"]) expect(command).toContain(protection);
      expect(command.match(/'--mount'/g)).toHaveLength(1);
      expect(command).toContain(`'type=bind,src=${dir},dst=/work'`);
      expect(command.endsWith("'review-agent:local' 'claude'")).toBe(true);
      expect(command).toMatch(/'--name' 'ra-term-[0-9a-f]{12}'/);
      expect(launch.cwd).toBe(dir);
      // Le jeton ne voyage que par l'environnement du client docker : ni arguments, ni secrets de l'outil
      expect(launch.args.join(" ")).not.toContain(TOKEN);
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(launch.env.GITLAB_TOKEN).toBeUndefined();
      expect(launch.env.SHELL).toBe("/bin/sh");
      expect(typeof launch.cleanup).toBe("function");
    } finally {
      delete process.env.GITLAB_TOKEN;
    }
  });

  it("sans jeton : aucun identifiant dans l'environnement du client docker", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "jeton-du-shell-de-l-outil";
    try {
      const launch = await containerTerminalLaunch({ runtime: RUNTIME, credentials: null, workDir: workDir(), platform: "linux", which: () => "/usr/bin/script" });
      expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  });

  it("refuse hors Linux, sans l'outil script, ou avec un dossier de travail qui pourrait ajouter un montage", async () => {
    const dir = workDir();
    const options = { runtime: RUNTIME, credentials: null, workDir: dir, platform: "linux" as const, which: () => "/usr/bin/script" };
    await expect(containerTerminalLaunch({ ...options, platform: "win32" })).rejects.toBeInstanceOf(TerminalError);
    await expect(containerTerminalLaunch({ ...options, which: () => null })).rejects.toThrow(/script/);
    await expect(containerTerminalLaunch({ ...options, workDir: "relatif/dossier" })).rejects.toThrow(/invalide/);
    await expect(containerTerminalLaunch({ ...options, workDir: `${dir},src=/etc` })).rejects.toThrow(/invalide/);
    // Un dossier refusé n'est jamais créé : la validation passe avant la création
    expect(existsSync("relatif")).toBe(false);
    expect(existsSync(`${dir},src=/etc`)).toBe(false);
  });
});
