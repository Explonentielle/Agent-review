import type { Finding, ReviewResult } from "./schema.js";

/** Marqueur propre à cet outil, pour reconnaître ses propres commentaires parmi ceux d'autres bots. */
export const REVIEW_MARKER = "<!-- review-agent -->";

const SEVERITY_LABEL: Record<Finding["severity"], string> = {
  blocking: "🔴 **Bloquant**",
  important: "🟠 **Important**",
  suggestion: "🟡 **Suggestion**",
};

const VERDICT_LABEL: Record<ReviewResult["verdict"], string> = {
  approve: "✅ **Approve**",
  approve_with_reservations: "⚠️ **Approve avec réserves**",
  request_changes: "❌ **Request changes**",
};

const SEVERITY_ORDER: Finding["severity"][] = ["blocking", "important", "suggestion"];

/** Commentaire Markdown posté sur la MR (résumé, questions, points relevés, points positifs, verdict). */
export function formatReviewComment(result: ReviewResult, meta: { model: string; sha: string }): string {
  const lines: string[] = [REVIEW_MARKER, `> 🤖 Review assistée par IA (\`${meta.model}\`), commit \`${meta.sha.slice(0, 8)}\``, ""];

  lines.push("### Résumé", result.summary, "");

  if (result.questions_for_author.length > 0) {
    lines.push("### Questions", ...result.questions_for_author.map((q) => `- ${q}`), "");
  }

  lines.push("### Points relevés");
  const findings = [...result.findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  if (findings.length === 0) {
    lines.push("Aucun point négatif pertinent.");
  }
  findings.forEach((f, i) => {
    const uncertain = f.confirmed ? "" : " _(à vérifier)_";
    lines.push(`${i + 1}. ${SEVERITY_LABEL[f.severity]}${uncertain} : ${f.title}`, `   - Localisation : ${f.location}`, `   - ${f.explanation}`);
    if (f.suggestion) lines.push(`   - Correction : ${f.suggestion}`);
  });
  lines.push("");

  if (result.positives.length > 0) {
    lines.push("### Points positifs", ...result.positives.map((p) => `- 🟢 ${p}`), "");
  }

  lines.push("### Verdict", VERDICT_LABEL[result.verdict]);
  return lines.join("\n");
}
