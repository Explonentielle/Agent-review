import type { Role } from "../db/accounts.js";
import type { Mail } from "./mailer.js";

/** Un email sans destinataire : l'appelant l'ajoute. */
export type MailBody = Omit<Mail, "to">;

const APP = "Review agent";
const ROLE_NAMES: Record<Role, string> = { admin: "administrateur", member: "membre", viewer: "lecteur" };

/**
 * Échappe un texte avant de l'écrire dans le HTML d'un email (noms d'espace et de personne : saisis par d'autres).
 * @param text Texte à écrire.
 * @returns Le texte, sans caractère qui puisse ouvrir une balise ou un attribut.
 */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Met en page un email : un titre, des paragraphes (déjà échappés) et, si besoin, un bouton. Les styles sont des classes d'un bloc `<style>` de l'en-tête.
 * @param title Titre.
 * @param paragraphs Paragraphes HTML (déjà échappés).
 * @param button Bouton d'action (libellé et adresse), ou absent.
 * @returns Le HTML complet.
 */
function layout(title: string, paragraphs: string[], button?: { label: string; url: string }): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body { margin: 0; padding: 24px; background: #f6f7f9; font: 15px/1.5 system-ui, "Segoe UI", Arial, sans-serif; color: #1a1d23; }
.card { max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #d6dae1; border-radius: 12px; padding: 28px; }
h1 { margin: 0 0 14px; font-size: 20px; }
p { margin: 0 0 14px; }
.cta { margin: 22px 0; }
.btn { display: inline-block; padding: 10px 18px; background: #2f5fd0; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; }
.muted { color: #626b78; font-size: 13px; }
</style></head><body>
<div class="card">
<h1>${esc(title)}</h1>
${paragraphs.map((p) => `<p>${p}</p>`).join("\n")}
${button ? `<p class="cta"><a class="btn" href="${esc(button.url)}">${esc(button.label)}</a></p>
<p class="muted">Si le bouton ne marche pas, copie cette adresse dans ton navigateur :<br>${esc(button.url)}</p>` : ""}
<p class="muted">${APP}</p>
</div></body></html>`;
}

/**
 * Email de confirmation d'inscription : le lien permet de choisir son nom et son mot de passe.
 * @param link Lien d'inscription (valable une fois, peu de temps).
 * @param minutes Durée de validité du lien, en minutes.
 * @returns Sujet, texte et HTML.
 */
export function signupMail(link: string, minutes: number): MailBody {
  const lines = [`Pour créer ton compte ${APP}, ouvre ce lien et choisis ton mot de passe (valable ${minutes} minutes, une seule fois) :`, link, "Si tu n'as rien demandé, ignore ce message : aucun compte n'est créé tant que le lien n'est pas ouvert."];
  return {
    subject: `Crée ton compte ${APP}`,
    text: lines.join("\n\n"),
    html: layout("Crée ton compte", [`Pour créer ton compte, choisis ton mot de passe (lien valable ${minutes} minutes, une seule fois).`, "Si tu n'as rien demandé, ignore ce message : aucun compte n'est créé tant que le lien n'est pas ouvert."], { label: "Créer mon compte", url: link }),
  };
}

/**
 * Email envoyé quand on demande à s'inscrire avec une adresse qui a déjà un compte : il ne crée rien et indique où se connecter.
 * @param loginUrl Page de connexion.
 * @param resetUrl Page « mot de passe oublié ».
 * @returns Sujet, texte et HTML.
 */
export function alreadyRegisteredMail(loginUrl: string, resetUrl: string): MailBody {
  const lines = [`Quelqu'un (peut-être toi) a demandé à créer un compte ${APP} avec cette adresse, qui en a déjà un.`, `Connecte-toi : ${loginUrl}`, `Mot de passe oublié : ${resetUrl}`, "Si ce n'est pas toi, ignore ce message : rien n'a changé."];
  return {
    subject: `Tu as déjà un compte ${APP}`,
    text: lines.join("\n\n"),
    html: layout("Tu as déjà un compte", ["Quelqu'un (peut-être toi) a demandé à créer un compte avec cette adresse, qui en a déjà un.", `<a href="${esc(resetUrl)}">Mot de passe oublié ?</a>`, "Si ce n'est pas toi, ignore ce message : rien n'a changé."], { label: "Me connecter", url: loginUrl }),
  };
}

/**
 * Email « mot de passe oublié » : le lien permet d'en choisir un nouveau.
 * @param link Lien de réinitialisation (valable une fois, peu de temps).
 * @param minutes Durée de validité du lien, en minutes.
 * @returns Sujet, texte et HTML.
 */
export function resetMail(link: string, minutes: number): MailBody {
  const lines = [`Pour choisir un nouveau mot de passe ${APP}, ouvre ce lien (valable ${minutes} minutes, une seule fois) :`, link, "Si tu n'as rien demandé, ignore ce message : ton mot de passe reste le même."];
  return {
    subject: `Nouveau mot de passe ${APP}`,
    text: lines.join("\n\n"),
    html: layout("Nouveau mot de passe", [`Pour choisir un nouveau mot de passe, ouvre le lien (valable ${minutes} minutes, une seule fois).`, "Si tu n'as rien demandé, ignore ce message : ton mot de passe reste le même."], { label: "Choisir un mot de passe", url: link }),
  };
}

/**
 * Email d'invitation dans une organisation.
 * @param input Qui invite, dans quelle organisation, avec quel rôle, mot d'accompagnement éventuel, lien et validité en jours.
 * @returns Sujet, texte et HTML.
 */
export function invitationMail(input: { invitedBy: string; workspaceName: string; role: Role; note: string; link: string; days: number }): MailBody {
  const who = `${input.invitedBy} t'invite à rejoindre l'organisation « ${input.workspaceName} » sur ${APP}, comme ${ROLE_NAMES[input.role]}.`;
  const lines = [who, ...(input.note ? [`Son message : ${input.note}`] : []), `Accepter l'invitation (valable ${input.days} jours, une seule fois) : ${input.link}`, "Si tu ne connais pas cette personne, ignore ce message."];
  return {
    subject: `${input.invitedBy} t'invite sur ${APP}`.replace(/[\r\n]+/g, " ").slice(0, 150),
    text: lines.join("\n\n"),
    html: layout("Tu es invité(e)", [esc(who), ...(input.note ? [`Son message : <i>${esc(input.note)}</i>`] : []), `Lien valable ${input.days} jours, une seule fois.`, "Si tu ne connais pas cette personne, ignore ce message."], { label: "Accepter l'invitation", url: input.link }),
  };
}
