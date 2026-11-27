/* Affichage du code d'une MR (diff unifié) : une liste de fichiers repliables, lignes ajoutées en vert et supprimées en rouge, avec leurs numéros.
   Utilisé par la page d'une tâche et par la page des plans. Les données viennent de `GET /api/tasks/:id/diff` ; la fonction commune `esc` de index.html
   protège tout ce qui est affiché. Aucun style en ligne : les classes `cv-*` sont définies dans index.html. */
(() => {
  "use strict";

  const CHANGE = { added: ["Ajouté", "green"], deleted: ["Supprimé", "red"], renamed: ["Renommé", "orange"], modified: ["Modifié", ""] };
  /** Un fichier est ouvert d'emblée s'il est court, et seulement parmi les premiers : un gros diff s'ouvre à la demande. */
  const OPEN_MAX_LINES = 120;
  const OPEN_MAX_FILES = 10;

  /**
   * Lignes d'un diff unifié, avec leur type et leurs numéros (ancien et nouveau fichier).
   * @param {string} diff Diff d'un fichier (blocs « @@ »).
   * @returns {Array<{kind: string, old: number|null, neu: number|null, text: string}>} Les lignes, dans l'ordre.
   */
  function parse(diff) {
    const lines = diff.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const rows = [];
    let oldNo = 0, newNo = 0;
    for (const line of lines) {
      const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (head) { oldNo = Number(head[1]); newNo = Number(head[2]); rows.push({ kind: "hunk", old: null, neu: null, text: line }); continue; }
      const c = line[0];
      if (c === "+") rows.push({ kind: "add", old: null, neu: newNo++, text: line.slice(1) });
      else if (c === "-") rows.push({ kind: "del", old: oldNo++, neu: null, text: line.slice(1) });
      else if (c === "\\") rows.push({ kind: "meta", old: null, neu: null, text: line });
      else rows.push({ kind: "ctx", old: oldNo++, neu: newNo++, text: line.slice(1) });
    }
    return rows;
  }

  const SIGN = { add: "+", del: "-", ctx: "", meta: "" };

  /**
   * Une ligne du tableau d'un fichier.
   * @param {{kind: string, old: number|null, neu: number|null, text: string}} r Ligne analysée.
   * @returns {string} Le HTML de la ligne.
   */
  const rowHtml = (r) => r.kind === "hunk"
    ? `<tr class="cv-hunk"><td colspan="4">${esc(r.text)}</td></tr>`
    : `<tr class="cv-${r.kind}"><td class="cv-no">${r.old ?? ""}</td><td class="cv-no">${r.neu ?? ""}</td><td class="cv-sign">${SIGN[r.kind]}</td><td class="cv-code">${esc(r.text)}</td></tr>`;

  /**
   * Un fichier de la MR : en-tête (type de changement, chemin, lignes ajoutées et supprimées) et diff.
   * @param {object} f Fichier renvoyé par le serveur.
   * @param {boolean} open Vrai pour l'afficher déplié.
   * @returns {string} Le HTML du fichier.
   */
  function fileHtml(f, open) {
    const [label, color] = CHANGE[f.change] || CHANGE.modified;
    const name = f.oldPath ? `${esc(f.oldPath)} → ${esc(f.path)}` : esc(f.path);
    const body = !f.diff
      ? `<p class="note">${f.truncated ? "Contenu non affiché (limite de taille) : ouvre la MR sur la forge." : "Rien à afficher : fichier binaire, renommé sans changement, ou trop volumineux pour la forge."}</p>`
      : `<div class="cv-scroll"><table class="cv-table">${parse(f.diff).map(rowHtml).join("")}</table></div>${f.truncated ? `<p class="note">Diff coupé (limite de taille) : la suite est sur la forge.</p>` : ""}`;
    return `<details class="cv-file" ${open ? "open" : ""}><summary><span class="pill ${color}">${esc(label)}</span> <code>${name}</code><span class="cv-stat"><b class="cv-plus">+${f.added}</b> <b class="cv-minus">-${f.removed}</b></span></summary>${body}</details>`;
  }

  /**
   * Le code d'une MR : totaux, puis chaque fichier.
   * @param {object} data Réponse de `GET /api/tasks/:id/diff`.
   * @returns {string} Le HTML à insérer.
   */
  function html(data) {
    if (!data.files.length) return `<p class="note">Aucun fichier modifié dans cette MR.</p>`;
    const s = (n) => (n > 1 ? "s" : "");
    const head = `<p class="cv-head"><b>${data.totalFiles} fichier${s(data.totalFiles)}</b> · <b class="cv-plus">+${data.totalAdded}</b> <b class="cv-minus">-${data.totalRemoved}</b>${data.mrUrl ? ` · <a href="${esc(data.mrUrl)}" target="_blank" rel="noopener noreferrer">ouvrir la MR</a>` : ""}</p>`;
    const files = data.files.map((f, i) => fileHtml(f, i < OPEN_MAX_FILES && (f.diff.match(/\n/g) || []).length < OPEN_MAX_LINES)).join("");
    const omitted = data.omittedFiles ? `<p class="note">${data.omittedFiles} autre${s(data.omittedFiles)} fichier${s(data.omittedFiles)} non affiché${s(data.omittedFiles)} (limite) : voir la MR sur la forge.</p>` : "";
    return head + files + omitted;
  }

  /**
   * Lit le code de la MR d'une tâche chez la forge, par le serveur.
   * @param {number|string} taskId Identifiant de la tâche.
   * @returns {Promise<object>} La réponse du serveur.
   */
  const load = (taskId) => api(`/api/tasks/${taskId}/diff`);

  window.CodeView = { html, load };
})();
