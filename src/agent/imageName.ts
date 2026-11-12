/**
 * Nom d'image Docker accepté pour les agents : il commence par une lettre ou un chiffre (jamais « - », que docker lirait comme une option) et
 * ne contient que les caractères d'un nom, d'un registre, d'une étiquette ou d'une empreinte (`registre:5000/equipe/image:7.3`, `image@sha256:...`).
 */
export const IMAGE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,199}$/;

/**
 * Images que les agents ont le droit d'utiliser : l'image par défaut, puis celles de `AGENT_IMAGES`. Le `.env` reste seul maître de la liste,
 * pour qu'un réglage de projet ne puisse pas faire tourner n'importe quelle image présente sur la machine.
 * @param runtime Réglages d'exécution : image par défaut et images supplémentaires autorisées.
 * @returns La liste sans doublon, l'image par défaut en premier.
 */
export function allowedImages(runtime: { image: string; extraImages: string[] }): string[] {
  return [...new Set([runtime.image, ...runtime.extraImages])];
}

/**
 * Image à lancer pour un projet : celle qu'il demande si elle est autorisée, sinon l'image par défaut.
 * @param runtime Réglages d'exécution : image par défaut et images supplémentaires autorisées.
 * @param requested Image demandée par le projet (vide ou absente : image par défaut).
 * @returns Le nom de l'image à lancer.
 * @throws Error Si le projet demande une image qui ne figure pas dans `AGENT_IMAGE` ni dans `AGENT_IMAGES`.
 */
export function imageFor(runtime: { image: string; extraImages: string[] }, requested: string | null | undefined): string {
  const wanted = requested?.trim();
  if (!wanted) return runtime.image;
  if (!allowedImages(runtime).includes(wanted)) {
    throw new Error(`Image d'agent « ${wanted} » non autorisée : elle doit figurer dans AGENT_IMAGE ou AGENT_IMAGES du .env.`);
  }
  return wanted;
}
