/**
 * Règles des pièces jointes (captures d'écran, maquettes, données) envoyées à l'agent ou jointes à un ticket.
 * Tout est décidé ici, par du code : un fichier n'est accepté que si son extension est connue ET si son contenu réel
 * correspond (une « image » qui n'en est pas une est refusée). Aucun exécutable, aucun HTML ni SVG (ils peuvent porter du script).
 */

export type AttachmentKind = "image" | "pdf" | "text";

/**
 * Dossier, dans le dossier de travail de l'agent dev, où les pièces jointes sont posées le temps de son passage. Il est supprimé dès que
 * l'agent a fini, et un fichier qui y subsisterait fait refuser le commit : une capture ou une maquette n'entre jamais dans une MR.
 */
export const ATTACHMENTS_DIRNAME = ".ra-attachments";

/** Erreur lisible telle quelle par la personne (fichier refusé, plafond atteint). */
export class AttachmentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "AttachmentError";
  }
}

export const LIMITS = {
  /** Image ou PDF. */
  maxBinaryBytes: 8 * 1024 * 1024,
  /** Fichier texte ou de données (CSV, JSON...). */
  maxTextBytes: 1024 * 1024,
  /** Fichiers par tâche ou par ticket. */
  maxFiles: 8,
  /** Poids total par tâche ou par ticket. */
  maxTotalBytes: 20 * 1024 * 1024,
  /** Fichiers envoyés mais pas encore rattachés, par espace. */
  maxStaged: 40,
  /** Durée de garde d'un fichier non rattaché. */
  stagedTtlMs: 24 * 60 * 60 * 1000,
  maxNameChars: 80,
} as const;

/** Extensions acceptées. Volontairement courte : on élargit sur demande, jamais par défaut. */
const EXTENSIONS: Record<string, { kind: AttachmentKind; mime: string }> = {
  png: { kind: "image", mime: "image/png" },
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  txt: { kind: "text", mime: "text/plain" },
  md: { kind: "text", mime: "text/markdown" },
  csv: { kind: "text", mime: "text/csv" },
  tsv: { kind: "text", mime: "text/tab-separated-values" },
  json: { kind: "text", mime: "application/json" },
  log: { kind: "text", mime: "text/plain" },
  yml: { kind: "text", mime: "text/yaml" },
  yaml: { kind: "text", mime: "text/yaml" },
  xml: { kind: "text", mime: "application/xml" },
};

/** Extensions listées dans le message d'un refus. */
export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSIONS);

/** Noms réservés par Windows : un fichier ainsi nommé ne peut pas être écrit sur certaines machines. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

export interface CheckedAttachment {
  /** Nom assaini : une seule composante, caractères sûrs, extension en minuscules. */
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
}

/**
 * Assainit un nom de fichier envoyé par le navigateur : seule la dernière composante est gardée, les caractères qui ne sont ni des lettres,
 * ni des chiffres, ni `. _ - ( )` ni l'espace deviennent `_`, et l'extension est mise en minuscules.
 * @param raw Nom reçu.
 * @returns Le nom sûr (jamais vide), ou « fichier » si rien n'en subsiste.
 */
export function sanitizeName(raw: string): string {
  const last = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const dot = last.lastIndexOf(".");
  const stemRaw = dot > 0 ? last.slice(0, dot) : last;
  const ext = dot > 0 ? last.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  let stem = stemRaw
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .slice(0, LIMITS.maxNameChars - (ext ? ext.length + 1 : 0));
  stem = stem.replace(/[. ]+$/g, "");
  if (!stem) stem = "fichier";
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  return ext ? `${stem}.${ext}` : stem;
}

/** Extension en minuscules d'un nom déjà assaini (sans le point), ou « ». */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean => signature.every((b, i) => bytes[offset + i] === b);

/** Type réel d'une image d'après ses premiers octets, ou null. */
function sniffImage(bytes: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "gif";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return null;
}

/** Vrai si les octets sont du texte UTF-8 valide, sans octet nul (un binaire déguisé en .txt ne passe pas). */
function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Contrôle un fichier reçu : extension connue, poids dans la limite de son type, contenu conforme à l'extension.
 * @param rawName Nom envoyé par le navigateur.
 * @param bytes Contenu.
 * @returns Le nom assaini, le type et le poids.
 * @throws AttachmentError Si le fichier est refusé (message lisible).
 */
export function checkAttachment(rawName: string, bytes: Uint8Array): CheckedAttachment {
  const name = sanitizeName(rawName);
  const ext = extensionOf(name);
  const rule = EXTENSIONS[ext];
  if (!rule) {
    throw new AttachmentError(`« ${name} » : ce type de fichier n'est pas accepté. Types acceptés : ${ACCEPTED_EXTENSIONS.join(", ")}.`);
  }
  if (bytes.byteLength === 0) throw new AttachmentError(`« ${name} » est vide.`);
  const max = rule.kind === "text" ? LIMITS.maxTextBytes : LIMITS.maxBinaryBytes;
  if (bytes.byteLength > max) {
    throw new AttachmentError(`« ${name} » est trop gros (${formatSize(bytes.byteLength)} ; maximum ${formatSize(max)} pour ce type).`, 413);
  }

  if (rule.kind === "image") {
    const real = sniffImage(bytes);
    const expected = ext === "jpeg" ? "jpg" : ext;
    if (real !== expected) throw new AttachmentError(`« ${name} » n'est pas une vraie image ${ext.toUpperCase()} : son contenu ne correspond pas à son extension.`);
  } else if (rule.kind === "pdf") {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new AttachmentError(`« ${name} » n'est pas un vrai PDF : son contenu ne correspond pas à son extension.`);
  } else if (!isPlainText(bytes)) {
    throw new AttachmentError(`« ${name} » n'est pas un fichier texte lisible (UTF-8).`);
  }
  return { name, kind: rule.kind, mime: rule.mime, size: bytes.byteLength };
}

/** Type et type MIME d'un fichier déjà accepté, d'après son nom (utilisé à la relecture du stockage). */
export function describeName(name: string): { kind: AttachmentKind; mime: string } | null {
  return EXTENSIONS[extensionOf(name)] ?? null;
}

/**
 * Vérifie qu'un ensemble de fichiers reste dans les plafonds d'une tâche ou d'un ticket.
 * @param files Fichiers (nom et poids).
 * @throws AttachmentError Si trop de fichiers ou trop de poids.
 */
export function checkTotals(files: Array<{ size: number }>): void {
  if (files.length > LIMITS.maxFiles) throw new AttachmentError(`Trop de fichiers : ${LIMITS.maxFiles} au plus.`);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > LIMITS.maxTotalBytes) throw new AttachmentError(`Les fichiers pèsent ${formatSize(total)} : ${formatSize(LIMITS.maxTotalBytes)} au plus au total.`, 413);
}

/** « 1,2 Mo », « 340 Ko »... */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
}
