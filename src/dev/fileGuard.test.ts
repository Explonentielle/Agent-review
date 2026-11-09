import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepoWorkspace } from "../review/workspace.js";
import { FileGuardError, checkChangedFiles, checkEncoding, checkPath } from "./fileGuard.js";

const latin1 = (s: string) => Buffer.from(s, "latin1");
const utf8 = (s: string) => Buffer.from(s, "utf8");

describe("chemins", () => {
  it("accepte les chemins relatifs ordinaires", () => {
    for (const p of ["src/app.php", "a.txt", "dir/sub/.gitignore", "docs/.github-notes.md"]) expect(checkPath(p)).toBeNull();
  });

  it("refuse les chemins absolus, sortants ou dans .git", () => {
    expect(checkPath("/etc/passwd")).toMatch(/absolu/);
    expect(checkPath("C:\\Windows\\x")).toMatch(/absolu/);
    expect(checkPath("../secret")).toMatch(/sortant/);
    expect(checkPath("a/../../b")).toMatch(/sortant/);
    expect(checkPath(".git/hooks/pre-commit")).toMatch(/\.git/);
    expect(checkPath("vendor/lib/.git/config")).toMatch(/\.git/);
    expect(checkPath(".GIT/config")).toMatch(/\.git/);
    expect(checkPath("a\0b")).toMatch(/invalide/);
  });
});

describe("encodage", () => {
  const base = latin1("// libellé réservé\n$a = 1;\n");

  it("refuse un fichier ISO-8859-1 relu en UTF-8 (accents devenus U+FFFD)", () => {
    const corrupted = utf8(base.toString("utf8") + "// ajout\n"); // décodage UTF-8 de octets Latin-1 : U+FFFD
    expect(corrupted.includes(Buffer.from("\uFFFD"))).toBe(true);
    expect(checkEncoding(base, corrupted)).toMatch(/U\+FFFD/);
  });

  it("refuse un fichier ISO-8859-1 réécrit proprement en UTF-8", () => {
    expect(checkEncoding(base, utf8("// libellé réservé\n$a = 2;\n"))).toMatch(/encodage modifié/);
  });

  it("accepte une modification qui préserve les octets ISO-8859-1", () => {
    expect(checkEncoding(base, latin1("// libellé réservé\n$a = 2;\n"))).toBeNull();
  });

  it("accepte l'UTF-8 normal, les fichiers ASCII et les fichiers binaires", () => {
    expect(checkEncoding(utf8("é\n"), utf8("é\nà\n"))).toBeNull();
    expect(checkEncoding(null, utf8("nouveau fichier avec accents é\n"))).toBeNull();
    expect(checkEncoding(latin1("ascii seul\n"), utf8("ascii seul modifié\n"))).toBeNull();
    expect(checkEncoding(Buffer.from([0x89, 0x50, 0x00, 0xff]), Buffer.from([0xef, 0xbf, 0xbd, 0x00]))).toBeNull();
  });

  it("refuse un fichier nouveau qui contient U+FFFD, mais pas si le fichier d'origine en avait déjà", () => {
    expect(checkEncoding(null, utf8("texte \uFFFD\n"))).toMatch(/U\+FFFD/);
    expect(checkEncoding(utf8("déjà \uFFFD\n"), utf8("déjà \uFFFD et plus\n"))).toBeNull();
  });
});

describe("contrôle complet sur un dépôt git", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function setup(): { repo: string; ws: RepoWorkspace; sha: string } {
    root = mkdtempSync(path.join(tmpdir(), "fileguard-"));
    const repo = path.join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "legacy.php"), latin1("<?php // libellé réservé\n$a = 1;\n"));
    writeFileSync(path.join(repo, "app.js"), "export const x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    return { repo, ws: new RepoWorkspace(path.join(root, "repos"), "token-factice"), sha };
  }

  const run = (repo: string, ws: RepoWorkspace, sha: string, changed: string[], limits?: { maxFileBytes: number; maxTotalBytes: number }) =>
    checkChangedFiles({ worktree: repo, changed, readBase: (f) => ws.readFileAtRef(repo, sha, f), limits });

  it("repère un fichier ISO-8859-1 corrompu comme le ferait un outil d'édition en UTF-8", async () => {
    const { repo, ws, sha } = setup();
    // Ce que font Read puis Write : décodage UTF-8 avec remplacement, réécriture en UTF-8
    const lossy = latin1("<?php // libellé réservé\n$a = 1;\n").toString("utf8").replace("$a = 1", "$a = 2");
    writeFileSync(path.join(repo, "legacy.php"), lossy);
    writeFileSync(path.join(repo, "app.js"), "export const x = 2;\n");

    const issues = await run(repo, ws, sha, ["legacy.php", "app.js"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ file: "legacy.php", rule: "encoding" });
    expect(new FileGuardError(issues).message).toMatch(/Push refusé.*legacy\.php/);
  });

  it("accepte une modification d'un fichier ISO-8859-1 qui garde ses octets", async () => {
    const { repo, ws, sha } = setup();
    writeFileSync(path.join(repo, "legacy.php"), latin1("<?php // libellé réservé\n$a = 2;\n"));
    expect(await run(repo, ws, sha, ["legacy.php"])).toEqual([]);
  });

  it("refuse les liens symboliques absolus ou sortants, accepte ceux qui restent dans le dépôt", async () => {
    const { repo, ws, sha } = setup();
    symlinkSync("/etc/passwd", path.join(repo, "abs-link"));
    symlinkSync("../outside.txt", path.join(repo, "out-link"));
    symlinkSync("app.js", path.join(repo, "ok-link"));

    const issues = await run(repo, ws, sha, ["abs-link", "out-link", "ok-link"]);
    expect(issues.map((i) => [i.file, i.rule])).toEqual([
      ["abs-link", "symlink"],
      ["out-link", "symlink"],
    ]);
  });

  it("refuse un fichier trop gros et un ensemble trop gros, ignore les fichiers supprimés", async () => {
    const { repo, ws, sha } = setup();
    writeFileSync(path.join(repo, "big.bin"), Buffer.alloc(3000, 1));
    writeFileSync(path.join(repo, "big2.bin"), Buffer.alloc(3000, 1));

    const issues = await run(repo, ws, sha, ["big.bin", "big2.bin", "deleted.txt"], { maxFileBytes: 2000, maxTotalBytes: 100_000 });
    expect(issues.map((i) => [i.file, i.rule])).toEqual([
      ["big.bin", "size"],
      ["big2.bin", "size"],
    ]);

    const total = await run(repo, ws, sha, ["big.bin", "big2.bin"], { maxFileBytes: 4000, maxTotalBytes: 5000 });
    expect(total).toEqual([expect.objectContaining({ file: "(ensemble)", rule: "size" })]);
  });

  it("refuse un chemin dans .git sans l'ouvrir", async () => {
    const { repo, ws, sha } = setup();
    const issues = await run(repo, ws, sha, [".git/hooks/pre-commit", "../hors-depot"]);
    expect(issues.map((i) => i.rule)).toEqual(["path", "path"]);
  });
});
