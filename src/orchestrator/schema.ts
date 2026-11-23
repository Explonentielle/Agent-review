import { z } from "zod";

/**
 * Ce que l'orchestrateur renvoie à chaque tour du chat de cadrage. C'est une proposition : la personne relit et corrige les tickets, puis le code
 * les valide (`scribe/clean.ts`) avant toute écriture chez la forge.
 */
export const PlanTurnSchema = z.object({
  /** Message pour la personne : questions de cadrage (cinq au plus), ou résumé du plan proposé. */
  reply: z.string(),
  /** Vrai seulement quand le besoin est assez clair pour proposer la liste de tickets. */
  ready: z.boolean(),
  /** Tickets du plan, dans l'ordre d'exécution. Vide tant que `ready` est faux. */
  tickets: z.array(
    z.object({
      title: z.string(),
      /** Description en Markdown : contexte, comportement attendu, critères d'acceptation (cases à cocher), hors périmètre. */
      description: z.string(),
      /** Étiquettes choisies uniquement parmi celles proposées dans la demande. */
      labels: z.array(z.string()),
    }),
  ),
});

export type PlanTurn = z.infer<typeof PlanTurnSchema>;

/** Le SDK Agent valide en JSON Schema draft-07. */
export const planTurnJsonSchema = z.toJSONSchema(PlanTurnSchema, { target: "draft-7" }) as Record<string, unknown>;
