import { describe, expect, it } from "vitest";
import type { GitlabDiff } from "../gitlab/types.js";
import { countChangedLines, filterDiffs, findLinkedIssueIids } from "./context.js";

function diff(new_path: string, content = ""): GitlabDiff {
  return { old_path: new_path, new_path, diff: content, new_file: false, renamed_file: false, deleted_file: false };
}

describe("filterDiffs", () => {
  it("retire lockfiles, assets compilés, images et .env", () => {
    const kept = filterDiffs([
      diff("app/Foo.php"),
      diff("composer.lock"),
      diff("package-lock.json"),
      diff("public/js/app.js"),
      diff("resources/img/logo.png"),
      diff(".env.prod"),
      diff("config/.env"),
      diff("resources/js/app.ts"),
    ]).map((d) => d.new_path);
    expect(kept).toEqual(["app/Foo.php", "resources/js/app.ts"]);
  });
});

describe("countChangedLines", () => {
  it("compte les + et - sans les en-têtes de fichier", () => {
    const content = ["--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " contexte", "-ancien", "+nouveau", "+ajout"].join("\n");
    expect(countChangedLines([diff("x", content)])).toBe(3);
  });
});

describe("findLinkedIssueIids", () => {
  it("trouve les tickets dans le titre et la description, sans doublon", () => {
    expect(findLinkedIssueIids({ title: "#163 - Interface epic", description: "Related to #163\nVoir aussi #170." })).toEqual([163, 170]);
  });

  it("ignore les ancres d'URL et les couleurs hexadécimales", () => {
    expect(findLinkedIssueIids({ title: "Fix", description: "https://x.fr/page#12 couleur:#123456" })).toEqual([]);
  });

  it("gère une description nulle", () => {
    expect(findLinkedIssueIids({ title: "(#42) fix", description: null })).toEqual([42]);
  });
});
