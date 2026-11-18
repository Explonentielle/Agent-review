/**
 * Validation déterministe de ce que le Scribe peut écrire chez une forge. Elle s'applique au brouillon de l'agent comme à ce que la
 * personne a corrigé : le modèle propose, la personne valide, mais c'est ce code qui décide ce qui part.
 */

export const LIMITS = {
  title: 200,
  description: 20_000,
  label: 50,
  labels: 10,
  projectName: 100,
  projectDescription: 500,
  firstTickets: 8,
  idea: 4000,
} as const;

/** Erreur de saisie : le message est lisible tel quel par la personne. */
export class ScribeInputError extends Error {}

export interface CleanTicket {
  title: string;
  description: string;
  labels: string[];
}

export interface CleanProject {
  name: string;
  description: string;
  private: boolean;
  withReadme: boolean;
  namespaceId?: string;
  tickets: CleanTicket[];
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Nettoie un ticket : titre sur une ligne, description bornée, étiquettes sans virgule ni saut de ligne, uniques, en nombre borné.
 * @param input Titre, description et étiquettes à envoyer.
 * @returns Le ticket prêt à être créé.
 * @throws ScribeInputError Si le titre est vide ou trop long, ou la description trop longue.
 */
export function cleanTicket(input: { title: unknown; description?: unknown; labels?: unknown }): CleanTicket {
  const title = oneLine(String(input.title ?? ""));
  if (title.length < 3) throw new ScribeInputError("Le titre du ticket est trop court (3 caractères au moins).");
  if (title.length > LIMITS.title) throw new ScribeInputError(`Le titre du ticket est trop long (${LIMITS.title} caractères au plus).`);
  const description = String(input.description ?? "").replace(/\r\n/g, "\n").trim();
  if (description.length > LIMITS.description) throw new ScribeInputError(`La description est trop longue (${LIMITS.description} caractères au plus).`);
  const raw = Array.isArray(input.labels) ? input.labels : [];
  const labels = [...new Set(raw.map((l) => oneLine(String(l))).filter((l) => l.length > 0 && l.length <= LIMITS.label && !l.includes(",")))].slice(0, LIMITS.labels);
  return { title, description, labels };
}

/** Lettres, chiffres, espaces, points, tirets et soulignés ; commence et finit par une lettre ou un chiffre. */
const PROJECT_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u;

/**
 * Nettoie un projet à créer, avec ses premiers tickets.
 * @param input Nom, description, visibilité, groupe et tickets de départ.
 * @returns Le projet prêt à être créé.
 * @throws ScribeInputError Si le nom est invalide ou trop long, ou si un ticket de départ est invalide.
 */
export function cleanProject(input: { name: unknown; description?: unknown; private?: unknown; withReadme?: unknown; namespaceId?: unknown; tickets?: unknown }): CleanProject {
  const name = oneLine(String(input.name ?? ""));
  if (name.length < 2 || name.length > LIMITS.projectName) throw new ScribeInputError(`Le nom du projet doit faire entre 2 et ${LIMITS.projectName} caractères.`);
  if (!PROJECT_NAME.test(name)) throw new ScribeInputError("Le nom du projet n'accepte que des lettres, chiffres, espaces, points, tirets et soulignés.");
  const description = oneLine(String(input.description ?? ""));
  if (description.length > LIMITS.projectDescription) throw new ScribeInputError(`La description du projet est trop longue (${LIMITS.projectDescription} caractères au plus).`);
  const rawTickets = Array.isArray(input.tickets) ? input.tickets : [];
  if (rawTickets.length > LIMITS.firstTickets) throw new ScribeInputError(`Pas plus de ${LIMITS.firstTickets} tickets de départ à la fois.`);
  const namespaceId = input.namespaceId === undefined || input.namespaceId === null || input.namespaceId === "" ? undefined : String(input.namespaceId);
  if (namespaceId !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/.test(namespaceId)) throw new ScribeInputError("Groupe invalide.");
  return {
    name,
    description,
    // Par défaut privé : rendre public un projet est une décision à prendre explicitement
    private: input.private !== false,
    withReadme: input.withReadme !== false,
    ...(namespaceId !== undefined ? { namespaceId } : {}),
    tickets: rawTickets.map((t) => cleanTicket(t as { title: unknown; description?: unknown; labels?: unknown })),
  };
}

/**
 * Nettoie l'idée dictée à l'agent.
 * @param idea Texte saisi.
 * @returns Le texte sans espaces superflus.
 * @throws ScribeInputError Si l'idée est vide ou trop longue.
 */
export function cleanIdea(idea: unknown): string {
  const text = String(idea ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length < 3) throw new ScribeInputError("Dicte une idée d'au moins quelques mots.");
  if (text.length > LIMITS.idea) throw new ScribeInputError(`L'idée est trop longue (${LIMITS.idea} caractères au plus).`);
  return text;
}

/** Lien de fichier tel que GitLab le renvoie : `![nom](/uploads/<secret>/nom.png)` ou `[nom](/uploads/<secret>/nom.csv)`. */
const UPLOAD_MARKDOWN = /^!?\[[^\]\n<>]{0,200}\]\(\/uploads\/[0-9a-f]{8,64}\/[^\n<>`]{1,300}\)$/;

/**
 * Contrôle le Markdown renvoyé par la forge après l'envoi d'un fichier, avant de l'écrire dans la description d'un ticket : il doit être un
 * lien vers `/uploads/` du projet, rien d'autre (ni HTML, ni lien vers un autre site, ni plusieurs lignes).
 * @param markdown Texte renvoyé par la forge.
 * @returns Le texte, ou null s'il n'a pas la forme attendue.
 */
export function cleanUploadMarkdown(markdown: unknown): string | null {
  return typeof markdown === "string" && UPLOAD_MARKDOWN.test(markdown.trim()) ? markdown.trim() : null;
}
