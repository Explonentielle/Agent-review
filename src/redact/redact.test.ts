import { describe, expect, it } from "vitest";
import { ibanValid, luhnValid, nirValid } from "./detectors.js";
import { RedactionSession, redact, reidentify, type RedactOptions } from "./index.js";

/** Jeu annoté : chaque `secrets` doit disparaître du texte caviardé, quel que soit le format. */
interface Positive {
  name: string;
  text: string;
  secrets: string[];
  options?: RedactOptions;
}

const contactOptions: RedactOptions = { knownValues: [{ value: "Jean Dupont" }] };

const positives: Positive[] = [
  {
    name: "nom connu, téléphone et email",
    text: "Bonjour, je suis Jean Dupont, joignable au 06 12 34 56 78 ou à jean.dupont@example.fr. Cordialement.",
    secrets: ["Jean Dupont", "06 12 34 56 78", "jean.dupont@example.fr"],
    options: contactOptions,
  },
  ...["+33 6 12 34 56 78", "+33 (0)6 12 34 56 78", "06.12.34.56.78", "06-12-34-56-78", "0033612345678", "+44 20 7946 0958", "0612345678"].map((tel) => ({
    name: `téléphone ${tel}`,
    text: `Mon numéro est le ${tel} merci.`,
    secrets: [tel],
  })),
  ...["FR14 2004 1010 0505 0001 3M02 606", "DE89370400440532013000", "GB82 WEST 1234 5698 7654 32"].map((iban) => ({
    name: `IBAN ${iban}`,
    text: `Merci de rembourser sur l'IBAN : ${iban} avant vendredi`,
    secrets: [iban],
  })),
  ...["4111 1111 1111 1111", "5500-0000-0000-0004", "4111111111111111"].map((card) => ({
    name: `carte ${card}`,
    text: `Paiement refusé avec la carte ${card} hier.`,
    secrets: [card],
  })),
  ...["2 69 05 49 588 157 80", "269054958815780"].map((nir) => ({
    name: `numéro de sécurité sociale ${nir}`,
    text: `Mon numéro de sécu : ${nir}.`,
    secrets: [nir],
  })),
  { name: "passeport", text: "Voici mon passeport n° 12AB34567 pour le dossier.", secrets: ["12AB34567"] },
  { name: "date de naissance (née le)", text: "La passagère est née le 14/03/1985 à Lyon.", secrets: ["14/03/1985"] },
  { name: "date de naissance en lettres", text: "Date de naissance : 3 mars 1985", secrets: ["3 mars 1985"] },
  { name: "date de naissance ISO", text: "DOB 1985-03-14 confirmé", secrets: ["1985-03-14"] },
  { name: "adresse postale", text: "J'habite au 12 rue des Lilas, 69003 Lyon.", secrets: ["rue des Lilas", "69003"] },
  { name: "URL avec jeton", text: "Le lien https://app.example.com/reset?token=abc123def456ghi ne marche plus.", secrets: ["abc123def456ghi"] },
  { name: "URL avec identifiants", text: "Connexion sur https://admin:Secret99@db.example.com/panel svp", secrets: ["Secret99"] },
  { name: "adresse IP publique", text: "Connexion suspecte depuis 82.64.12.200 ce matin.", secrets: ["82.64.12.200"] },
  { name: "adresse IPv6 complète", text: "Depuis 2001:0db8:85a3:0000:0000:8a2e:0370:7334 hier", secrets: ["2001:0db8:85a3:0000:0000:8a2e:0370:7334"] },
  { name: "email obfusqué", text: "écrivez à jean (at) example.fr svp", secrets: ["jean (at) example.fr"] },
  { name: "nom après une civilité", text: "Madame Dupont a rappelé, puis M. Martin Paul aussi.", secrets: ["Dupont", "Martin Paul"] },
  { name: "adresse sans numéro de rue", text: "elle habite rue de la Paix 75002 Paris", secrets: ["rue de la Paix", "75002"] },
  { name: "plaque d'immatriculation", text: "véhicule AB-123-CD au parking", secrets: ["AB-123-CD"] },
  { name: "carte avec points", text: "carte 4111.1111.1111.1111 refusée", secrets: ["4111.1111.1111.1111"] },
  {
    name: "numéro de dossier conservé, le reste caviardé",
    text: "Dossier DOS-2024-00123 de Marie Martin, tel 0612345678",
    secrets: ["Marie Martin", "0612345678"],
    options: { knownValues: [{ value: "Marie Martin" }], customPatterns: [{ type: "DOSSIER", pattern: /DOS-\d{4}-\d{5}/, keep: true }] },
  },
];

