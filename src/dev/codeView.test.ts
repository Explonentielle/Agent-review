import { describe, expect, it } from "vitest";
import type { Diff } from "../connectors/types.js";
import { CODE_LIMITS, countChanges, summarizeDiffs } from "./codeView.js";

const diff = (over: Partial<Diff> & { diff: string }): Diff => ({ oldPath: "a.php", newPath: "a.php", isNew: false, isDeleted: false, isRenamed: false, ...over });
const hunk = (lines: string[]) => `@@ -1,2 +1,3 @@\n${lines.join("\n")}`;

describe("visualiseur de code : préparation des diffs", () => {
  it("compte les lignes ajoutées et supprimées sans compter le contexte ni la mention de fin de fichier", () => {
    expect(countChanges(hunk([" contexte", "+une", "+deux", "-trois", "\\ No newline at end of file"]))).toEqual({ added: 2, removed: 1 });
    expect(countChanges("")).toEqual({ added: 0, removed: 0 });
  });

  it("donne le type de changement et le bon chemin pour un fichier ajouté, supprimé, renommé et modifié", () => {
    const view = summarizeDiffs([
      diff({ oldPath: "n.php", newPath: "n.php", isNew: true, diff: hunk(["+x"]) }),
      diff({ oldPath: "s.php", newPath: "s.php", isDeleted: true, diff: hunk(["-x"]) }),
      diff({ oldPath: "ancien.php", newPath: "nouveau.php", isRenamed: true, diff: "" }),
      diff({ diff: hunk(["-a", "+b", "+c"]) }),
    ]);
    expect(view.files.map((f) => [f.path, f.oldPath, f.change, f.added, f.removed])).toEqual([
      ["n.php", null, "added", 1, 0],
      ["s.php", null, "deleted", 0, 1],
      ["nouveau.php", "ancien.php", "renamed", 0, 0],
      ["a.php", null, "modified", 2, 1],
    ]);
    expect(view).toMatchObject({ totalFiles: 4, omittedFiles: 0, totalAdded: 3, totalRemoved: 2 });
  });

  it("coupe un gros fichier sur une fin de ligne, en gardant les compteurs du diff entier", () => {
    const big = hunk(Array.from({ length: 50 }, (_, i) => `+ligne ${i}`));
    const view = summarizeDiffs([diff({ diff: big })], { files: 10, charsPerFile: 100, charsTotal: 1000 });
    const file = view.files[0]!;
    expect(file.truncated).toBe(true);
    expect(file.diff.length).toBeLessThanOrEqual(100);
    expect(file.diff.endsWith("\n")).toBe(false);
    expect(big.startsWith(file.diff)).toBe(true);
    expect(file.added).toBe(50);
    expect(view.totalAdded).toBe(50);
  });

  it("respecte le plafond de toute la MR : les fichiers suivants gardent leur nom et leurs compteurs, sans contenu", () => {
    const text = hunk(Array.from({ length: 20 }, (_, i) => `+l${i}`));
    const view = summarizeDiffs([diff({ newPath: "1.php", diff: text }), diff({ newPath: "2.php", diff: text }), diff({ newPath: "3.php", diff: text })], { files: 10, charsPerFile: 1000, charsTotal: text.length + 10 });
    expect(view.files.map((f) => [f.path, f.diff === "", f.truncated])).toEqual([["1.php", false, false], ["2.php", false, true], ["3.php", true, true]]);
    expect(view.files[2]!.added).toBe(20);
  });

  it("au-delà du nombre de fichiers permis, les fichiers sont seulement comptés", () => {
    const many = Array.from({ length: CODE_LIMITS.files + 5 }, (_, i) => diff({ newPath: `f${i}.php`, diff: hunk(["+x"]) }));
    const view = summarizeDiffs(many);
    expect(view.files).toHaveLength(CODE_LIMITS.files);
    expect(view).toMatchObject({ totalFiles: CODE_LIMITS.files + 5, omittedFiles: 5, totalAdded: CODE_LIMITS.files + 5 });
  });

  it("un fichier binaire ou trop gros pour la forge (diff vide) n'est pas signalé comme coupé", () => {
    const view = summarizeDiffs([diff({ newPath: "image.png", diff: "" })]);
    expect(view.files[0]).toMatchObject({ path: "image.png", diff: "", truncated: false, added: 0, removed: 0 });
  });
});
