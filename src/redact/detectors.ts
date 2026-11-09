/**
 * Détecteurs de données personnelles. Chacun renvoie des zones du texte ; les formats à clé de
 * contrôle (IBAN, carte, numéro de sécurité sociale) sont validés pour limiter les faux positifs.
 * Les zones qui se chevauchent sont départagées par priorité dans `redact.ts`.
 */

export interface Span {
  start: number;
  end: number;
}

export interface Detector {
  type: string;
  /** Plus petit = prioritaire quand deux zones se chevauchent. */
  priority: number;
  find(text: string): Span[];
}

/** Priorités : les formats les plus précis passent avant les plus génériques (un IBAN avant un téléphone). */
export const PRIORITY = { CUSTOM: 0, KNOWN: 1, URL_SECRET: 2, EMAIL: 3, IBAN: 4, NIR: 5, CARTE: 6, PIECE_ID: 7, NAISSANCE: 8, ADRESSE: 9, CIVILITE: 10, PLAQUE: 11, IP: 12, TEL: 13 } as const;

// --- Contrôles de validité ----------------------------------------------------

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN : clé de contrôle modulo 97 (ISO 13616) sur la forme compacte. */
export function ibanValid(compact: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  let rem = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + Number(c)) % 97;
  }
  return rem === 1;
}

/** Numéro de sécurité sociale français : 15 caractères dont une clé de 2 chiffres (Corse : 2A, 2B). */
export function nirValid(compact: string): boolean {
  if (!/^[12]\d{2}(0[1-9]|1[0-2]|[2-9]\d)(\d{2}|2[AB])\d{3}\d{3}\d{2}$/i.test(compact)) return false;
  const base = BigInt(compact.slice(0, 13).toUpperCase().replace("2A", "19").replace("2B", "18"));
  const key = 97n - (base % 97n);
  return key === BigInt(compact.slice(13));
}

// --- Aides ----------------------------------------------------------------------

function* matches(text: string, re: RegExp): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    yield m;
    if (m[0] === "") re.lastIndex++;
  }
}

const span = (m: RegExpExecArray, offset = 0, length = m[0].length): Span => ({ start: m.index + offset, end: m.index + offset + length });

/** Zone du premier groupe capturé (nécessite le drapeau `d`). */
function groupSpan(m: RegExpExecArray, group = 1): Span | null {
  const idx = (m as RegExpExecArray & { indices?: Array<[number, number] | undefined> }).indices?.[group];
  return idx ? { start: idx[0], end: idx[1] } : null;
}

// --- Détecteurs -----------------------------------------------------------------

const EMAIL: Detector = {
  type: "EMAIL",
  priority: PRIORITY.EMAIL,
  // Accepte aussi les écritures obfusquées : jean (at) example.fr, jean[at]example.fr
  find: (text) => [...matches(text, /[A-Za-z0-9._%+\-]+(?:@|\s*[([{]at[)\]}]\s*)[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/gi)].map((m) => span(m)),
};

const IBAN: Detector = {
  type: "IBAN",
  priority: PRIORITY.IBAN,
  find(text) {
    const out: Span[] = [];
    for (const m of matches(text, /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[  ]?[A-Za-z0-9]){11,30}/gi)) {
      // Le candidat peut avaler des mots qui suivent : on garde le plus long préfixe qui est un IBAN valide
      const positions: number[] = [];
      for (let i = 0; i < m[0].length; i++) if (m[0][i] !== " " && m[0][i] !== " ") positions.push(i);
      for (let k = Math.min(positions.length, 34); k >= 15; k--) {
        const compact = positions.slice(0, k).map((i) => m[0][i]).join("").toUpperCase();
        if (ibanValid(compact)) {
          out.push(span(m, 0, positions[k - 1]! + 1));
          break;
        }
      }
    }
    return out;
  },
};

