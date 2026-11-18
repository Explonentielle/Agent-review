import type { Role } from "../db/accounts.js";
import type { InvitationLookup } from "../db/invitations.js";
import { MIN_PASSWORD_LENGTH } from "./password.js";
import type { AuthProviderKind } from "./oauth.js";

/* Pages publiques de connexion : serveur et pages sans style en ligne (classes d'un bloc <style>), formulaires envoyés par un petit script commun. */

export const PROVIDER_NAMES: Record<AuthProviderKind, string> = { gitlab: "GitLab", github: "GitHub" };
const ROLE_NAMES: Record<Role, string> = { admin: "administrateur", member: "membre", viewer: "lecteur" };

/**
 * Échappe un texte avant de l'écrire dans une page HTML (nom d'espace, mot d'accompagnement : saisis par d'autres personnes).
 * @param text Texte à écrire.
 * @returns Le texte, sans caractère qui puisse ouvrir une balise ou un attribut.
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Script commun des formulaires : envoie le formulaire en JSON avec l'en-tête exigé de toute écriture (protection contre les requêtes d'autres sites), puis
 * redirige ou affiche le message du serveur. Servi par `/auth/form.js`, jamais écrit dans les pages.
 */
export const FORM_SCRIPT = `"use strict";
document.addEventListener("submit", async (ev) => {
  const form = ev.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute("data-auth")) return;
  ev.preventDefault();
  const msg = form.querySelector(".msg");
  const button = form.querySelector("button[type=submit]");
  msg.textContent = "";
  msg.className = "msg";
  button.disabled = true;
  try {
    const res = await fetch(form.getAttribute("action"), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-review-agent": "1" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      msg.textContent = data.error || "La demande a échoué. Réessaie.";
      msg.className = "msg error";
    } else if (data.redirect) {
      location.assign(data.redirect);
      return;
    } else {
      msg.textContent = data.message || "C'est fait.";
      msg.className = "msg ok";
      form.reset();
    }
  } catch {
    msg.textContent = "Le serveur ne répond pas. Réessaie.";
    msg.className = "msg error";
  }
  button.disabled = false;
});
`;

/** Un champ de formulaire. */
interface Field {
  name: string;
  label: string;
  type: "text" | "email" | "password";
  autocomplete: string;
  /** Valeur imposée (adresse d'une invitation) : le champ est alors en lecture seule. */
  fixed?: string;
}

/**
 * Formulaire envoyé par le script commun.
 * @param action Adresse qui reçoit le JSON.
 * @param fields Champs.
 * @param submit Libellé du bouton.
 * @returns Le HTML du formulaire.
 */
function form(action: string, fields: Field[], submit: string): string {
  const inputs = fields.map((f) => {
    const extra = f.type === "password" ? ` minlength="${MIN_PASSWORD_LENGTH}"` : "";
    return `<label>${escapeHtml(f.label)}<input name="${f.name}" type="${f.type}" autocomplete="${f.autocomplete}" required${extra}${f.fixed !== undefined ? ` value="${escapeHtml(f.fixed)}" readonly` : ""}></label>`;
  });
  return `<form data-auth action="${escapeHtml(action)}" method="post">
  ${inputs.join("\n  ")}
  <div class="msg" role="status" aria-live="polite"></div>
  <button class="btn primary" type="submit">${escapeHtml(submit)}</button>
</form>`;
}

const EMAIL_FIELD: Field = { name: "email", label: "Adresse email", type: "email", autocomplete: "email" };
const PASSWORD_HINT = `<p class="hint">${MIN_PASSWORD_LENGTH} caractères au moins. Une phrase longue vaut mieux qu'un mot compliqué.</p>`;

/**
 * Page de connexion : formulaire email et mot de passe si l'installation envoie des emails, un bouton par forge configurée. Aucun texte libre : l'erreur est un code.
 * @param options Forges configurées, connexion par mot de passe active, inscription ouverte, code d'erreur (`refused`, `invite` ou autre) et notice (`reset`).
 * @returns La page HTML.
 */
