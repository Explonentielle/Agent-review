/* Le Scribe : il rédige un ticket ou un projet avec l'agent, la personne relit et corrige, puis l'outil le crée chez GitHub ou GitLab.
   Page du tableau de bord (#tickets/new), indépendante de la forge (jeu). Elle utilise les fonctions communes de index.html (api, esc, toast,
   createAttachments, forgeName, projectKey, refreshHeader, state, go, ICON). */
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

  const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;

  /**
   * Bloc repliable « Quels droits donner au jeton ? », pour le Scribe comme pour les réglages de connexion.
   * @param {string} kind Forge (`github` ou `gitlab`).
   * @param {boolean} [open] Déplié d'emblée (après une erreur).
   * @param {string} [cls] Classe CSS en plus (la forge du jeu y met la sienne).
   * @returns {string} Le HTML, ou une chaîne vide pour une forge inconnue.
   */
  function rightsHtml(kind, open = false, cls = "") {
    const r = RIGHTS[kind];
    if (!r) return "";
    return `<details class="rights ${esc(cls)}" ${open ? "open" : ""}><summary>Quels droits donner au jeton ${esc(forgeName(kind))} ?</summary>
      <h5>Pour que les agents travaillent (le minimum)</h5>${list(r.base)}
      <h5>En plus, pour que le Scribe crée des tickets et des projets</h5>${list(r.scribe)}
      <p class="note">Sans les droits du Scribe, le reste de l'outil fonctionne : le Scribe te dira alors précisément quel droit manque.</p></details>`;
  }

  /**
   * Rendu du Markdown d'un ticket tel que la forge l'affichera : titres, listes, cases à cocher, gras, code. Tout est échappé AVANT la
   * mise en forme, et ni lien ni HTML ne sont rendus : ce que le Scribe écrit ne peut pas injecter de balise dans la page.
   * @param {string} text Markdown du ticket.
   * @returns {string} Le HTML.
   */
  function preview(text) {
    const out = [];
    let listTag = null;
    let para = [];
    const inline = (s) => esc(s).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    const flushP = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const closeL = () => { if (listTag) { out.push(`</${listTag}>`); listTag = null; } };
    for (const raw of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
      const line = raw.trimEnd();
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/);
      if (h) { flushP(); closeL(); const level = Math.min(6, h[1].length + 3); out.push(`<h${level}>${inline(h[2])}</h${level}>`); }
      else if (li) {
        flushP();
        const tag = /^\s*\d/.test(line) ? "ol" : "ul";
        if (listTag !== tag) { closeL(); out.push(`<${tag}>`); listTag = tag; }
        const box = li[1] === undefined ? "" : `<input type="checkbox" disabled ${li[1] === " " ? "" : "checked"}> `;
        out.push(`<li>${box}${inline(li[2])}</li>`);
      } else if (!line.trim()) { flushP(); closeL(); }
      else { closeL(); para.push(line); }
    }
    flushP(); closeL();
    return out.join("");
  }

  /** @returns Un état vierge pour un onglet (ticket ou projet). */
  const fresh = () => ({ mode: "preview", phase: "idea", idea: "", draft: null, labels: [], allowed: [], err: "", result: null, ns: null, nsErr: "", name: "", pdesc: "", nsId: "", priv: true, readme: true, ft: [], title: "", desc: "" });

  const sc = { tab: "ticket", source: null, key: null, projects: null, ticket: fresh(), project: fresh() };

  const isOpen = () => state.tab === "tickets" && location.hash === "#tickets/new";
  const st = () => sc[sc.tab];
  const forges = () => (state.stats?.forges || []).map((f) => f.kind);
  const source = () => (forges().includes(sc.source) ? sc.source : forges()[0] ?? null);
  const projects = () => (sc.projects || []).filter((p) => p.source === source());
  const project = () => projects().find((p) => projectKey(p) === sc.key) ?? projects()[0] ?? null;
  const busy = (phase) => phase === "drafting" || phase === "creating";
  /** Zone de pièces jointes du ticket en cours (créée à la demande ; la page se redessine à chaque changement). */
  const attOf = (s) => (s.att ??= createAttachments(() => { if (isOpen()) render(); }));
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
  const questionsHtml = (s) => (s.draft.questions.length ? `<div class="callout info">${ICON.info}<h3>Le Scribe se demande</h3>${list(s.draft.questions)}</div>` : "");

  /**
   * Charge les groupes où l'on peut créer un projet (onglet Nouveau projet), une seule fois par forge.
   * @returns {Promise<void>}
   */
  async function loadNamespaces() {
    const s = sc.project;
    if (s.ns || s.nsErr) return;
    try {
      s.ns = await api(`/api/forge/namespaces?source=${source()}`);
      s.nsId = s.nsId || (s.ns[0]?.id ?? "");
    } catch (err) { s.nsErr = err.message; }
    if (isOpen()) render();
  }

  /**
   * Demande un brouillon au Scribe (ticket ou projet) d'après l'idée dictée. Rien n'est créé chez la forge.
   * @returns {Promise<void>}
   */
  async function draft() {
    const s = st(), p = project();
    if (!s.idea.trim()) { s.err = "Dicte d'abord ton idée, même en quelques mots."; return render(); }
    if (sc.tab === "ticket" && !p) { s.err = "Choisis un projet : le ticket doit être rangé quelque part."; return render(); }
    s.phase = "drafting"; s.err = "";
    render();
    try {
      const out = await api("/api/scribe/draft", sc.tab === "ticket"
        ? { kind: "ticket", source: source(), projectId: p.projectId, idea: s.idea }
        : { kind: "project", source: source(), idea: s.idea });
      if (sc.tab === "ticket") {
        s.title = out.draft.title; s.desc = out.draft.description; s.allowed = out.allowedLabels; s.labels = [...out.draft.labels];
      } else {
        s.name = out.draft.name; s.pdesc = out.draft.description;
        s.ft = out.draft.firstTickets.map((t) => ({ on: true, title: t.title, description: t.description }));
      }
      s.draft = out.draft;
      s.phase = "review";
      s.mode = "preview";
      if (sc.tab === "project") loadNamespaces();
    } catch (err) { s.phase = "idea"; s.err = err.message; }
    if (isOpen()) render();
  }

  /**
   * Crée le ticket ou le projet chez la forge, après la validation de la personne sur le rendu.
   * @returns {Promise<void>}
   */
  async function create() {
    const s = st(), p = project();
    s.phase = "creating"; s.err = "";
    render();
    try {
      if (sc.tab === "ticket") {
        s.result = await api("/api/scribe/tickets", { source: source(), projectId: p.projectId, title: s.title, description: s.desc, labels: s.labels, attachments: attOf(s).ids() });
        attOf(s).reset(); // les fichiers ont été rattachés au ticket
      } else {
        s.result = await api("/api/scribe/projects", {
          source: source(), name: s.name, description: s.pdesc, namespaceId: s.nsId || undefined, private: s.priv, withReadme: s.readme,
          tickets: s.ft.filter((t) => t.on && t.title.trim()).map((t) => ({ title: t.title, description: t.description })),
        });
      }
      state.issues = null; // la liste des tickets se relit à la prochaine visite
      s.phase = "done";
      toast(sc.tab === "ticket" ? `Ticket #${s.result.iid} créé.` : `Projet « ${s.result.project.name} » créé.`);
    } catch (err) { s.phase = "review"; s.err = err.message; }
    if (isOpen()) render();
  }

  /** @returns Le formulaire de l'idée : forge, projet (pour un ticket) et texte dicté. */
  function ideaHtml(s) {
    const picks = forges();
    const forgeSel = picks.length > 1 ? `<label class="field"><span>Forge</span><select data-sc="source">${picks.map((k) => `<option value="${k}" ${k === source() ? "selected" : ""}>${esc(forgeName(k))}</option>`).join("")}</select></label>` : "";
    const p = project();
    const projectSel = sc.tab === "ticket"
      ? (projects().length
        ? `<label class="field"><span>Projet</span><select data-sc="key">${projects().map((x) => `<option value="${esc(projectKey(x))}" ${p && projectKey(x) === projectKey(p) ? "selected" : ""}>${esc(x.path)}</option>`).join("")}</select></label>`
        : `<p class="note">Aucun projet ${esc(forgeName(source()))} n'est configuré dans l'outil. <a href="#settings">Ajoute-le dans Paramètres > Projets</a>, ou crée-le avec l'onglet « Nouveau projet ».</p>`)
      : "";
    const hint = sc.tab === "ticket"
      ? "Dis simplement ce que tu voudrais, comme à un collègue. Par exemple : « J'aimerais pouvoir télécharger les rapports du mois dans Excel ». Le Scribe en fait une demande claire (un « ticket »), et tu la relis avant qu'elle parte."
      : "Décris ton projet avec tes mots. Par exemple : « Une petite appli pour suivre les rapports de mes clients ». Le Scribe propose un nom, une courte description et par quoi commencer.";
    const example = sc.tab === "ticket" ? "Ex. j'aimerais télécharger les rapports du mois dans Excel" : "Ex. une petite appli pour suivre les rapports de mes clients";
    return `<p class="note">${esc(hint)}</p>${forgeSel}${projectSel}
      <label class="field"><span>Ce que tu voudrais</span><textarea class="area" data-sc="idea" rows="4" maxlength="4000" placeholder="${esc(example)}">${esc(s.idea)}</textarea></label>
      <div class="actions-inline"><button type="button" class="btn primary" data-sc-act="draft">Rédiger avec le Scribe</button></div>
      <p class="note">Rien ne part chez ${esc(forgeName(source()))} tant que tu n'as pas dit oui. Le Scribe ne voit pas ton code : il se base sur ce que tu écris et sur les demandes déjà ouvertes.</p>`;
  }

  /** @returns Le ticket tel que la forge l'affichera : la création n'est proposée que depuis ce rendu. */
  function ticketPreviewHtml(s) {
    const labels = s.labels.length ? `<div class="labels">${s.labels.map((l) => `<span class="pill label">${esc(l)}</span>`).join("")}</div>` : "";
    return `${questionsHtml(s)}<div class="panel md sc-card"><div class="sc-card-head">Aperçu du ticket · ${esc(project()?.path ?? "")}</div>
      <h3>${esc(s.title) || "<i>(sans titre)</i>"}</h3>${labels}${preview(s.desc) || "<p><i>(description vide)</i></p>"}</div>
      <p class="note"><b>Pièces jointes</b> (captures d'écran, maquettes, données) : elles accompagnent le ticket, et l'agent les lira quand tu lui confieras ce ticket.</p>${attOf(s).html()}
      <div class="actions-inline"><button type="button" class="btn primary" data-sc-act="create" ${attOf(s).busy ? "disabled" : ""}>Valider et créer chez ${esc(forgeName(source()))}</button><button type="button" class="btn" data-sc-act="edit">Modifier</button><button type="button" class="btn ghost" data-sc-act="again">Refaire le brouillon</button></div>
      <p class="note">Rien n'est envoyé tant que tu n'as pas cliqué sur « Valider et créer ». Une fois créé, le ticket t'est assigné (il apparaît dans « Mes tickets ») et il est visible de toute l'équipe.</p>`;
  }

  /** @returns Les champs du ticket (titre, description, étiquettes) pour le corriger. */
  function ticketEditHtml(s) {
    const labels = s.allowed.length
      ? `<div class="field"><span>Étiquettes</span><div class="sc-labels">${s.allowed.map((l) => `<label class="check"><input type="checkbox" data-sc-label="${esc(l)}" ${s.labels.includes(l) ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div></div>` : "";
    return `${questionsHtml(s)}<label class="field"><span>Titre</span><input type="text" data-sc="title" maxlength="200" value="${esc(s.title)}"></label>
      <label class="field"><span>Description (Markdown)</span><textarea class="area" data-sc="desc" rows="11">${esc(s.desc)}</textarea></label>${labels}
      <div class="actions-inline"><button type="button" class="btn primary" data-sc-act="preview">Voir le rendu</button><button type="button" class="btn ghost" data-sc-act="again">Refaire le brouillon</button></div>
      <p class="note">Projet : <b>${esc(project()?.path ?? "")}</b>. Tu verras le rendu avant que rien ne soit créé.</p>`;
  }

  /** @returns Le projet tel qu'il sera créé, avec ses premiers tickets dépliables. */
  function projectPreviewHtml(s) {
    const where = s.ns?.find((n) => n.id === s.nsId);
    const place = where ? `${where.path}${where.kind === "personal" ? " (ton espace)" : ""}` : "ton espace personnel";
    const picked = s.ft.filter((t) => t.on && t.title.trim());
    const tickets = picked.length
      ? `<h4>Premiers tickets (${picked.length})</h4>${picked.map((t) => `<details class="sc-ft-prev"><summary>${esc(t.title)}</summary>${preview(t.description) || "<p><i>(sans description)</i></p>"}</details>`).join("")}`
      : `<p class="note">Aucun ticket de départ : le projet sera créé vide.</p>`;
    return `${questionsHtml(s)}<div class="panel md sc-card"><div class="sc-card-head">Aperçu du projet</div>
      <h3>${esc(s.name) || "<i>(sans nom)</i>"}</h3><p>${esc(s.pdesc) || "<i>(sans description)</i>"}</p>
      <dl class="kv"><dt>Où</dt><dd>${esc(place)} chez ${esc(forgeName(source()))}</dd><dt>Visibilité</dt><dd>${s.priv ? "Privé" : "<b>Public : visible par tout Internet</b>"}</dd><dt>README</dt><dd>${s.readme ? "Oui, le dépôt est clonable tout de suite" : "Non, dépôt vide"}</dd></dl>${tickets}</div>
      <div class="actions-inline"><button type="button" class="btn primary" data-sc-act="create">Valider et créer le projet</button><button type="button" class="btn" data-sc-act="edit">Modifier</button><button type="button" class="btn ghost" data-sc-act="again">Refaire le brouillon</button></div>
      <p class="note">Rien n'est créé tant que tu n'as pas cliqué sur « Valider et créer le projet ».</p>`;
  }

  /** @returns Les champs du projet (nom, groupe, visibilité, premiers tickets) pour le corriger. */
  function projectEditHtml(s) {
    const ns = s.ns
      ? `<label class="field"><span>Où le créer</span><select data-sc="nsId">${s.ns.map((n) => `<option value="${esc(n.id)}" ${n.id === s.nsId ? "selected" : ""}>${esc(n.path)}${n.kind === "personal" ? " (ton espace)" : ""}</option>`).join("")}</select></label>`
      : s.nsErr ? `<p class="note">Groupes indisponibles : ${esc(s.nsErr)} Le projet sera créé dans ton espace personnel.</p>` : `<p class="note">Recherche des groupes…</p>`;
    const tickets = s.ft.length
      ? `<h4>Premiers tickets</h4>${s.ft.map((t, i) => `<div class="sc-ft"><label class="check"><input type="checkbox" data-sc-ft="${i}" ${t.on ? "checked" : ""}></label><div><input type="text" data-sc-ftt="${i}" maxlength="200" value="${esc(t.title)}"><small class="note">${esc(t.description.slice(0, 160))}${t.description.length > 160 ? "…" : ""}</small></div></div>`).join("")}` : "";
    return `${questionsHtml(s)}<label class="field"><span>Nom du projet</span><input type="text" data-sc="name" maxlength="100" value="${esc(s.name)}"></label>
      <label class="field"><span>Description</span><input type="text" data-sc="pdesc" maxlength="500" value="${esc(s.pdesc)}"></label>${ns}
      <label class="check"><input type="checkbox" data-sc="priv" ${s.priv ? "checked" : ""}> Privé (visible seulement par les personnes invitées)</label>
      ${s.priv ? "" : `<div class="callout warn">${ICON.warn}<h3>Public</h3><p>Tout le monde pourra lire ce projet sur Internet.</p></div>`}
      <label class="check"><input type="checkbox" data-sc="readme" ${s.readme ? "checked" : ""}> Créer un README (le dépôt est alors clonable tout de suite)</label>${tickets}
      <div class="actions-inline"><button type="button" class="btn primary" data-sc-act="preview">Voir le rendu</button><button type="button" class="btn ghost" data-sc-act="again">Refaire le brouillon</button></div>`;
  }

  /** @returns Ce qui a été créé, et la suite : voir les tickets, confier le ticket à l'agent, configurer le projet. */
  function doneHtml(s) {
    const r = s.result;
    if (sc.tab === "ticket") {
      const a = r.attachments;
      const files = a && a.files > 0
        ? `<p>${a.files} fichier${a.files > 1 ? "s" : ""} joint${a.files > 1 ? "s" : ""} : ${a.uploaded > 0 ? `ajouté${a.uploaded > 1 ? "s" : ""} au ticket chez ${esc(forgeName(source()))} et ` : `pas ajouté au ticket (${esc(forgeName(source()))} ne permet pas de joindre un fichier à un ticket), mais `}gardé${a.files > 1 ? "s" : ""} pour l'agent, qui ${a.files > 1 ? "les" : "le"} recevra quand tu lui confieras ce ticket.</p>` : "";
      return `<div class="callout ok">${ICON.ok}<h3>Ticket #${esc(r.iid)} créé</h3><p>${link(r.url, r.title)}</p>${files}
        <div class="actions-inline"><button type="button" class="btn primary sm" data-sc-act="tickets">Voir dans Mes tickets (pour confier à l'agent)</button><button type="button" class="btn sm" data-sc-act="reset">Un autre ticket</button></div></div>`;
    }
    const rows = r.tickets.map((t) => `<li>${t.ok ? `#${esc(t.iid)} ${link(t.url, t.title)}` : `<span class="sc-err">${esc(t.title)} : ${esc(t.error)}</span>`}</li>`).join("");
    return `<div class="callout ok">${ICON.ok}<h3>Projet créé</h3><p>${link(r.project.url, r.project.path)}</p>${rows ? `<ul>${rows}</ul>` : ""}
      <p>Pour que l'agent y travaille, configure-le dans l'outil (branches, commandes, agent dev).</p>
      <div class="actions-inline"><button type="button" class="btn primary sm" data-configure="${esc(r.project.path)}" data-configure-source="${esc(source())}">Configurer ce projet pour l'agent</button><button type="button" class="btn sm" data-sc-act="reset">Un autre projet</button></div></div>`;
  }

  /** Redessine la page du Scribe dans la vue des tickets. */
  function render() {
    const root = document.getElementById("view-tickets");
    if (!root) return;
    const s = st();
    const tabs = `<div class="chips sc-tabs">${[["ticket", "Nouveau ticket"], ["project", "Nouveau projet"]].map(([k, label]) => `<button type="button" class="fchip ${sc.tab === k ? "active" : ""}" data-sc-tab="${k}">${label}</button>`).join("")}</div>`;
    let body;
    if (!forges().length) body = `<div class="callout info">${ICON.info}<h3>Aucune forge connectée</h3><p>Le Scribe écrit chez GitHub ou GitLab : enregistre d'abord un jeton dans <a href="#settings">Paramètres > Connexion</a>.</p></div>`;
    else if (busy(s.phase)) body = `<p class="note"><span class="pulse"></span> ${s.phase === "drafting" ? "Le Scribe rédige son brouillon… (une dizaine de secondes)" : "Le Scribe envoie à la forge…"}</p>`;
    else if (s.phase === "review") body = sc.tab === "ticket" ? (s.mode === "preview" ? ticketPreviewHtml(s) : ticketEditHtml(s)) : (s.mode === "preview" ? projectPreviewHtml(s) : projectEditHtml(s));
    else if (s.phase === "done") body = doneHtml(s);
    else body = ideaHtml(s);
    const err = s.err ? `<div class="callout err">${ICON.err}<h3>Le Scribe a un souci</h3><pre>${esc(s.err)}</pre></div>` : "";
    root.innerHTML = `<div class="page"><div class="page-inner">
      <div class="page-head"><div><h1>Le Scribe</h1><div class="sub">Dicte une idée : il rédige le ticket (ou le projet), tu relis, puis il le crée chez ${esc(forgeName(source()))}</div></div><span class="spacer"></span><a class="btn" href="#tickets">← Mes tickets</a></div>
      ${tabs}${err}<div class="panel sc-panel">${body}</div>${forges().length ? rightsHtml(source(), Boolean(s.err)) : ""}
    </div></div>`;
  }

  /**
   * Ouvre la page du Scribe : charge les projets configurés (une fois), puis dessine. Appelée par le routage sur `#tickets/new`.
   * @returns {Promise<void>}
   */
  async function show() {
    if (!state.stats) await refreshHeader();
    if (!sc.projects) sc.projects = await api("/api/projects").catch(() => []);
    if (sc.ticket.phase === "done") sc.ticket = fresh(); // un nouveau passage repart d'un ticket vierge
    if (isOpen()) render();
  }

  // Saisie : mémorisée sans redessiner la page, pour ne pas perdre le curseur (sauf les choix qui changent ce qui s'affiche)
  document.addEventListener("input", (ev) => {
    if (!isOpen()) return;
    const t = ev.target, s = st();
    if (t.dataset?.scLabel !== undefined) { s.labels = t.checked ? [...new Set([...s.labels, t.dataset.scLabel])] : s.labels.filter((l) => l !== t.dataset.scLabel); return; }
    if (t.dataset?.scFt !== undefined) { s.ft[Number(t.dataset.scFt)].on = t.checked; return; }
    if (t.dataset?.scFtt !== undefined) { s.ft[Number(t.dataset.scFtt)].title = t.value; return; }
    const k = t.dataset?.sc;
    if (!k) return;
    const value = t.type === "checkbox" ? t.checked : t.value;
    if (k === "source") { sc.source = value; sc.key = null; sc.project.ns = null; sc.project.nsErr = ""; sc.project.nsId = ""; render(); return; }
    if (k === "key") { sc.key = value; return; }
    s[k] = value;
    if (k === "priv") render();
  });

  document.addEventListener("click", (ev) => {
    if (!isOpen()) return;
    const tab = ev.target.closest?.("[data-sc-tab]");
    if (tab) { sc.tab = tab.dataset.scTab === "project" ? "project" : "ticket"; render(); return; }
    const el = ev.target.closest?.("[data-sc-act]");
    if (!el) return;
    const act = el.dataset.scAct, s = st();
    if (act === "draft") draft();
    else if (act === "create") create();
    else if (act === "edit") { s.mode = "edit"; s.err = ""; render(); }
    else if (act === "preview") { s.mode = "preview"; s.err = ""; render(); }
    else if (act === "again") { s.phase = "idea"; s.err = ""; render(); }
    else if (act === "reset") { sc[sc.tab] = fresh(); render(); }
    else if (act === "tickets") go("#tickets");
  });

  window.Scribe = { show, rightsHtml, preview };
})();
