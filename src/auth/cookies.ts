import { timingSafeEqual } from "node:crypto";

/** Cookie de session (HttpOnly : illisible par le JavaScript de la page). */
export const SESSION_COOKIE = "ra_session";

/**
 * Lit les cookies d'une requête.
 * @param header En-tête `Cookie` brut, ou undefined.
 * @returns Les cookies par nom.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

/**
 * Construit un en-tête `Set-Cookie` sûr : HttpOnly, SameSite=Lax, limité au site, `Secure` quand l'adresse publique est en https.
 * @param name Nom du cookie.
 * @param value Valeur (caractères d'URL sûrs : les jetons sont en base64url).
 * @param maxAgeSeconds Durée de vie en secondes (0 pour l'effacer).
 * @param secure Vrai pour ajouter l'attribut Secure.
 * @returns La valeur de l'en-tête.
 */
export function setCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/**
 * Compare deux textes en temps constant.
 * @param a Premier texte.
 * @param b Second texte.
 * @returns true s'ils sont identiques.
 */
export function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