export function loginPage(options: { providers: AuthProviderKind[]; password: boolean; signupOpen: boolean; error?: string; notice?: string }): string {
  const { providers, password } = options;
  const message = options.error === "refused" ? "Ce compte n'est pas autorisé sur cette installation."
    : options.error === "invite" ? "Cette invitation n'est pas valable pour ce compte (déjà utilisée, révoquée, expirée ou réservée à un autre compte). Demande un nouveau lien à l'administrateur."
      : options.error ? "La connexion a échoué. Réessaie." : "";
  const notice = options.notice === "reset" ? "Mot de passe changé : connecte-toi." : "";
  const buttons = providers.map((p) => `<a class="btn" href="/auth/${p}/login">Se connecter avec ${PROVIDER_NAMES[p]}</a>`).join("\n  ");
  return shell("Connexion", `<h1>Review agent</h1>
  <p>${password ? "Connecte-toi." : "Connecte-toi avec ton compte de forge."}</p>
  ${message ? `<div class="error" role="alert">${message}</div>` : ""}
  ${notice ? `<div class="ok" role="status">${notice}</div>` : ""}
  ${password ? `${form("/auth/login", [EMAIL_FIELD, { name: "password", label: "Mot de passe", type: "password", autocomplete: "current-password" }], "Se connecter")}
  <p class="links"><a href="/forgot">Mot de passe oublié ?</a>${options.signupOpen ? ` · <a href="/signup">Créer un compte</a>` : ""}</p>${providers.length ? `\n  <p class="sep">ou</p>` : ""}` : ""}
  ${buttons}`);
}

/**
 * Page d'inscription : on donne son adresse, un lien arrive par email pour choisir son mot de passe.
 * @param signupOpen Vrai si n'importe qui peut s'inscrire, faux si l'inscription se fait sur invitation.
 * @returns La page HTML.
 */
export function signupPage(signupOpen: boolean): string {
  return shell("Inscription", `<h1>Créer un compte</h1>
  <p>${signupOpen ? "Donne ton adresse email : un lien t'est envoyé pour choisir ton mot de passe." : "L'inscription se fait sur invitation d'un administrateur : ouvre le lien de ton invitation. Seul le propriétaire de l'installation peut s'inscrire sans invitation."}</p>
  ${form("/auth/signup", [EMAIL_FIELD], "Recevoir le lien")}
  <p class="links"><a href="/login">J'ai déjà un compte</a></p>`);
}

/**
 * Page « mot de passe oublié ».
 * @returns La page HTML.
 */
export function forgotPage(): string {
  return shell("Mot de passe oublié", `<h1>Mot de passe oublié</h1>
  <p>Donne l'adresse de ton compte : si elle existe, un lien t'est envoyé pour choisir un nouveau mot de passe.</p>
  ${form("/auth/forgot", [EMAIL_FIELD], "Recevoir le lien")}
  <p class="links"><a href="/login">Retour à la connexion</a></p>`);
}

/**
 * Page d'un lien d'inscription : nom et mot de passe, l'adresse étant celle qui a reçu le lien.
 * @param token Jeton lu dans le lien (caractères d'URL sûrs).
 * @param email Adresse confirmée par le lien, ou null si le lien n'est plus valable.
 * @returns La page HTML.
 */
export function signupCompletePage(token: string, email: string | null): string {
  if (!email) return invalidLinkPage("Inscription");
  return shell("Inscription", `<h1>Choisis ton mot de passe</h1>
  <p>Ton compte sera créé avec cette adresse, avec son espace personnel.</p>
  ${form(`/auth/signup/${encodeURIComponent(token)}`, [{ ...EMAIL_FIELD, fixed: email }, { name: "name", label: "Ton nom", type: "text", autocomplete: "name" }, { name: "password", label: "Mot de passe", type: "password", autocomplete: "new-password" }], "Créer mon compte")}
  ${PASSWORD_HINT}`);
}