/** Textes sans donnée personnelle : ils doivent ressortir identiques (faux positifs). */
const negatives = [
  "Le prix est de 1 250,00 EUR pour 2 adultes.",
  "PHP 7.3.1 et Laravel 11, version 2.152 du 14/03/2025",
  "Voir le ticket #2563 sur sra-bo, commit a1b2c3d4e5f6a7b8",
  "Départ le 12/07/2026 à 10:30, retour 2026-07-19 18:45:10",
  "IP interne 10.0.0.12, 192.168.1.10 et 127.0.0.1",
  "Erreur SQL 1054 : Unknown column 'x' in 'field list'",
  "Remise de 15 % sur 3 chambres, total 4 580 EUR",
  "version v1.2.3.4 installée sur le serveur",
  "Le client a oublié son mot de passe et demande une réinitialisation.",
  "Réservation du 03-11-2026 confirmée",
  "Appel de Model::find puis Foo::bar dans le contrôleur",
  "branche feature/2563-recherche-naturelle-extraction-des-criteres mergée",
  "Monsieur le directeur est absent, merci Madame, bien reçu",
  "Livraison rue de Paris ou place du marché, sans autre précision",
  "référence AB-123 et modèle AB-1234-CD",
];

describe("corpus annoté", () => {
  it("rappel : aucune valeur personnelle ne subsiste dans le texte caviardé", () => {
    let total = 0;
    const leaks: string[] = [];
    for (const p of positives) {
      const out = redact(p.text, new RedactionSession(), p.options).text;
      for (const secret of p.secrets) {
        total++;
        if (out.includes(secret)) leaks.push(`${p.name} : « ${secret} » subsiste dans « ${out} »`);
      }
    }
    expect(leaks, `rappel ${total - leaks.length}/${total}`).toEqual([]);
    expect(total).toBe(37); // le corpus ne doit pas rétrécir sans qu'on s'en aperçoive
  });

  it("faux positifs : les textes sans donnée personnelle ne changent pas et ne sont pas signalés", () => {
    const altered: string[] = [];
    for (const text of negatives) {
      const r = redact(text, new RedactionSession());
      if (r.text !== text || r.suspicions.length > 0) altered.push(`${text} → ${r.text} (${r.suspicions.length} suspicion(s))`);
    }
    expect(altered, `faux positifs ${altered.length}/${negatives.length}`).toEqual([]);
  });

  it("le numéro de dossier configuré en « conserver » reste dans le texte", () => {
    const p = positives.at(-1)!;
    expect(redact(p.text, new RedactionSession(), p.options).text).toBe("Dossier DOS-2024-00123 de [NOM_1], tel [TEL_1]");
  });
});

describe("validations", () => {
  it("les numéros de test sont valides, les mêmes numéros altérés ne le sont pas", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(ibanValid("FR1420041010050500013M02606")).toBe(true);
    expect(ibanValid("FR1420041010050500013M02607")).toBe(false);
    expect(nirValid("269054958815780")).toBe(true);
    expect(nirValid("269054958815781")).toBe(false);
  });

  it("un IBAN, un numéro de carte ou de sécu invalide n'est pas pris pour une donnée reconnue", () => {
    const r = redact("Numéro 4111 1111 1111 1112 saisi", new RedactionSession());
    expect(r.replaced).toBe(0);
    expect(r.suspicions.map((s) => s.kind)).toEqual(["NOMBRE_NON_RECONNU"]);
  });
});