const NIR: Detector = {
  type: "NIR",
  priority: PRIORITY.NIR,
  find(text) {
    const out: Span[] = [];
    const re = /(?<!\d)[12][  ]?\d{2}[  ]?(?:0[1-9]|1[0-2]|[2-9]\d)[  ]?(?:\d{2}|2[AB])[  ]?\d{3}[  ]?\d{3}[  ]?\d{2}(?!\d)/gi;
    for (const m of matches(text, re)) if (nirValid(m[0].replace(/[  ]/g, ""))) out.push(span(m));
    return out;
  },
};

const CARTE: Detector = {
  type: "CARTE",
  priority: PRIORITY.CARTE,
  find(text) {
    const out: Span[] = [];
    for (const m of matches(text, /(?<!\d)(?:\d[ \-.]?){12,18}\d(?!\d)/g)) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhnValid(digits)) out.push(span(m));
    }
    return out;
  },
};

const PIECE_ID: Detector = {
  type: "PIECE_ID",
  priority: PRIORITY.PIECE_ID,
  find(text) {
    const re = /(?:passeport|passport|carte\s+(?:nationale\s+)?d['’]identit[ée]|\bCNI\b|identity\s+card|titre\s+de\s+s[ée]jour)[^\n]{0,25}?\b((?=[A-Z0-9]*\d)[A-Z0-9]{6,12})\b/gid;
    return [...matches(text, re)].map((m) => groupSpan(m)).filter((s): s is Span => s !== null);
  },
};

const MONTHS = "janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|january|february|march|april|may|june|july|august|september|october|november|december";
const DATE = `(?:\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?:er)?\\s+(?:${MONTHS})\\s+\\d{4}|(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4})`;

/** Date de naissance : seulement près d'un mot-clé (une date seule n'est pas une donnée personnelle). */
const NAISSANCE: Detector = {
  type: "NAISSANCE",
  priority: PRIORITY.NAISSANCE,
  find(text) {
    const re = new RegExp(`(?:n[ée]e?\\s+le|n[ée]\\(e\\)\\s+le|date\\s+de\\s+naissance|naissance|DOB|date\\s+of\\s+birth|born(?:\\s+on)?)\\s*[:\\-]?\\s*(${DATE})`, "gid");
    return [...matches(text, re)].map((m) => groupSpan(m)).filter((s): s is Span => s !== null);
  },
};

const STREET = "(?:[Rr]ue|RUE|[Aa]venue|AVENUE|[Aa]v\\.|[Bb]oulevard|BOULEVARD|[Bb]d|[Cc]hemin|[Ii]mpasse|[Aa]ll[ée]e|[Pp]lace|[Rr]oute|[Qq]uai|[Cc]ours|[Ss]quare|[Pp]assage|[Rr][ée]sidence)";

/** Adresse postale : numéro + type de voie + nom, suivis éventuellement du code postal et de la ville. */
const ADRESSE: Detector = {
  type: "ADRESSE",
  priority: PRIORITY.ADRESSE,
  find(text) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])\\d{1,4}\\s*(?:bis|ter)?\\s*,?\\s+${STREET}\\s+[\\p{L}0-9'’.\\- ]{2,50}?(?=[,;\\n]|$|\\s+\\d{5}(?!\\d)|\\.(?:\\s|$))` +
        `(?:,?\\s*\\d{5}\\s+\\p{Lu}[\\p{L}'’\\-]*(?:[ \\-]\\p{Lu}[\\p{L}'’\\-]*){0,3})?`,
      "gu",
    );
    // Sans numéro de rue, le code postal et la ville sont exigés pour limiter les faux positifs
    const noNumber = new RegExp(
      `(?<![\\p{L}])${STREET}\\s+[\\p{L}'’\\- ]{2,50}?,?\\s*\\d{5}\\s+\\p{Lu}[\\p{L}'’\\-]*(?:[ \\-]\\p{Lu}[\\p{L}'’\\-]*){0,3}`,
      "gu",
    );
    return [...matches(text, re), ...matches(text, noNumber)].map((m) => span(m));
  },
};

