/** "Amélioration de la review IA (3)" → "amelioration-de-la-review-ia-3" (convention de nommage de branche). */
export function slugify(text: string, maxLength = 100): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

export interface TemplateVars {
  iid: number;
  title: string;
  slug?: string;
  summary?: string;
}

/** Remplace {iid} {slug} {title} {summary} ; une variable inconnue reste telle quelle (visible, donc corrigeable). */
export function renderTemplate(template: string, vars: TemplateVars): string {
  const values: Record<string, string> = {
    iid: String(vars.iid),
    title: vars.title,
    slug: vars.slug ?? slugify(vars.title),
    summary: vars.summary ?? vars.title,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/**
 * Sujet de commit proposé par l'agent : première ligne utile uniquement, sans trailer
 * (« Co-Authored-By: ... », « Signed-off-by: ... ») ni numéro de ticket (ajouté par le template).
 */
export function cleanCommitSubject(raw: string, fallback: string): string {
  const first = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[\w-]+-by:/i.test(l));
  const subject = (first ?? "").replace(/^#\d+\s*[-:]\s*/, "").slice(0, 120).trim();
  return subject || fallback;
}

/** Une MR créée par l'agent est TOUJOURS en Draft, quel que soit le template configuré. */
export function ensureDraftTitle(title: string): string {
  return /^\s*(draft:|\[draft\]|\(draft\))/i.test(title) ? title.trim() : `Draft: ${title.trim()}`;
}