describe("repères et session", () => {
  it("un IBAN donne un seul repère (pas de double détection en téléphone ou en carte)", () => {
    expect(redact("IBAN FR14 2004 1010 0505 0001 3M02 606", new RedactionSession()).text).toBe("IBAN [IBAN_1]");
  });

  it("repères stables dans tout un fil, y compris pour deux écritures du même numéro", () => {
    const s = new RedactionSession();
    const a = redact("Écrivez à ana@example.fr ou appelez le 06 12 34 56 78.", s).text;
    const b = redact("Rappel : ANA@example.fr, tel +33 6 12 34 56 78, ou bob@example.fr", s).text;
    expect(a).toBe("Écrivez à [EMAIL_1] ou appelez le [TEL_1].");
    expect(b).toBe("Rappel : [EMAIL_1], tel [TEL_1], ou [EMAIL_2]");
  });

  it("aller-retour : réidentifier le texte caviardé redonne le texte d'origine", () => {
    const s = new RedactionSession();
    const text = "Contact : ana@example.fr, 06 12 34 56 78, IBAN FR14 2004 1010 0505 0001 3M02 606, née le 14/03/1985, 82.64.12.200";
    const r = redact(text, s);
    expect(r.text).not.toContain("ana@example.fr");
    expect(reidentify(r.text, s)).toBe(text);
  });

  it("réidentifie une réponse du modèle, sans tenir compte de la casse, et laisse les repères inconnus", () => {
    const s = new RedactionSession();
    redact("Bonjour Jean Dupont, 06 12 34 56 78", s, contactOptions);
    expect(reidentify("Bonjour [nom_1], nous vous rappelons au [TEL_1]. Voir [EMAIL_9].", s)).toBe("Bonjour Jean Dupont, nous vous rappelons au 06 12 34 56 78. Voir [EMAIL_9].");
  });

  it("la session s'exporte et se recharge : la numérotation continue sans collision", () => {
    const s = new RedactionSession();
    redact("ana@example.fr", s);
    const restored = RedactionSession.import(JSON.parse(JSON.stringify(s.export())));
    expect(reidentify("[EMAIL_1]", restored)).toBe("ana@example.fr");
    expect(redact("bob@example.fr", restored).text).toBe("[EMAIL_2]");
  });

  it("un texte déjà caviardé ne change plus", () => {
    const s = new RedactionSession();
    const once = redact("ana@example.fr, 06 12 34 56 78", s);
    const twice = redact(once.text, s);
    expect(twice.text).toBe(once.text);
    expect(twice.replaced).toBe(0);
  });

  it("les types conservés restent dans le texte, les types invalides sont refusés", () => {
    expect(redact("Depuis 82.64.12.200", new RedactionSession(), { keepTypes: ["IP"] }).text).toBe("Depuis 82.64.12.200");
    expect(() => redact("x", new RedactionSession(), { customPatterns: [{ type: "mauvais type", pattern: /x/ }] })).toThrow(/Type de repère invalide/);
  });

  it("un numéro à 10 chiffres est pris pour un téléphone, sauf si le motif de l'équipe le conserve", () => {
    expect(redact("réf 0123456789", new RedactionSession()).text).toBe("réf [TEL_1]");
    const kept = redact("réf 0123456789", new RedactionSession(), { customPatterns: [{ type: "REFERENCE", pattern: /\b\d{10}\b/, keep: true }] });
    expect(kept.text).toBe("réf 0123456789");
  });
});

describe("mode strict", () => {
  it("signale une valeur chiffrée après un mot-clé sensible, sans jamais la recopier", () => {
    const text = "Mon mot de passe est Abc12345, merci";
    const r = redact(text, new RedactionSession());
    expect(r.needsReview).toBe(true);
    expect(r.suspicions.map((s) => s.kind)).toEqual(["VALEUR_APRES_MOT_CLE"]);
    expect(text.slice(r.suspicions[0]!.start, r.suspicions[0]!.end)).toBe("Abc12345");
    expect(JSON.stringify(r.suspicions)).not.toContain("Abc12345");
  });

  it("signale une suite de chiffres non reconnue et un IBAN mal saisi", () => {
    expect(redact("dossier 123456789012", new RedactionSession()).suspicions.map((s) => s.kind)).toEqual(["NOMBRE_NON_RECONNU"]);
    expect(redact("IBAN FR14 2004 1010 0505 0001 3M02 607 voilà", new RedactionSession()).suspicions.map((s) => s.kind)).toContain("IBAN_MAL_FORME");
  });

  it("ne signale rien quand tout a été remplacé ou conservé volontairement", () => {
    expect(redact("IBAN FR14 2004 1010 0505 0001 3M02 606", new RedactionSession()).needsReview).toBe(false);
    const kept = redact("dossier 123456789012", new RedactionSession(), { customPatterns: [{ type: "DOSSIER", pattern: /\d{12}/, keep: true }] });
    expect(kept.needsReview).toBe(false);
  });

  it("le mode strict peut être désactivé : les suspicions restent listées mais ne bloquent plus", () => {
    const r = redact("dossier 123456789012", new RedactionSession(), { strict: false });
    expect(r.suspicions).toHaveLength(1);
    expect(r.needsReview).toBe(false);
  });
});
