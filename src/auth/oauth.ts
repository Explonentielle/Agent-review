import { createHash, randomBytes } from "node:crypto";

export type AuthProviderKind = "gitlab" | "github";

/** Identité lue chez la forge après connexion : l'identifiant numérique ne change jamais, le login peut changer. */
export interface OAuthProfile {
  id: string;
  login: string;
  name: string;
  email: string | null;
}

/** Échec de la connexion OAuth. Le message est destiné à l'utilisateur et ne contient jamais de jeton ni de secret. */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** Une forge vue comme fournisseur d'identité : adresse d'autorisation, échange du code, lecture du profil. */
export interface OAuthProvider {
  kind: AuthProviderKind;
  /**
   * Adresse de la forge où l'utilisateur donne son accord.
   * @param params URL de retour, état anti-falsification et empreinte PKCE.
   * @returns L'adresse vers laquelle rediriger le navigateur.
   */
  authorizeUrl(params: { redirectUri: string; state: string; codeChallenge: string }): string;
  /**
   * Échange le code reçu au retour contre un jeton d'accès.
   * @param params Code, URL de retour et vérificateur PKCE.
   * @returns Le jeton d'accès, à n'utiliser que pour lire le profil.
   * @throws OAuthError Si la forge refuse l'échange.
   */
  exchangeCode(params: { code: string; redirectUri: string; codeVerifier: string }): Promise<string>;
  /**
   * Lit l'identité de la personne connectée.
   * @param accessToken Jeton d'accès obtenu par `exchangeCode`.
   * @returns Son profil.
   * @throws OAuthError Si la forge ne répond pas ou renvoie un profil inutilisable.
   */
  fetchProfile(accessToken: string): Promise<OAuthProfile>;
}

type FetchLike = typeof fetch;

export interface ProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Remplaçable dans les tests. */
  fetchImpl?: FetchLike;
}

const TIMEOUT_MS = 10_000;

/**
 * Génère le couple PKCE : un vérificateur secret gardé côté serveur et son empreinte envoyée à la forge.
 * @returns Le vérificateur et l'empreinte (SHA-256, base64url).
 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * Appelle une forge et lit sa réponse JSON.
 * @param fetchImpl Fonction d'appel réseau.
 * @param url Adresse appelée.
 * @param init Options de la requête.
 * @returns Le statut et le corps JSON (objet vide si illisible).
 * @throws OAuthError Si la forge n'est pas joignable dans le délai.
 */
async function callJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body: body && typeof body === "object" ? body : {} };
  } catch {
    throw new OAuthError("La forge ne répond pas");
  }
}

/**
 * Extrait le jeton d'accès d'une réponse d'échange de code.
 * @param body Corps JSON de la réponse.
 * @param ok Vrai si le statut HTTP est un succès.
 * @returns Le jeton d'accès.
 * @throws OAuthError Si la réponse n'en contient pas (GitHub répond parfois 200 avec une erreur).
 */
function accessTokenOf(body: Record<string, unknown>, ok: boolean): string {
  if (!ok || typeof body.access_token !== "string" || body.access_token === "") throw new OAuthError("La forge a refusé l'échange du code de connexion");
  return body.access_token;
}

/**
 * Fournisseur GitLab (instance configurée dans GITLAB_URL), avec PKCE.
 * @param baseUrl Adresse de l'instance GitLab, sans barre finale.
 * @param options Identifiants de l'application OAuth.
 * @returns Le fournisseur.
 */
export function createGitlabProvider(baseUrl: string, options: ProviderOptions): OAuthProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    kind: "gitlab",
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const query = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "read_user",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `${baseUrl}/oauth/authorize?${query}`;
    },
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const form = new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      const res = await callJson(fetchImpl, `${baseUrl}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form });
      return accessTokenOf(res.body, res.ok);
    },
    async fetchProfile(accessToken) {
      const res = await callJson(fetchImpl, `${baseUrl}/api/v4/user`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
      return profileOf(res.ok, res.body, "username");
    },
  };
}

/**
 * Fournisseur GitHub (github.com), avec PKCE.
 * @param options Identifiants de l'application OAuth.
 * @returns Le fournisseur.
 */
export function createGithubProvider(options: ProviderOptions): OAuthProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    kind: "github",
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const query = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        scope: "read:user",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      return `https://github.com/login/oauth/authorize?${query}`;
    },
    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const res = await callJson(fetchImpl, "https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: options.clientId, client_secret: options.clientSecret, code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
      });
      return accessTokenOf(res.body, res.ok);
    },
    async fetchProfile(accessToken) {
      const res = await callJson(fetchImpl, "https://api.github.com/user", {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "review-agent" },
      });
      return profileOf(res.ok, res.body, "login");
    },
  };
}

/**
 * Traduit la réponse « utilisateur courant » d'une forge en profil.
 * @param ok Vrai si le statut HTTP est un succès.
 * @param body Corps JSON de la réponse.
 * @param loginField Nom du champ qui porte le login chez cette forge.
 * @returns Le profil.
 * @throws OAuthError Si l'identifiant ou le login manque.
 */
function profileOf(ok: boolean, body: Record<string, unknown>, loginField: "username" | "login"): OAuthProfile {
  const id = body.id;
  const login = body[loginField];
  if (!ok || (typeof id !== "number" && typeof id !== "string") || typeof login !== "string" || login === "") throw new OAuthError("La forge n'a pas renvoyé de profil utilisable");
  return {
    id: String(id),
    login,
    name: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : login,
    email: typeof body.email === "string" && body.email !== "" ? body.email : null,
  };
}