/**
 * Page d'un lien de nouveau mot de passe.
 * @param token Jeton lu dans le lien (caractères d'URL sûrs).
 * @param valid Faux si le lien n'est plus valable.
 * @returns La page HTML.
 */
export function resetPage(token: string, valid: boolean): string {
  if (!valid) return invalidLinkPage("Mot de passe oublié");
  return shell("Nouveau mot de passe", `<h1>Nouveau mot de passe</h1>
  <p>Toutes tes sessions ouvertes seront fermées.</p>
  ${form(`/auth/reset/${encodeURIComponent(token)}`, [{ name: "password", label: "Nouveau mot de passe", type: "password", autocomplete: "new-password" }], "Enregistrer")}
  ${PASSWORD_HINT}`);
}

/**
 * Page d'un lien qui n'est plus valable (même page pour un lien inconnu, utilisé ou expiré : on ne dit pas pourquoi).
 * @param title Titre de l'onglet.
 * @returns La page HTML.
 */
function invalidLinkPage(title: string): string {
  return shell(title, `<h1>${escapeHtml(title)}</h1>
  <div class="error" role="alert">Ce lien n'est plus valable : il a peut-être déjà été utilisé, ou il a expiré. Refais la demande depuis la page de connexion.</div>
  <p class="links"><a href="/login">Retour à la connexion</a></p>`);
}

/** Ce que la page d'une invitation sait de la personne qui l'ouvre. */
export interface InviteViewer {
  /** Personne déjà connectée (nom et adresse), ou null. */
  signedIn: { name: string; email: string | null } | null;
  /** Vrai si un compte avec mot de passe existe déjà pour l'adresse de l'invitation. */
  accountExists: boolean;
}

/**
 * Page d'accueil d'une invitation : qui invite, dans quel espace, avec quel rôle. Une invitation envoyée par email se termine par un mot de passe (création du
 * compte, ou connexion si l'adresse en a déjà un) ; une invitation par lien, par un bouton par forge. Une personne déjà connectée accepte d'un clic.
 * Tout texte saisi par une autre personne est échappé.
 * @param invitation L'invitation retrouvée par son jeton, ou null si elle n'est pas valable (même page pour tous les cas : on ne dit pas pourquoi).
 * @param token Jeton lu dans le lien (caractères d'URL sûrs).
 * @param providers Forges de connexion configurées.
 * @param password Vrai si la connexion par email et mot de passe est active.
 * @param viewer Ce qu'on sait de la personne qui ouvre le lien.
 * @returns La page HTML.
 */