/** Nom précédé d'une civilité (Madame Dupont, M. Martin Paul) : seul le nom est caviardé. */
const CIVILITE: Detector = {
  type: "NOM",
  priority: PRIORITY.CIVILITE,
  find(text) {
    const re = /(?<![\p{L}])(?:M\.|Mme|Mlle|Mr|Madame|Monsieur|Mademoiselle|Docteur|Dr\.?)\s+(\p{Lu}[\p{L}'’\-]+(?:[ ]\p{Lu}[\p{L}'’\-]+){0,2})/gud;
    return [...matches(text, re)].map((m) => groupSpan(m)).filter((s): s is Span => s !== null);
  },
};

/** Plaque d'immatriculation française (format SIV : AB-123-CD), qui identifie un véhicule donc une personne. */
const PLAQUE: Detector = {
  type: "PLAQUE",
  priority: PRIORITY.PLAQUE,
  find: (text) => [...matches(text, /(?<![A-Za-z0-9-])[A-Z]{2}-\d{3}-[A-Z]{2}(?![A-Za-z0-9-])/g)].map((m) => span(m)),
};

/** Adresses IP publiques : les plages privées et locales décrivent l'infrastructure, pas une personne. */
function isPublicIp(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number) as [number, number];
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
  return true;
}

const IP: Detector = {
  type: "IP",
  priority: PRIORITY.IP,
  find(text) {
    const out: Span[] = [];
    const re = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)(?!\.\d)/g;
    for (const m of matches(text, re)) {
      const before = text.slice(Math.max(0, m.index - 10), m.index);
      if (/(?:version|ver\.?|v)\s*$/i.test(before)) continue; // numéro de version, pas une adresse
      if (isPublicIp(m[0])) out.push(span(m));
    }
    // IPv6 en notation complète (8 groupes) ; les formes abrégées ne sont pas détectées
    for (const m of matches(text, /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g)) out.push(span(m));
    return out;
  },
};

/** Téléphone : international (+ ou 00) de 8 à 15 chiffres, ou national à 10 chiffres commençant par 0. */
const TEL: Detector = {
  type: "TEL",
  priority: PRIORITY.TEL,
  find(text) {
    const out: Span[] = [];
    for (const m of matches(text, /(?<![\w+.\-/])(?:\+|00)?\d(?:[ .\-()]?\d){7,16}(?![\w])/g)) {
      const value = m[0];
      const digits = value.replace(/\(0\)/g, "").replace(/\D/g, "");
      if (/^\d{2}[-.]\d{2}[-.]\d{4}/.test(value)) continue; // date
      const international = value.startsWith("+") || value.startsWith("00");
      const significant = value.startsWith("00") ? digits.slice(2) : digits;
      if (international ? significant.length >= 8 && significant.length <= 15 : digits.length === 10 && digits.startsWith("0")) out.push(span(m));
    }
    return out;
  },
};

/** URL contenant un secret : identifiants dans l'adresse, ou paramètre de type jeton, clé, mot de passe. */
const URL_SECRET: Detector = {
  type: "URL_SECRET",
  priority: PRIORITY.URL_SECRET,
  find(text) {
    const out: Span[] = [];
    for (const m of matches(text, /https?:\/\/[^\s<>"'`]+/g)) {
      const url = m[0].replace(/[.,;:!?)\]]+$/, "");
      const hasUserinfo = /^https?:\/\/[^/\s@]+:[^/\s@]+@/.test(url);
      const hasSecretParam = /[?&;](?:access_?)?(?:token|api[_-]?key|key|secret|password|passwd|pwd|auth|signature|sig|session(?:_?id)?|code)=/i.test(url);
      if (hasUserinfo || hasSecretParam) out.push(span(m, 0, url.length));
    }
    return out;
  },
};

export const BUILT_IN_DETECTORS: Detector[] = [URL_SECRET, EMAIL, IBAN, NIR, CARTE, PIECE_ID, NAISSANCE, ADRESSE, CIVILITE, PLAQUE, IP, TEL];
