import { describe, expect, it } from "vitest";
import { assertBranchAllowed, isSecretFile, isSensitiveFile, matchesBranchPattern } from "./guard.js";
import { cleanCommitSubject, ensureDraftTitle, renderTemplate, slugify } from "./templates.js";

const ctx = { issueIid: 163, forbidden: ["develop", "global", "release/*"] };

describe("assertBranchAllowed", () => {
  it("accepte la branche du ticket", () => {
    expect(() => assertBranchAllowed("feature/163-interface-epic", ctx)).not.toThrow();
  });

  it("refuse les branches partagées, même absentes des réglages", () => {
    for (const b of ["master", "main", "develop", "global", "intermediaire", "release/2.92", "hotfix-163"]) {
      expect(() => assertBranchAllowed(b, { issueIid: 163, forbidden: [] })).toThrow(/Push refusé/);
    }
  });

  it("refuse une branche qui correspond à un motif protégé", () => {
    expect(() => assertBranchAllowed("release/163-x", ctx)).toThrow(/Push refusé/);
    expect(() => assertBranchAllowed("feature/163-x", { issueIid: 163, forbidden: ["feature/*"] })).toThrow(/protégée/);
  });

  it("exige le numéro exact du ticket", () => {
    expect(() => assertBranchAllowed("feature/1634-x", ctx)).toThrow(/numéro du ticket/);
    expect(() => assertBranchAllowed("feature/x", ctx)).toThrow(/numéro du ticket/);
  });

  it("refuse les noms dangereux", () => {
    for (const b of ["feature/163 x", "../163", "-163", "feature/163/", "feature/163.lock", "feature/163;rm"]) {
      expect(() => assertBranchAllowed(b, ctx)).toThrow(/invalide/);
    }
  });
});

describe("matchesBranchPattern", () => {
  it("gère le joker GitLab", () => {
    expect(matchesBranchPattern("release/*", "release/2.92")).toBe(true);
    expect(matchesBranchPattern("release/*", "feature/release")).toBe(false);
    expect(matchesBranchPattern("develop", "develop2")).toBe(false);
  });
});

describe("isSecretFile / isSensitiveFile", () => {
  it("bloque les secrets, laisse passer les exemples", () => {
    expect(isSecretFile(".env")).toBe(true);
    expect(isSecretFile("config/.env.prod")).toBe(true);
    expect(isSecretFile("certs/server.key")).toBe(true);
    expect(isSecretFile(".env.example")).toBe(false);
    expect(isSecretFile("app/Environment.php")).toBe(false);
  });

  it("signale CI, Docker et dépendances", () => {
    expect(isSensitiveFile(".gitlab-ci.yml")).toBe(true);
    expect(isSensitiveFile("docker/docker-compose.prod.yml")).toBe(true);
    expect(isSensitiveFile("composer.json")).toBe(true);
    expect(isSensitiveFile("app/Http/Controller.php")).toBe(false);
  });
});

describe("templates", () => {
  it("slugifie les titres pour les noms de branche", () => {
    expect(slugify("Amélioration de la review IA (3)")).toBe("amelioration-de-la-review-ia-3");
    expect(slugify("  --Été 2026 : ça marche !-- ")).toBe("ete-2026-ca-marche");
    expect(slugify("a".repeat(150)).length).toBe(100);
    expect(renderTemplate("feature/{iid}-{slug}", { iid: 2563, title: "", slug: slugify("Recherche naturelle | Extraction des critères du prompt à l'aide d'un LLM") })).toBe(
      "feature/2563-recherche-naturelle-extraction-des-criteres-du-prompt-a-l-aide-d-un-llm",
    );
  });

  it("rend les variables et laisse visibles les inconnues", () => {
    expect(renderTemplate("feature/{iid}-{slug}", { iid: 163, title: "Interface epic" })).toBe("feature/163-interface-epic");
    expect(renderTemplate("#{iid} - {summary}", { iid: 163, title: "t", summary: "Ajout de l'écran" })).toBe("#163 - Ajout de l'écran");
    expect(renderTemplate("{iid}-{inconnu}", { iid: 1, title: "t" })).toBe("1-{inconnu}");
  });

  it("nettoie le message de commit proposé par l'agent", () => {
    const raw = "Fix add function\n\nThe add function was wrong.\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>";
    expect(cleanCommitSubject(raw, "x")).toBe("Fix add function");
    expect(cleanCommitSubject("Co-Authored-By: Claude <a@b>", "Titre du ticket")).toBe("Titre du ticket");
    expect(cleanCommitSubject("#163 - Ajout de l'export", "x")).toBe("Ajout de l'export");
    expect(cleanCommitSubject("", "Titre du ticket")).toBe("Titre du ticket");
  });

  it("force toujours le Draft sur le titre de MR", () => {
    expect(ensureDraftTitle("#163 - Interface")).toBe("Draft: #163 - Interface");
    expect(ensureDraftTitle("Draft: #163 - Interface")).toBe("Draft: #163 - Interface");
    expect(ensureDraftTitle("[Draft] #163")).toBe("[Draft] #163");
  });
});
