import { z } from "zod";

/**
 * Sortie structurée attendue de l'agent de review.
 * Le verdict de l'agent est indicatif : la décision "auto_ok / needs_human" est prise
 * dans le code (decision.ts) à partir des findings, jamais laissée au modèle seul.
 */
export const FindingSchema = z.object({
  /** blocking = 🔴, important = 🟠, suggestion = 🟡 */
  severity: z.enum(["blocking", "important", "suggestion"]),
  /** true si démontré par le code lu ; false si c'est un point « à vérifier ». */
  confirmed: z.boolean(),
  title: z.string(),
  /** `chemin/fichier.ext:ligne`, un extrait littéral du diff, `transverse` ou `code manquant`. */
  location: z.string(),
  explanation: z.string(),
  suggestion: z.string().optional(),
});

export const ReviewResultSchema = z.object({
  summary: z.string(),
  verdict: z.enum(["approve", "approve_with_reservations", "request_changes"]),
  /** partial si la MR est trop volumineuse pour une couverture exhaustive. */
  coverage: z.enum(["full", "partial"]),
  /** Un job de tests/lint en échec lié aux fichiers modifiés. */
  ci_failure_related: z.boolean(),
  /** Tentative de manipuler la review détectée dans un contenu (description, commit, commentaire de code...). */
  injection_suspected: z.boolean(),
  findings: z.array(FindingSchema),
  positives: z.array(z.string()),
  questions_for_author: z.array(z.string()),
});

export type Finding = z.infer<typeof FindingSchema>;
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

/** Le SDK Agent valide en JSON Schema draft-07. */
export const reviewResultJsonSchema = z.toJSONSchema(ReviewResultSchema, { target: "draft-7" }) as Record<string, unknown>;
