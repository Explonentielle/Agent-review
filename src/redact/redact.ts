import { BUILT_IN_DETECTORS, PRIORITY, type Span } from "./detectors.js";
import { RedactionSession } from "./session.js";

/** Valeur connue à caviarder (ex. nom du demandeur lu dans les champs structurés du helpdesk). */
export interface KnownValue {
  value: string;
  /** Type du repère. Par défaut : NOM. */
  type?: string;
}

/** Motif propre à l'équipe (ex. numéro de dossier de voyage). */
export interface CustomPattern {
  /** Type du repère : majuscules, chiffres et tirets bas (ex. DOSSIER). */
  type: string;
  pattern: RegExp;
  /** true = conserver la valeur dans le texte (utile au diagnostic), en l'empêchant d'être caviardée par un autre détecteur. */
  keep?: boolean;
}

export interface RedactOptions {
  /** Signaler comme « à relire » tout texte contenant un motif sensible non remplaçable. Défaut : true. */
  strict?: boolean;
  knownValues?: KnownValue[];
  customPatterns?: CustomPattern[];
  /** Types détectés mais conservés dans le texte (ex. ["IP"]). */
  keepTypes?: string[];
}

export type SuspicionKind = "NOMBRE_NON_RECONNU" | "VALEUR_APRES_MOT_CLE" | "IBAN_MAL_FORME";

/** Zone suspecte du texte d'origine. Ne contient jamais la valeur : elle s'affiche à partir du texte source, dans le plan de contrôle. */
export interface Suspicion {
  kind: SuspicionKind;
  start: number;
  end: number;
}

export interface RedactionResult {
  /** Texte caviardé : le seul qui peut être envoyé au modèle, sauf si `needsReview`. */
  text: string;
  replaced: number;
  counts: Record<string, number>;
  suspicions: Suspicion[];
  /** Mode strict et au moins une suspicion : rien ne doit être envoyé au modèle avant relecture humaine. */
  needsReview: boolean;
}

interface Candidate extends Span {
  type: string;
  priority: number;
  keep: boolean;
}

const TYPE_NAME = /^[A-Z][A-Z0-9_]*$/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remplace les données personnelles par des repères stables. Les zones qui se chevauchent sont
 * départagées par priorité (motifs de l'équipe, valeurs connues, puis formats précis avant les
 * formats génériques). Voir `docs/vision-plateforme.md`, section 3.5.
 */
export function redact(text: string, session: RedactionSession, options: RedactOptions = {}): RedactionResult {
  const keepTypes = new Set(options.keepTypes ?? []);
  const found: Candidate[] = [];

  for (const d of BUILT_IN_DETECTORS) {
    for (const s of d.find(text)) found.push({ ...s, type: d.type, priority: d.priority, keep: keepTypes.has(d.type) });
  }

  for (const k of options.knownValues ?? []) {
    const value = k.value.trim();
    if (value.length < 2) continue;
    const type = k.type ?? "NOM";
    if (!TYPE_NAME.test(type)) throw new Error(`Type de repère invalide : « ${type} » (majuscules, chiffres et tirets bas)`);
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(value).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) found.push({ start: m.index, end: m.index + m[0].length, type, priority: PRIORITY.KNOWN, keep: keepTypes.has(type) });
  }

  for (const c of options.customPatterns ?? []) {
    if (!TYPE_NAME.test(c.type)) throw new Error(`Type de repère invalide : « ${c.type} » (majuscules, chiffres et tirets bas)`);
    const re = new RegExp(c.pattern.source, c.pattern.flags.includes("g") ? c.pattern.flags : c.pattern.flags + "g");
    for (const m of text.matchAll(re)) {
      if (m[0] === "") continue;
      found.push({ start: m.index, end: m.index + m[0].length, type: c.type, priority: PRIORITY.CUSTOM, keep: Boolean(c.keep) || keepTypes.has(c.type) });
    }
  }

  // Zones retenues : par priorité, puis la plus longue ; une zone qui en chevauche une déjà retenue est écartée
  found.sort((a, b) => a.priority - b.priority || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const accepted: Candidate[] = [];
  for (const c of found) if (!accepted.some((a) => c.start < a.end && a.start < c.end)) accepted.push(c);
  accepted.sort((a, b) => a.start - b.start);

  let out = "";
  let pos = 0;
  let replaced = 0;
  const counts: Record<string, number> = {};
  for (const a of accepted) {
    out += text.slice(pos, a.start);
    const value = text.slice(a.start, a.end);
    if (a.keep) {
      out += value;
    } else {
      out += session.placeholderFor(a.type, value);
      replaced++;
      counts[a.type] = (counts[a.type] ?? 0) + 1;
    }
    pos = a.end;
  }
  out += text.slice(pos);

  const suspicions = findSuspicions(text, accepted);
  return { text: out, replaced, counts, suspicions, needsReview: (options.strict ?? true) && suspicions.length > 0 };
}

/** Remet les valeurs d'origine à la place des repères (sans distinguer majuscules et minuscules). Les repères inconnus restent tels quels. */
export function reidentify(text: string, session: RedactionSession): string {
  return text.replace(/\[([A-Za-z][A-Za-z0-9_]*)_(\d+)\]/g, (whole, type: string, n: string) => session.original(`[${type.toUpperCase()}_${n}]`) ?? whole);
}

// --- Mode strict ------------------------------------------------------------------

const SENSITIVE_KEYWORDS =
  "mot\\s+de\\s+passe|password|passwd|\\bmdp\\b|code\\s+secret|code\\s+pin|\\bpin\\b|cvv|cvc|cryptogramme|\\biban\\b|\\brib\\b|carte\\s+(?:bancaire|bleue)|num[ée]ro\\s+de\\s+carte|s[ée]curit[ée]\\s+sociale|passeport|passport|pi[èe]ce\\s+d['’]identit[ée]|date\\s+de\\s+naissance";

/**
 * Cherche, dans ce qui n'a pas été reconnu, des motifs qui ressemblent à des données sensibles :
 * suite de chiffres, valeur chiffrée après un mot-clé sensible, IBAN mal saisi. Le détecteur de noms
 * libres n'existe pas : un nom que le helpdesk n'a pas fourni n'est pas repéré.
 */
function findSuspicions(text: string, covered: Span[]): Suspicion[] {
  const masked = [...text];
  for (const c of covered) for (let i = c.start; i < c.end; i++) masked[i] = " ";
  // Les adresses IP privées ou locales (192.168.1.10) décrivent l'infrastructure : pas de suspicion
  const hay = masked.join("").replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, (ip) => " ".repeat(ip.length));
  const out: Suspicion[] = [];

  for (const m of hay.matchAll(/(?<![\p{L}\p{N}])\d(?:[ .]?\d){8,}(?!\d)/gu)) {
    out.push({ kind: "NOMBRE_NON_RECONNU", start: m.index, end: m.index + m[0].length });
  }

  const keywordValue = new RegExp(`(?:${SENSITIVE_KEYWORDS})[^\\n]{0,40}?[\\s:=]([^\\s,;]*\\d[^\\s,;]*)`, "giu");
  for (const m of hay.matchAll(keywordValue)) {
    const token = m[1] ?? "";
    if (token.length < 4) continue;
    const end = m.index + m[0].length;
    out.push({ kind: "VALEUR_APRES_MOT_CLE", start: end - token.length, end });
  }

  for (const m of hay.matchAll(/(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,}/g)) {
    out.push({ kind: "IBAN_MAL_FORME", start: m.index, end: m.index + m[0].length });
  }

  return out.sort((a, b) => a.start - b.start);
}
