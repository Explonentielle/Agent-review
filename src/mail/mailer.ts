/** Un email à envoyer : le texte brut sert de repli aux clients qui n'affichent pas le HTML. */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Envoi d'emails. Les erreurs d'envoi sont des `MailError`. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** L'email n'est pas parti. Le message ne contient jamais la clé d'API. */
export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Envoi par Resend (https://resend.com) : un appel HTTPS par email, sans bibliothèque.
 * @param options Clé d'API, expéditeur (`Nom <adresse@domaine-verifie>`), appels réseau (remplaçable dans les tests) et délai maximal d'un envoi.
 * @returns Le service d'envoi.
 */
export function createResendMailer(options: { apiKey: string; from: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Mailer {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    /**
     * Envoie un email.
     * @param mail Destinataire, sujet, texte et HTML.
     * @returns Rien.
     * @throws MailError Si Resend refuse l'envoi, répond mal ou ne répond pas à temps.
     */
    async send(mail: Mail): Promise<void> {
      let res: Response;
      try {
        res = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", "User-Agent": "review-agent" },
          body: JSON.stringify({ from: options.from, to: [mail.to], subject: mail.subject.replace(/[\r\n]+/g, " "), text: mail.text, html: mail.html }),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch {
        throw new MailError("Resend est injoignable ou n'a pas répondu à temps");
      }
      if (!res.ok) {
        const detail = await res.json().then((body) => (typeof (body as { message?: unknown })?.message === "string" ? (body as { message: string }).message.slice(0, 200) : ""), () => "");
        throw new MailError(`Resend a refusé l'envoi (HTTP ${res.status})${detail ? ` : ${detail}` : ""}`);
      }
    },
  };
}
