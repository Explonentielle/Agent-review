import path from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_COLS, TERMINAL_ROWS, claudeTerminalLaunch, findExecutable, shellQuote } from "./launch.js";
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
