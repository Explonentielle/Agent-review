/** Erreur de saisie sur un plan : le message est lisible tel quel par la personne (400). */
export class PlanInputError extends Error {}

/** Plan ou ticket absent de l'espace (404). */
export class PlanNotFoundError extends Error {}

/** Plan ouvert par une autre personne de l'espace : seule elle peut le faire avancer, car il s'exécute avec ses connexions et ses quotas (403). */
export class PlanForbiddenError extends Error {}

/** Action impossible dans l'état actuel du plan (409). */
export class PlanConflictError extends Error {}
