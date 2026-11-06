import type { ReviewResult } from "./schema.js";

export interface DecisionInput {
  result: ReviewResult;
  changedLines: number;
  changedPaths: string[];
}

export interface DecisionRules {
  maxChangedLinesAuto: number;
  sensitivePathPatterns: RegExp[];
}

export interface Decision {
  outcome: "auto_ok" | "needs_human";
  /** Vide si auto_ok ; sinon la liste de ce qui demande ton analyse (affichée dans le dashboard). */
  reasons: string[];
}

/**
 * Règle déterministe : une review ne peut être traitée sans toi que si elle ne contient
 * que des suggestions mineures ET qu'aucun garde-fou ne s'est déclenché.
 * Volontairement conservatrice au départ : à assouplir seulement au vu du taux d'accord mesuré.
 */
export function decide({ result, changedLines, changedPaths }: DecisionInput, rules: DecisionRules): Decision {
  const reasons: string[] = [];

  const blocking = result.findings.filter((f) => f.severity === "blocking");
  const important = result.findings.filter((f) => f.severity === "important");

  if (blocking.length > 0) reasons.push(`${blocking.length} point(s) bloquant(s)`);
  if (important.length > 0) reasons.push(`${important.length} point(s) important(s)`);
  if (result.verdict === "request_changes") reasons.push("verdict de l'agent : request changes");
  if (result.injection_suspected) reasons.push("tentative de manipulation de la review détectée");
  if (result.ci_failure_related) reasons.push("CI en échec sur des fichiers modifiés");
  if (result.coverage === "partial") reasons.push("couverture partielle (MR volumineuse)");
  if (result.questions_for_author.length > 0) reasons.push(`${result.questions_for_author.length} question(s) ouverte(s) pour l'auteur`);

  if (changedLines > rules.maxChangedLinesAuto) {
    reasons.push(`${changedLines} lignes modifiées (seuil auto : ${rules.maxChangedLinesAuto})`);
  }

  const sensitive = changedPaths.filter((p) => rules.sensitivePathPatterns.some((re) => re.test(p)));
  if (sensitive.length > 0) {
    reasons.push(`fichiers sensibles touchés : ${sensitive.slice(0, 5).join(", ")}${sensitive.length > 5 ? "…" : ""}`);
  }

  return { outcome: reasons.length === 0 ? "auto_ok" : "needs_human", reasons };
}
