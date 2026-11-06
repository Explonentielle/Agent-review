import { describe, expect, it } from "vitest";
import { decide, type DecisionRules } from "./decision.js";
import type { Finding, ReviewResult } from "./schema.js";

const rules: DecisionRules = { maxChangedLinesAuto: 800, sensitivePathPatterns: [/migrations?\//i, /(^|\/)auth/i] };

function result(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: "ok",
    verdict: "approve",
    coverage: "full",
    ci_failure_related: false,
    injection_suspected: false,
    findings: [],
    positives: [],
    questions_for_author: [],
    ...overrides,
  };
}

function finding(severity: Finding["severity"], confirmed = true): Finding {
  return { severity, confirmed, title: "t", location: "a.php:1", explanation: "e" };
}

const base = { changedLines: 50, changedPaths: ["app/Foo.php"] };

describe("decide", () => {
  it("auto_ok quand il n'y a que des suggestions", () => {
    const d = decide({ ...base, result: result({ findings: [finding("suggestion"), finding("suggestion")] }) }, rules);
    expect(d).toEqual({ outcome: "auto_ok", reasons: [] });
  });

  it("escalade un bloquant, même non confirmé", () => {
    const d = decide({ ...base, result: result({ findings: [finding("blocking", false)] }) }, rules);
    expect(d.outcome).toBe("needs_human");
    expect(d.reasons[0]).toContain("bloquant");
  });

  it("escalade un point important", () => {
    expect(decide({ ...base, result: result({ findings: [finding("important")] }) }, rules).outcome).toBe("needs_human");
  });

  it("escalade une suspicion d'injection même sans finding", () => {
    expect(decide({ ...base, result: result({ injection_suspected: true }) }, rules).outcome).toBe("needs_human");
  });

  it("escalade request_changes, CI liée, couverture partielle et questions ouvertes", () => {
    for (const r of [
      result({ verdict: "request_changes" }),
      result({ ci_failure_related: true }),
      result({ coverage: "partial" }),
      result({ questions_for_author: ["pourquoi ?"] }),
    ]) {
      expect(decide({ ...base, result: r }, rules).outcome).toBe("needs_human");
    }
  });

  it("escalade une MR trop volumineuse", () => {
    const d = decide({ changedLines: 801, changedPaths: ["a.php"], result: result() }, rules);
    expect(d.reasons).toEqual(["801 lignes modifiées (seuil auto : 800)"]);
  });

  it("escalade les chemins sensibles", () => {
    const d = decide({ changedLines: 10, changedPaths: ["database/migrations/2026_x.php", "app/Auth/Guard.php", "README.md"], result: result() }, rules);
    expect(d.outcome).toBe("needs_human");
    expect(d.reasons[0]).toContain("database/migrations/2026_x.php");
    expect(d.reasons[0]).toContain("app/Auth/Guard.php");
  });
});
