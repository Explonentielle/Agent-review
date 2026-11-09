/**
 * Session de caviardage : associe chaque valeur personnelle à un repère stable (`[EMAIL_1]`) pour
 * toute la durée d'un ticket, et garde la correspondance inverse. Cette table contient des données
 * personnelles : elle reste dans le plan de contrôle, chiffrée au repos, avec une durée de vie
 * limitée (vision-plateforme, section 3.5). Elle n'est jamais envoyée au modèle.
 */

/** Forme canonique d'une valeur, pour que deux écritures de la même donnée aient le même repère. */
export function normalizeValue(type: string, value: string): string {
  switch (type) {
    case "TEL": {
      const v = value.replace(/\(0\)/g, "");
      const international = /^\s*(\+|00)/.test(v);
      let digits = v.replace(/\D/g, "");
      if (/^\s*00/.test(v)) digits = digits.slice(2);
      if (international && digits.startsWith("33") && digits.length === 11) return "0" + digits.slice(2);
      return international ? "+" + digits : digits;
    }
    case "IBAN":
      return value.replace(/\s/g, "").toUpperCase();
    case "CARTE":
    case "NIR":
      return value.replace(/\D/g, "");
    default:
      return value.toLowerCase().replace(/\s+/g, " ").trim();
  }
}

export interface SessionEntry {
  placeholder: string;
  key: string;
  /** Première écriture rencontrée de la valeur, restituée à la réidentification. */
  original: string;
}

export interface SessionData {
  entries: SessionEntry[];
}

export class RedactionSession {
  private readonly byKey = new Map<string, string>();
  private readonly originals = new Map<string, string>();
  private readonly counters = new Map<string, number>();

  /** Repère de la valeur : le même pour toutes ses écritures, créé à la première rencontre. */
  placeholderFor(type: string, value: string): string {
    const key = `${type}|${normalizeValue(type, value)}`;
    const known = this.byKey.get(key);
    if (known) return known;

    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const placeholder = `[${type}_${n}]`;
    this.byKey.set(key, placeholder);
    this.originals.set(placeholder, value);
    return placeholder;
  }

  /** Valeur d'origine d'un repère, ou undefined s'il est inconnu de cette session. */
  original(placeholder: string): string | undefined {
    return this.originals.get(placeholder);
  }

  get size(): number {
    return this.originals.size;
  }

  /** Contient des données personnelles : à chiffrer avant tout stockage. */
  export(): SessionData {
    return { entries: [...this.byKey].map(([key, placeholder]) => ({ key, placeholder, original: this.originals.get(placeholder) ?? "" })) };
  }

  static import(data: SessionData): RedactionSession {
    const session = new RedactionSession();
    for (const e of data.entries) {
      session.byKey.set(e.key, e.placeholder);
      session.originals.set(e.placeholder, e.original);
      const m = /^\[(.+)_(\d+)\]$/.exec(e.placeholder);
      if (m) session.counters.set(m[1]!, Math.max(session.counters.get(m[1]!) ?? 0, Number(m[2])));
    }
    return session;
  }
}
