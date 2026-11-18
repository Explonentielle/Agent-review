import { describe, expect, it } from "vitest";
import type { ReviewStatus } from "../db/reviews.js";
import { mergeReadiness, type PieceFacts } from "./merge.js";

const SHA = "a".repeat(40);

/** Une pièce prête : MR ouverte de la bonne branche vers la bonne cible, review OK sur le commit actuel, CI verte. */
const ready = (over: Partial<PieceFacts> = {}): PieceFacts => ({
  mr: { state: "opened", draft: true, headSha: SHA, sourceBranch: "feature/609-x", targetBranch: "develop" },
  taskBranch: "feature/609-x",
  projectTargetBranch: "develop",
  review: { status: "auto_ok", headSha: SHA },
  checks: [{ name: "phpunit", status: "success" }],
  ...over,
});

describe("quand la pièce peut-elle être fusionnée", () => {
  it("une MR de l'agent (en brouillon), relue sans point à analyser sur le commit actuel, CI verte : la fusion est permise", () => {
    expect(mergeReadiness(ready())).toEqual({ state: "ready", ok: true, reasons: [] });
  });

  it("une MR sans aucune CI est permise, et « publiée » ou « approuvée » valent « OK » comme « auto_ok »", () => {
    expect(mergeReadiness(ready({ checks: [] })).ok).toBe(true);
    for (const status of ["auto_ok", "published", "approved"] as const) expect(mergeReadiness(ready({ review: { status, headSha: SHA } })).ok).toBe(true);
  });

  it("sans review, la fusion est refusée et la raison dit quoi faire", () => {
    const r = mergeReadiness(ready({ review: null }));
    expect(r).toMatchObject({ state: "blocked", ok: false });
    expect(r.reasons[0]).toContain("lance d'abord la relecture");
  });

  it("une review d'un ancien commit ne vaut rien : la MR a changé depuis", () => {
    const r = mergeReadiness(ready({ review: { status: "auto_ok", headSha: "b".repeat(40) } }));
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toContain("a changé depuis la dernière review");
  });

  it("review en cours, en attente, échouée, ignorée ou qui demande l'analyse : refus, avec une raison propre à chaque cas", () => {
    const why = (status: ReviewStatus) => mergeReadiness(ready({ review: { status, headSha: SHA } })).reasons[0]!;
    expect(why("running")).toContain("en cours");
    expect(why("queued")).toContain("en cours");
    expect(why("detected")).toContain("en cours");
    expect(why("needs_human")).toContain("demandent ton analyse");
    expect(why("error")).toContain("a échoué");
    expect(why("dismissed")).toContain("ignorée");
    for (const status of ["running", "queued", "detected", "needs_human", "error", "dismissed"] as const) expect(mergeReadiness(ready({ review: { status, headSha: SHA } })).ok).toBe(false);
  });

  it("CI rouge ou annulée : refus ; CI en cours : refus ; CI illisible : refus par prudence ; jobs manuels ou ignorés : sans effet", () => {
    expect(mergeReadiness(ready({ checks: [{ name: "phpunit", status: "failed" }] })).reasons[0]).toContain("a échoué : phpunit");
    expect(mergeReadiness(ready({ checks: [{ name: "lint", status: "canceled" }] })).ok).toBe(false);
    expect(mergeReadiness(ready({ checks: [{ name: "build", status: "running" }, { name: "x", status: "success" }] })).reasons[0]).toContain("tourne encore");
    expect(mergeReadiness(ready({ checks: [], checksError: "délai dépassé" })).reasons[0]).toContain("Impossible de lire l'intégration continue (délai dépassé)");
    expect(mergeReadiness(ready({ checks: [{ name: "deploy", status: "manual" }, { name: "doc", status: "skipped" }, { name: "t", status: "success" }] })).ok).toBe(true);
  });

  it("l'outil ne fusionne que la MR de la branche de la tâche, vers la branche cible du projet", () => {
    const otherSource = mergeReadiness(ready({ mr: { state: "opened", draft: true, headSha: SHA, sourceBranch: "feature/autre", targetBranch: "develop" } }));
    expect(otherSource.ok).toBe(false);
    expect(otherSource.reasons[0]).toContain("ne part plus de la branche de la tâche");
    expect(mergeReadiness(ready({ taskBranch: null })).ok).toBe(false);

    const otherTarget = mergeReadiness(ready({ mr: { state: "opened", draft: true, headSha: SHA, sourceBranch: "feature/609-x", targetBranch: "main" } }));
    expect(otherTarget.ok).toBe(false);
    expect(otherTarget.reasons[0]).toContain("vise « main » mais le projet est réglé sur « develop »");
  });

  it("déjà fusionnée ou fermée : état à part, jamais de nouvelle fusion", () => {
    expect(mergeReadiness(ready({ mr: { state: "merged", draft: false, headSha: SHA, sourceBranch: "feature/609-x", targetBranch: "develop" } }))).toMatchObject({ state: "merged", ok: false });
    expect(mergeReadiness(ready({ mr: { state: "closed", draft: false, headSha: SHA, sourceBranch: "feature/609-x", targetBranch: "develop" } }))).toMatchObject({ state: "closed", ok: false });
  });

  it("toutes les raisons sont données ensemble, pour tout régler d'un coup", () => {
    const r = mergeReadiness(ready({ review: null, checks: [{ name: "t", status: "failed" }], projectTargetBranch: "main" }));
    expect(r.reasons.length).toBe(3);
  });
});
