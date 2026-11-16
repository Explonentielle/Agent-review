import { z } from "zod";

/**
 * Brouillons que l'agent Scribe renvoie. Ce sont des propositions : la personne les relit et les corrige, puis le code les valide
 * (`clean.ts`) avant toute écriture chez la forge. Les limites de taille ne sont pas dans ces schémas (la CLI les passe au modèle) mais
 * dans `clean.ts`, où elles sont appliquées quoi que le modèle ou la personne ait écrit.
 */
export const TicketDraftSchema = z.object({
  /** Titre court, sans point final. */
  title: z.string(),
  /** Description en Markdown : contexte, comportement attendu, critères d'acceptation (cases à cocher), hors périmètre. */
  description: z.string(),
  /** Étiquettes choisies uniquement parmi celles proposées dans la demande. */
  labels: z.array(z.string()),
  /** Points à trancher avant de commencer (trois au plus). */
  questions: z.array(z.string()),
});

export const ProjectDraftSchema = z.object({
  /** Nom court en minuscules avec des tirets. */
  name: z.string(),
  /** Une phrase : à quoi sert le projet. */
  description: z.string(),
  /** Trois à cinq tickets pour démarrer. */
  first_tickets: z.array(z.object({ title: z.string(), description: z.string() })),
  /** Points à trancher, doublons possibles avec des projets existants. */
  questions: z.array(z.string()),
});

export type TicketDraft = z.infer<typeof TicketDraftSchema>;
export type ProjectDraft = z.infer<typeof ProjectDraftSchema>;

/** Le SDK Agent valide en JSON Schema draft-07. */
export const ticketDraftJsonSchema = z.toJSONSchema(TicketDraftSchema, { target: "draft-7" }) as Record<string, unknown>;
export const projectDraftJsonSchema = z.toJSONSchema(ProjectDraftSchema, { target: "draft-7" }) as Record<string, unknown>;
