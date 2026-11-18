/* Le Scribe, dans la forge : il rédige un ticket ou un projet avec l'agent, la personne relit et corrige, puis l'outil le crée chez GitHub ou GitLab. */
(() => {
  "use strict";

  /** Droits du jeton, par forge (vérifiés dans la documentation des API). Le serveur redit le droit manquant en cas de refus. */
  const RIGHTS = {
    github: {
      base: ["Contents : lecture et écriture", "Pull requests : lecture et écriture", "Issues : lecture et écriture", "Checks et Commit statuses : lecture"],
      scribe: [
        "Créer des tickets : rien de plus que « Issues : lecture et écriture ».",
        "Créer des dépôts : « Administration » ou « Repository creation » en lecture et écriture.",
        "Le propriétaire du jeton (« Resource owner ») doit être ton compte, ou l'organisation où tu veux créer les dépôts.",
        "Un jeton classique marche aussi : le scope « repo » couvre tout.",
      ],
    },
    gitlab: {
      base: ["Scopes du jeton : api, read_repository, write_repository", "Rôle Developer au moins dans les projets où l'agent code"],
      scribe: [
        "Créer des tickets : le scope « api » et le rôle Reporter (ou plus) dans le projet.",
        "Créer des projets : le scope « api » et, dans le groupe visé, un rôle qui autorise la création de projets (Developer, Maintainer ou Owner selon les réglages du groupe). Sans groupe, le projet va dans ton espace personnel.",
      ],
    },
  };

  const forgeName = (kind) => (kind === "github" ? "GitHub" : "GitLab");
  const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

  /** Bloc repliable « Quels droits donner au jeton ? », pour le fourneau comme pour le Scribe. */
  function rightsHtml(kind, open = false) {
    const r = RIGHTS[kind];
    if (!r) return "";
    return `<details class="fg-rights" ${open ? "open" : ""}><summary>Quels droits donner au jeton ${esc(forgeName(kind))} ?</summary>
      <h5>Pour que les agents travaillent (le minimum)</h5>${list(r.base)}
      <h5>En plus, pour que le Scribe crée des tickets et des projets</h5>${list(r.scribe)}
      <p class="fg-note">Sans les droits du Scribe, le reste de l'outil fonctionne : le Scribe te dira alors précisément quel droit manque.</p></details>`;
  }

  /**
   * Rendu du Markdown d'un ticket tel que la forge l'affichera : titres, listes, cases à cocher, gras, code. Tout est échappé AVANT la
   * mise en forme, et ni lien ni HTML ne sont rendus : ce que le Scribe écrit ne peut pas injecter de balise dans la page.
   */
  function preview(text) {
    const out = [];
    let list = null;
    let para = [];
    const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    const flushP = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const closeL = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (const raw of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
      if (h) { flushP(); closeL(); const level = Math.min(6, h[1].length + 3); out.push(`<h${level}>${inline(h[2])}</h${level}>`); }
      else if (li) {
        flushP();
        const tag = /^\s*\d/.test(line) ? "ol" : "ul";
        if (list !== tag) { closeL(); out.push(`<${tag}>`); list = tag; }
        const box = li[1] === undefined ? "" : `<input type="checkbox" disabled ${li[1] === " " ? "" : "checked"}> `;
        out.push(`<li>${box}${inline(li[2])}</li>`);
      } else if (!line.trim()) { flushP(); closeL(); }
      else { closeL(); para.push(line); }
    }
    flushP(); closeL();
    return out.join("");
  }

  const fresh = () => ({ mode: "preview", phase: "idea", idea: "", draft: null, labels: [], allowed: [], err: "", result: null, ns: null, nsErr: "", name: "", pdesc: "", nsId: "", priv: true, readme: true, ft: [], title: "", desc: "" });

  /**
   * @param ctx Ce que la fenêtre emprunte à `popups.js` : le jeu, le rendu, l'audio, la fermeture, l'ouverture d'une autre fenêtre.
   * @returns La définition de la fenêtre et ses gestionnaires de clics et de saisie.
   */
  function create(ctx) {
    const game = () => ctx.game();
    const sc = { source: null, key: null, ticket: fresh(), project: fresh() };
    const tab = () => (ctx.sel() === "project" ? "project" : "ticket");
    const st = () => sc[tab()];
    const forges = () => game().data.forges;
    const source = () => (forges().includes(sc.source) ? sc.source : forges()[0] ?? null);
    const weapons = () => game().data.armory.weapons.filter((w) => w.source === source());
    const weapon = () => weapons().find((w) => w.key === sc.key) ?? weapons()[0] ?? null;
    const busy = (phase) => phase === "drafting" || phase === "creating";
    /** Zone de pièces jointes du ticket en cours (créée à la demande ; la fenêtre se redessine à chaque changement). */
    const attOf = (s) => (s.att ??= createAttachments(() => { if (ctx.isOpen()) ctx.rerender(); }));

    async function loadNamespaces() {
      const s = sc.project;
      if (s.ns || s.nsErr) return;
      try {
        s.ns = await api(`/api/forge/namespaces?source=${source()}`);
        s.nsId = s.nsId || (s.ns[0]?.id ?? "");
      } catch (err) { s.nsErr = err.message; }
      if (ctx.isOpen()) ctx.rerender();
    }

    async function draft() {
      const s = st(), w = weapon();
      if (!s.idea.trim()) { s.err = "Dicte d'abord ton idée, même en quelques mots."; return ctx.rerender(); }
      if (tab() === "ticket" && !w) { s.err = "Choisis un projet : le ticket doit être rangé quelque part."; return ctx.rerender(); }
      s.phase = "drafting"; s.err = "";
      ctx.rerender();
      try {
        const out = await api("/api/scribe/draft", tab() === "ticket"
          ? { kind: "ticket", source: source(), projectId: w.projectId, idea: s.idea }
          : { kind: "project", source: source(), idea: s.idea });
        if (tab() === "ticket") {
          s.title = out.draft.title; s.desc = out.draft.description; s.allowed = out.allowedLabels; s.labels = [...out.draft.labels];
        } else {
          s.name = out.draft.name; s.pdesc = out.draft.description;
          s.ft = out.draft.firstTickets.map((t) => ({ on: true, title: t.title, description: t.description }));
        }
        s.draft = out.draft;
        s.phase = "review";
        s.mode = "preview";
        if (tab() === "project") loadNamespaces();
        ctx.sfx.open();
      } catch (err) { s.phase = "idea"; s.err = err.message; ctx.sfx.error(); }
      if (ctx.isOpen()) ctx.rerender();
    }

    async function create() {
      const s = st(), w = weapon();
      s.phase = "creating"; s.err = "";
      ctx.rerender();
      try {
        if (tab() === "ticket") {
          const out = await api("/api/scribe/tickets", { source: source(), projectId: w.projectId, title: s.title, description: s.desc, labels: s.labels, attachments: attOf(s).ids() });
          s.result = out;
          attOf(s).reset(); // les fichiers ont été rattachés au ticket
          ctx.invalidateTickets();
        } else {
          s.result = await api("/api/scribe/projects", {
            source: source(), name: s.name, description: s.pdesc, namespaceId: s.nsId || undefined, private: s.priv, withReadme: s.readme,
            tickets: s.ft.filter((t) => t.on && t.title.trim()).map((t) => ({ title: t.title, description: t.description })),
          });
        }
        s.phase = "done";
        ctx.sfx.fanfare();
        game().banner(tab() === "ticket" ? `Ticket #${s.result.iid} créé : le Scribe l'a posé sur la forge.` : `Projet « ${s.result.project.name} » créé.`);
        game().refresh();
      } catch (err) { s.phase = "review"; s.err = err.message; ctx.sfx.error(); }
      if (ctx.isOpen()) ctx.rerender();
    }

    const errorHtml = (s) => (s.err ? `<div class="fg-err" role="alert">${esc(s.err)}</div>` : "");
    const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

    function ideaHtml(s) {
      const picks = forges();
      const forgeSel = picks.length > 1 ? `<label class="fg-field-in">Forge<select data-sc="source">${picks.map((k) => `<option value="${k}" ${k === source() ? "selected" : ""}>${forgeName(k)}</option>`).join("")}</select></label>` : "";
      const w = weapon();
      const projectSel = tab() === "ticket"
        ? (weapons().length
          ? `<label class="fg-field-in">Projet<select data-sc="key">${weapons().map((x) => `<option value="${esc(x.key)}" ${w && x.key === w.key ? "selected" : ""}>${esc(x.path)}</option>`).join("")}</select></label>`
          : `<p class="fg-note">Aucun projet de ${esc(forgeName(source()))} sur le râtelier. <button type="button" class="fg-btn ghost" data-fg-open="rack">Ouvrir le râtelier</button> ou crée un projet avec l'onglet « Nouveau projet ».</p>`)
        : "";
      const hint = tab() === "ticket"
        ? "Dis simplement ce que tu voudrais, comme à un collègue. Par exemple : « J'aimerais pouvoir télécharger les rapports du mois dans Excel ». Le Scribe en fait une demande claire (un « ticket »), et tu la relis avant qu'elle parte."
        : "Décris ton projet avec tes mots. Par exemple : « Une petite appli pour suivre les rapports de mes clients ». Le Scribe propose un nom, une courte description et par quoi commencer.";
      return `<p class="fg-note">${esc(hint)}</p>${forgeSel}${projectSel}
        <label class="fg-field-in">Ce que tu voudrais<textarea data-sc="idea" rows="4" maxlength="4000" placeholder="${tab() === "ticket" ? "Ex. j'aimerais télécharger les rapports du mois dans Excel" : "Ex. une petite appli pour suivre les rapports de mes clients"}">${esc(s.idea)}</textarea></label>
        <div class="fg-inline"><button type="button" class="fg-btn" data-sc-act="draft">Rédiger avec le Scribe</button></div>
        <p class="fg-note">Rien ne part chez ${esc(forgeName(source()))} tant que tu n'as pas dit oui. Le Scribe ne voit pas ton code : il se base sur ce que tu écris et sur les demandes déjà ouvertes.</p>`;
    }

    /** Ce que la personne valide : le ticket tel que la forge l'affichera. La création n'est proposée que depuis ce rendu. */
    function ticketPreviewHtml(s) {
      const chips = s.labels.length ? `<div class="fg-chips">${s.labels.map((l) => `<span class="fg-tag">${esc(l)}</span>`).join("")}</div>` : "";
      const questions = s.draft.questions.length ? `<div class="fg-questions"><b>Le Scribe se demande :</b>${list(s.draft.questions)}</div>` : "";
      return `${questions}<div class="fg-sc-card"><div class="fg-sc-card-head">Aperçu du ticket · ${esc(weapon()?.path ?? "")}</div>
        <h4>${esc(s.title) || "<i>(sans titre)</i>"}</h4>${chips}<div class="fg-md">${preview(s.desc) || "<p><i>(description vide)</i></p>"}</div></div>
        <div class="fg-note"><b>Pièces jointes</b> (captures d'écran, maquettes, données) : elles accompagnent le ticket, et l'agent les lira quand tu lui confieras ce ticket.</div>${attOf(s).html()}
        <div class="fg-inline"><button type="button" class="fg-btn" data-sc-act="create" ${attOf(s).busy ? "disabled" : ""}>Valider et créer chez ${esc(forgeName(source()))}</button><button type="button" class="fg-btn ghost" data-sc-act="edit">Modifier</button><button type="button" class="fg-btn ghost" data-sc-act="again">Refaire le brouillon</button></div>
        <p class="fg-note">Rien n'est envoyé tant que tu n'as pas cliqué sur « Valider et créer ». Une fois créé, le ticket t'est assigné (il apparaît dans « Mes tickets ») et il est visible de toute l'équipe.</p>`;
    }

    function ticketReviewHtml(s) {
      if (s.mode === "preview") return ticketPreviewHtml(s);
      const labels = s.allowed.length
        ? `<div class="fg-field-in">Étiquettes<div class="fg-chips">${s.allowed.map((l) => `<label class="fg-chip"><input type="checkbox" data-sc-label="${esc(l)}" ${s.labels.includes(l) ? "checked" : ""}>${esc(l)}</label>`).join("")}</div></div>` : "";
      const questions = s.draft.questions.length ? `<div class="fg-questions"><b>Le Scribe se demande :</b>${list(s.draft.questions)}</div>` : "";
      return `${questions}<label class="fg-field-in">Titre<input type="text" data-sc="title" maxlength="200" value="${esc(s.title)}"></label>
        <label class="fg-field-in">Description (Markdown)<textarea data-sc="desc" rows="11">${esc(s.desc)}</textarea></label>${labels}
        <div class="fg-inline"><button type="button" class="fg-btn" data-sc-act="preview">Voir le rendu</button><button type="button" class="fg-btn ghost" data-sc-act="again">Refaire le brouillon</button></div>
        <p class="fg-note">Projet : <b>${esc(weapon()?.path ?? "")}</b>. Tu verras le rendu avant que rien ne soit créé.</p>`;
    }

    function projectPreviewHtml(s) {
      const where = s.ns?.find((n) => n.id === s.nsId);
      const place = where ? `${where.path}${where.kind === "personal" ? " (ton espace)" : ""}` : "ton espace personnel";
      const picked = s.ft.filter((t) => t.on && t.title.trim());
      const tickets = picked.length
        ? `<h5>Premiers tickets (${picked.length})</h5>${picked.map((t) => `<details class="fg-ft-prev"><summary>${esc(t.title)}</summary><div class="fg-md">${preview(t.description) || "<p><i>(sans description)</i></p>"}</div></details>`).join("")}`
        : `<p class="fg-note">Aucun ticket de départ : le projet sera créé vide.</p>`;
      const questions = s.draft.questions.length ? `<div class="fg-questions"><b>Le Scribe se demande :</b>${list(s.draft.questions)}</div>` : "";
      return `${questions}<div class="fg-sc-card"><div class="fg-sc-card-head">Aperçu du projet</div>
        <h4>${esc(s.name) || "<i>(sans nom)</i>"}</h4><p>${esc(s.pdesc) || "<i>(sans description)</i>"}</p>
        <dl class="kv"><dt>Où</dt><dd>${esc(place)} chez ${esc(forgeName(source()))}</dd><dt>Visibilité</dt><dd>${s.priv ? "Privé" : "<b>Public : visible par tout Internet</b>"}</dd><dt>README</dt><dd>${s.readme ? "Oui, le dépôt est clonable tout de suite" : "Non, dépôt vide"}</dd></dl>${tickets}</div>
        <div class="fg-inline"><button type="button" class="fg-btn" data-sc-act="create">Valider et créer le projet</button><button type="button" class="fg-btn ghost" data-sc-act="edit">Modifier</button><button type="button" class="fg-btn ghost" data-sc-act="again">Refaire le brouillon</button></div>
        <p class="fg-note">Rien n'est créé tant que tu n'as pas cliqué sur « Valider et créer le projet ».</p>`;
    }

    function projectReviewHtml(s) {
      if (s.mode === "preview") return projectPreviewHtml(s);
      const ns = s.ns
        ? `<label class="fg-field-in">Où le créer<select data-sc="nsId">${s.ns.map((n) => `<option value="${esc(n.id)}" ${n.id === s.nsId ? "selected" : ""}>${esc(n.path)}${n.kind === "personal" ? " (ton espace)" : ""}</option>`).join("")}</select></label>`
        : s.nsErr ? `<p class="fg-note">Groupes indisponibles : ${esc(s.nsErr)} Le projet sera créé dans ton espace personnel.</p>` : `<p class="fg-note">Recherche des groupes…</p>`;
      const tickets = s.ft.length
        ? `<h4>Premiers tickets</h4>${s.ft.map((t, i) => `<div class="fg-ft"><label class="fg-chip"><input type="checkbox" data-sc-ft="${i}" ${t.on ? "checked" : ""}></label><div><input type="text" data-sc-ftt="${i}" maxlength="200" value="${esc(t.title)}"><small>${esc(t.description.slice(0, 160))}${t.description.length > 160 ? "…" : ""}</small></div></div>`).join("")}` : "";
      const questions = s.draft.questions.length ? `<div class="fg-questions"><b>Le Scribe se demande :</b>${list(s.draft.questions)}</div>` : "";
      return `${questions}<label class="fg-field-in">Nom du projet<input type="text" data-sc="name" maxlength="100" value="${esc(s.name)}"></label>
        <label class="fg-field-in">Description<input type="text" data-sc="pdesc" maxlength="500" value="${esc(s.pdesc)}"></label>${ns}
        <label class="fg-check"><input type="checkbox" data-sc="priv" ${s.priv ? "checked" : ""}> Privé (visible seulement par les personnes invitées)</label>
        ${s.priv ? "" : `<div class="fg-err">Public : tout le monde pourra lire ce projet sur Internet.</div>`}
        <label class="fg-check"><input type="checkbox" data-sc="readme" ${s.readme ? "checked" : ""}> Créer un README (le dépôt est alors clonable tout de suite)</label>${tickets}
        <div class="fg-inline"><button type="button" class="fg-btn" data-sc-act="preview">Voir le rendu</button><button type="button" class="fg-btn ghost" data-sc-act="again">Refaire le brouillon</button></div>`;
    }

    function doneHtml(s) {
      if (tab() === "ticket") {
        const r = s.result, w = weapon(), a = r.attachments;
        const files = a && a.files > 0
          ? `<p class="fg-note">${a.files} fichier${a.files > 1 ? "s" : ""} joint${a.files > 1 ? "s" : ""} : ${a.uploaded > 0 ? "ajouté" + (a.uploaded > 1 ? "s" : "") + " au ticket chez " + esc(forgeName(source())) + " et " : "pas ajouté au ticket (" + esc(forgeName(source())) + " ne permet pas de joindre un fichier à un ticket), mais "}gardé${a.files > 1 ? "s" : ""} pour l'agent, qui ${a.files > 1 ? "les" : "le"} recevra quand tu lui confieras ce ticket.</p>` : "";
        return `<div class="fg-done"><b>Ticket #${r.iid} créé</b> : ${link(r.url, r.title)}</div>${files}
          <div class="fg-inline">${w?.devEnabled ? `<button type="button" class="fg-btn" data-sc-act="forge" data-iid="${r.iid}">Confier à l'apprenti</button>` : ""}
          <button type="button" class="fg-btn ghost" data-sc-act="reset">Un autre ticket</button><button type="button" class="fg-btn ghost" data-sc-act="rack">Voir les tickets du projet</button></div>`;
      }
      const r = s.result;
      const rows = r.tickets.map((t) => `<li>${t.ok ? `#${t.iid} ${link(t.url, t.title)}` : `<span class="fg-err-inline">${esc(t.title)} : ${esc(t.error)}</span>`}</li>`).join("");
      return `<div class="fg-done"><b>Projet créé</b> : ${link(r.project.url, r.project.path)}</div>${rows ? `<ul>${rows}</ul>` : ""}
        <p class="fg-note">Pour que tes agents y travaillent, ajoute-le au râtelier, puis autorise l'agent dev.</p>
        <div class="fg-inline"><button type="button" class="fg-btn" data-sc-act="addrack">Ajouter au râtelier</button><button type="button" class="fg-btn ghost" data-sc-act="reset">Un autre projet</button></div>`;
    }

    const def = {
      wide: true,
      async render() {
        const s = st();
        const tabs = `<div class="fg-tabs"><button type="button" class="fg-tab ${tab() === "ticket" ? "on" : ""}" data-fg-sel="ticket">Nouveau ticket</button><button type="button" class="fg-tab ${tab() === "project" ? "on" : ""}" data-fg-sel="project">Nouveau projet</button></div>`;
        if (!forges().length) return { title: "Le Scribe", html: `<p class="fg-note">Le Scribe écrit chez GitHub ou GitLab : allume d'abord une forge (un fourneau, en haut de la forge) avec un jeton.</p>` };
        let body;
        if (busy(s.phase)) body = `<p class="fg-note fg-wait">${s.phase === "drafting" ? "Le Scribe rédige son brouillon… (une dizaine de secondes)" : "Le Scribe envoie à la forge…"}</p>`;
        else if (s.phase === "review") body = tab() === "ticket" ? ticketReviewHtml(s) : projectReviewHtml(s);
        else if (s.phase === "done") body = doneHtml(s);
        else body = ideaHtml(s);
        return { title: "Le Scribe", html: `${tabs}${errorHtml(s)}${body}${rightsHtml(source(), Boolean(s.err))}` };
      },
    };

    /** Saisie : mémorisée sans redessiner la fenêtre, pour ne pas perdre le curseur. */
    function handleInput(ev) {
      const t = ev.target, s = st();
      if (t.dataset.scLabel !== undefined) { s.labels = t.checked ? [...new Set([...s.labels, t.dataset.scLabel])] : s.labels.filter((l) => l !== t.dataset.scLabel); return; }
      if (t.dataset.scFt !== undefined) { s.ft[Number(t.dataset.scFt)].on = t.checked; return; }
      if (t.dataset.scFtt !== undefined) { s.ft[Number(t.dataset.scFtt)].title = t.value; return; }
      const k = t.dataset.sc;
      if (!k) return;
      const value = t.type === "checkbox" ? t.checked : t.value;
      if (k === "source") { sc.source = value; sc.key = null; sc.project.ns = null; sc.project.nsErr = ""; sc.project.nsId = ""; ctx.rerender(); return; }
      if (k === "key") { sc.key = value; return; }
      s[k] = value;
      if (k === "priv") ctx.rerender();
    }

    /** @returns Vrai si le clic était pour le Scribe. */
    function handleClick(ev) {
      const el = ev.target.closest("[data-sc-act]");
      if (!el) return false;
      const act = el.dataset.scAct, s = st();
      if (act === "draft") draft();
      else if (act === "create") create();
      else if (act === "edit") { s.mode = "edit"; s.err = ""; ctx.rerender(); }
      else if (act === "preview") { s.mode = "preview"; s.err = ""; ctx.rerender(); }
      else if (act === "again") { s.phase = "idea"; s.err = ""; ctx.rerender(); }
      else if (act === "reset") { sc[tab()] = fresh(); ctx.rerender(); }
      else if (act === "rack") ctx.open("rack", { select: weapon()?.key });
      else if (act === "addrack") ctx.open("rack", { prefill: { path: s.result.project.path, source: source() } });
      else if (act === "forge") ctx.launch({ source: source(), projectId: weapon().projectId, iid: Number(el.dataset.iid), title: s.result.title, projectPath: weapon().path });
      return true;
    }

    /** Ouvre le Scribe sur un projet donné (bouton « Nouveau ticket » du râtelier). */
    function focus(weaponKey) {
      const w = game().data.armory.weapons.find((x) => x.key === weaponKey);
      if (w) { sc.source = w.source; sc.key = w.key; }
      sc.ticket = sc.ticket.phase === "done" ? fresh() : sc.ticket;
    }

    return { def, handleClick, handleInput, focus };
  }

  window.ForgeScribe = { create, rightsHtml, preview };
})();