export function invitePage(invitation: InvitationLookup | null, token: string, providers: AuthProviderKind[], password: boolean, viewer: InviteViewer): string {
  if (!invitation) {
    return shell("Invitation", `<h1>Invitation</h1>
  <div class="error" role="alert">Cette invitation n'est plus valable : elle a peut-être déjà été utilisée, révoquée, ou elle a expiré. Demande un nouveau lien à la personne qui t'a invité.</div>`);
  }
  const base = `/invite/${encodeURIComponent(token)}`;
  const intro = `<h1>Tu es invité(e)</h1>
  <p>${escapeHtml(invitation.invitedBy)} t'invite à rejoindre l'espace <b>${escapeHtml(invitation.workspaceName)}</b> comme ${ROLE_NAMES[invitation.role]}.</p>
  ${invitation.note ? `<p class="note">${escapeHtml(invitation.note)}</p>` : ""}`;
  const { signedIn } = viewer;
  const accept = signedIn ? `<form data-auth action="${base}/accept" method="post"><div class="msg" role="status" aria-live="polite"></div><button class="btn primary" type="submit">Accepter avec ton compte (${escapeHtml(signedIn.name)})</button></form>` : "";

  if (invitation.email !== null) {
    if (!password) return shell("Invitation", `${intro}<div class="error" role="alert">Cette installation n'accepte pas la connexion par email : demande un autre lien à l'administrateur.</div>`);
    const mine = signedIn !== null && signedIn.email === invitation.email;
    const body = mine ? accept
      : signedIn ? `<div class="error" role="alert">Tu es connecté(e) avec un autre compte : cette invitation est pour ${escapeHtml(invitation.email)}. Déconnecte-toi, puis rouvre ce lien.</div>`
        : viewer.accountExists ? `<p>Tu as déjà un compte avec cette adresse : connecte-toi pour accepter.</p>
  ${form(`${base}/login`, [{ ...EMAIL_FIELD, fixed: invitation.email }, { name: "password", label: "Mot de passe", type: "password", autocomplete: "current-password" }], "Me connecter et accepter")}
  <p class="links"><a href="/forgot">Mot de passe oublié ?</a></p>`
          : `<p>Crée ton compte avec cette adresse : tu auras ton espace personnel, et tu rejoindras celui-ci.</p>
  ${form(`${base}/signup`, [{ ...EMAIL_FIELD, fixed: invitation.email }, { name: "name", label: "Ton nom", type: "text", autocomplete: "name" }, { name: "password", label: "Mot de passe", type: "password", autocomplete: "new-password" }], "Créer mon compte et accepter")}
  ${PASSWORD_HINT}`;
    return shell("Invitation", `${intro}${body}`);
  }

  const usable = providers.filter((p) => invitation.forgeLogin === null || invitation.forgeLogin.startsWith(`${p}:`));
  return shell("Invitation", `${intro}
  ${invitation.forgeLogin ? `<p class="note">Cette invitation est réservée au compte ${escapeHtml(invitation.forgeLogin)}.</p>` : ""}
  ${accept}
  ${usable.map((p) => `<a class="btn" href="${base}/login/${p}">Accepter avec ${PROVIDER_NAMES[p]}</a>`).join("\n  ")}
  ${usable.length === 0 && !signedIn ? `<div class="error" role="alert">Aucune connexion ne correspond à cette invitation sur cette installation.</div>` : ""}`);
}

/**
 * Enveloppe commune des pages publiques : mise en page et styles, sans style en ligne.
 * @param title Titre de l'onglet.
 * @param main Contenu de la carte (HTML déjà échappé).
 * @returns La page HTML.
 */
export function shell(title: string, main: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --surface: #fff; --text: #1a1d23; --muted: #626b78; --accent: #2f5fd0; --on-accent: #fff; --danger: #b3261e; --ok: #1b6e3c; --border: #d6dae1; }
  @media (prefers-color-scheme: dark) { :root { --bg: #14161a; --surface: #1d2025; --text: #e8eaee; --muted: #9aa3b0; --accent: #7aa2f7; --on-accent: #10131a; --danger: #f2b8b5; --ok: #8fd6a6; --border: #343a44; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { width: min(420px, calc(100vw - 32px)); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: var(--muted); }
  a { color: var(--accent); }
  label { display: block; margin: 0 0 12px; font-size: 13px; font-weight: 600; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: inherit; font-weight: 400; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  input[readonly] { color: var(--muted); }
  .error { color: var(--danger); margin-bottom: 14px; }
  .ok { color: var(--ok); margin-bottom: 14px; }
  .msg:empty { display: none; }
  .msg.error, .msg.ok { margin: 0 0 12px; }
  .hint, .links, .sep { font-size: 13px; margin: 12px 0 0; }
  .links, .sep { text-align: center; }
  .btn { display: block; box-sizing: border-box; width: 100%; margin-top: 10px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text); text-decoration: none; text-align: center; font: inherit; font-weight: 600; cursor: pointer; }
  .btn:hover, .btn:focus-visible { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .btn.primary:hover, .btn.primary:focus-visible { color: var(--on-accent); opacity: .9; }
  .btn:disabled { opacity: .6; cursor: progress; }
</style>
</head>
<body>
<main>
  ${main}
</main>
<script src="/auth/form.js" defer></script>
</body>
</html>`;
}
