/* L'orchestrateur : un chat de cadrage aboutit à un plan de tickets, que la personne relit et corrige ; une fois validé, les tickets sont créés chez la forge
   puis lancés un par un, dans l'ordre, et l'avancement est affiché ticket par ticket. Page du tableau de bord (#tickets/plans), indépendante de la forge (jeu).
   Elle utilise les fonctions communes de index.html (api, esc, toast, ask, forgeName, projectKey, refreshHeader, state, go, ICON, ago, Scribe.preview). */
(() => {
  "use strict";

  const PLAN_STATUS = {
    waiting_chat: ["Chat planifié", "orange"], chatting: ["Chat en cours", "orange"], review: ["À valider", "orange"], scheduled: ["Planifié", ""],
    running: ["En cours", "accent"], paused: ["En pause", "orange"], done: ["Terminé", "green"], failed: ["En échec", "red"], cancelled: ["Annulé", ""],
  };
  const ITEM_STATUS = {
    proposed: ["Proposé", "orange"], pending: ["À venir", ""], running: ["En cours", "accent"], done: ["Terminé", "green"],
    failed: ["En échec", "red"], skipped: ["Écarté", ""], cancelled: ["Annulé", ""],
  };
  /** Statuts où le plan évolue tout seul : la page se rafraîchit. */
  const LIVE = ["waiting_chat", "scheduled", "running", "paused"];
  const POLL_MS = 8000;

  const pl = {
    id: null, plans: null, detail: null, projects: null, err: "", busy: false,
    form: { kind: "feature", source: null, key: null, idea: "", chatAt: "" },
    msg: "", runAt: "", edit: null, timer: null,
    /** Case « attendre la fusion » cochée par la personne avant la validation ; null : la valeur enregistrée sur le plan. */
    wait: null,
    /** Code des MR déjà demandé, par tâche : { loading } pendant la lecture, { data } ou { err } ensuite. */
    code: {},
    /** Tickets dépliés, pour que la page se redessinant seule ne les referme pas. */
    open: new Set(),
  };

  const isOpen = () => state.tab === "tickets" && location.hash.startsWith("#tickets/plans");
  const forges = () => (state.stats?.forges || []).map((f) => f.kind);
  const source = () => (forges().includes(pl.form.source) ? pl.form.source : forges()[0] ?? null);
  const projects = () => (pl.projects || []).filter((p) => p.source === source() && p.devEnabled);
  const project = () => projects().find((p) => projectKey(p) === pl.form.key) ?? projects()[0] ?? null;
  const when = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "");
  /** Date saisie dans un champ `datetime-local` (heure de la machine) vers le format ISO que le serveur attend ; vide : tout de suite. */
  const toIso = (local) => (local ? new Date(local).toISOString() : null);
  const pill = (map, status) => { const [label, color] = map[status] || [status, ""]; return `<span class="pill ${color}">${esc(label)}</span>`; };
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

  /** Rappelle la dernière action en cas d'échec : la page affiche l'erreur sans perdre la saisie. */
  async function act(fn) {
    pl.busy = true; pl.err = "";
    paint();
    try { await fn(); } catch (err) { pl.err = err.message; }
    pl.busy = false;
    if (pl.id) await loadDetail(false);
    else await loadList(false);
    paint();
  }

  async function loadList(repaint = true) {
    try { pl.plans = await api("/api/plans"); } catch (err) { pl.err = err.message; pl.plans = pl.plans || []; }
    if (repaint) paint();
  }

  /**
   * Relit le plan. Une page rafraîchie seule ne se redessine que si le plan a changé : sinon elle refermerait les fichiers du code affiché.
   * @param {boolean} [repaint] Faux pour laisser l'appelant redessiner.
   * @returns {Promise<void>}
   */
  async function loadDetail(repaint = true) {
    const before = pl.detail ? JSON.stringify(pl.detail) : null;
    try { pl.detail = await api(`/api/plans/${pl.id}`); } catch (err) { pl.err = err.message; pl.detail = null; }
    if (repaint && (before === null || before !== JSON.stringify(pl.detail))) paint();
  }

  /**
   * Lit le code de la MR d'un ticket chez la forge (diff.js) et le garde pour les prochains affichages de la page.
   * @param {number} taskId Tâche de l'agent qui a ouvert la MR.
   * @returns {Promise<void>}
   */
  async function loadCode(taskId) {
    pl.code[taskId] = { loading: true };
    paint();
    try { pl.code[taskId] = { data: await window.CodeView.load(taskId) }; } catch (err) { pl.code[taskId] = { err: err.message }; }
    paint();
  }

  /**
   * Zone « code » d'un ticket qui a ouvert une MR : le bouton, la lecture en cours, l'erreur ou le code.
   * @param {number} taskId Tâche de l'agent.
   * @returns {string} Le HTML de la zone.
   */
  function codeHtml(taskId) {
    const c = pl.code[taskId];
    const button = (label) => `<button type="button" class="btn sm" data-pl-code="${taskId}">${label}</button>`;
    if (!c) return button("Voir le code");
    if (c.loading) return `<p class="note">Lecture du code chez la forge…</p>`;
    if (c.err) return `<p class="note">Impossible de lire le code : ${esc(c.err)}</p>${button("Réessayer")}`;
    return window.CodeView.html(c.data);
  }

  /** Ouvre un chat de cadrage : tout de suite, ou à la date choisie. */
  async function create() {
    const f = pl.form, p = project();
    if (!p) { pl.err = "Choisis un projet configuré pour l'agent dev."; return paint(); }
    if (!f.idea.trim()) { pl.err = "Décris d'abord ce que tu voudrais."; return paint(); }
    pl.busy = true; pl.err = "";
    paint();
    try {
      const out = await api("/api/plans", { kind: f.kind, source: source(), projectId: p.projectId, idea: f.idea, chatAt: toIso(f.chatAt) });
      pl.form = { ...f, idea: "", chatAt: "" };
      if (out.error) toast(out.error, true);
      pl.busy = false;
      go(`#tickets/plans/${out.id}`);
      return;
    } catch (err) { pl.err = err.message; }
    pl.busy = false;
    paint();
  }

  /** Valide le plan après une confirmation explicite : c'est ce clic qui crée les tickets chez la forge, avec le choix d'attendre ou non la fusion des MR. */
  async function validate() {
    const d = pl.detail;
    const n = d.items.length;
    const date = toIso(pl.runAt);
    const wait = pl.wait ?? d.plan.waitForMerge;
    const ok = await ask({
      title: `Valider ce plan et créer ${n} ticket${n > 1 ? "s" : ""} ?`,
      html: `<p>Les ${n} ticket${n > 1 ? "s" : ""} seront créés chez ${esc(forgeName(d.plan.source))} dans le projet <b>${esc(d.plan.projectPath)}</b>, puis l'agent dev les traitera <b>l'un après l'autre</b>, dans l'ordre${date ? `, à partir du <b>${esc(when(date))}</b>` : ", tout de suite"}.</p><p>${wait ? "Chaque ticket <b>attend la fusion de la MR du précédent</b> : le plan avance à la vitesse de tes fusions." : "Chaque ticket part <b>dès que la MR du précédent est ouverte</b>, sans attendre sa fusion : il ne voit pas le code des MR non fusionnées."}</p><p>Tu pourras mettre le plan en pause ou l'annuler ; les tickets déjà créés restent chez la forge.</p>`,
      okLabel: "Valider et lancer",
    });
    if (!ok) return;
    await act(async () => {
      await api(`/api/plans/${pl.id}/validate`, { confirm: true, runAt: date, waitForMerge: wait });
      state.issues = null;
      toast("Plan validé : les tickets sont créés.");
    });
  }

  /** Enregistre la liste de tickets corrigée à la main. */
  async function saveEdit() {
    await act(async () => {
      await api(`/api/plans/${pl.id}/items`, { items: pl.edit.map((i) => ({ title: i.title, description: i.description, labels: i.labels, runAt: toIso(i.runAt) })) });
      pl.edit = null;
      toast("Plan enregistré.");
    });
  }

  /** Message de la personne dans le chat. */
  async function send() {
    const text = pl.msg.trim();
    await act(async () => {
      const out = await api(`/api/plans/${pl.id}/messages`, { text });
      pl.msg = "";
      if (out.error) toast(out.error, true);
    });
  }

  function startEdit() {
    pl.edit = pl.detail.items.map((i) => ({ title: i.title, description: i.description, labels: i.labels, runAt: "" }));
    paint();
  }

  /** Déplace un ticket de la liste en cours de correction (avant validation). */
  function moveEdit(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= pl.edit.length) return;
    [pl.edit[i], pl.edit[j]] = [pl.edit[j], pl.edit[i]];
    paint();
  }

  /** Déplace un ticket en attente d'un plan validé : le serveur reçoit l'ordre complet des tickets en attente. */
  async function movePending(itemId, delta) {
    const pending = pl.detail.items.filter((i) => i.status === "pending").map((i) => i.id);
    const i = pending.indexOf(itemId), j = i + delta;
    if (i < 0 || j < 0 || j >= pending.length) return;
    [pending[i], pending[j]] = [pending[j], pending[i]];
    await act(() => api(`/api/plans/${pl.id}/reorder`, { order: pending }));
  }

  function chatHtml(d) {
    const open = d.plan.status === "chatting" || d.plan.status === "review";
    const started = d.items.some((i) => i.status !== "proposed");
    const log = d.messages.map((m) => `<div class="pl-msg ${m.role}"><div class="who">${m.role === "user" ? "Toi" : "Orchestrateur"}</div>${esc(m.text).replace(/\n/g, "<br>")}</div>`).join("");
    const waiting = d.plan.status === "waiting_chat" ? `<p class="note">Le chat démarrera le <b>${esc(when(d.plan.chatAt))}</b> (à quelques secondes près). <button type="button" class="btn sm" data-pl-act="chat-now">Le lancer maintenant</button></p>` : "";
    const busy = d.plan.busy ? `<p class="note"><span class="pulse"></span> L'orchestrateur réfléchit… (une dizaine de secondes)</p>` : "";
    const form = open && !started && !d.plan.busy
      ? `<label class="field"><span>Ta réponse</span><textarea class="area" data-pl="msg" rows="3" maxlength="4000" placeholder="Réponds aux questions, ou demande un changement du plan">${esc(pl.msg)}</textarea></label>
         <div class="actions-inline"><button type="button" class="btn primary" data-pl-act="send" ${pl.busy ? "disabled" : ""}>Envoyer</button>${d.messages.at(-1)?.role === "user" ? `<button type="button" class="btn" data-pl-act="retry-turn" ${pl.busy ? "disabled" : ""}>Relancer la réponse</button>` : ""}</div>`
      : "";
    return `<div class="panel pl-chat"><div class="sc-card-head">Chat de cadrage</div>${log}${waiting}${busy}${form}</div>`;
  }

  /** Liste des tickets en cours de correction (avant validation). */
  function editHtml() {
    const rows = pl.edit.map((t, i) => `<div class="pl-edit">
      <div class="pl-edit-head"><b>${i + 1}.</b>
        <input type="text" data-pl-title="${i}" maxlength="200" value="${esc(t.title)}">
        <button type="button" class="btn sm" data-pl-up="${i}" title="Monter" ${i === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="btn sm" data-pl-down="${i}" title="Descendre" ${i === pl.edit.length - 1 ? "disabled" : ""}>↓</button>
        <button type="button" class="btn sm" data-pl-del="${i}" title="Retirer ce ticket">✕</button></div>
      <textarea class="area" data-pl-desc="${i}" rows="6">${esc(t.description)}</textarea>
      <label class="field"><span>Lancer ce ticket pas avant (facultatif)</span><input type="datetime-local" data-pl-at="${i}" value="${esc(t.runAt)}"></label></div>`).join("");
    return `<div class="panel"><div class="sc-card-head">Corriger le plan</div>${rows}
      <div class="actions-inline"><button type="button" class="btn" data-pl-act="add">Ajouter un ticket</button><button type="button" class="btn primary" data-pl-act="save-edit" ${pl.busy || !pl.edit.length ? "disabled" : ""}>Enregistrer</button><button type="button" class="btn ghost" data-pl-act="cancel-edit">Abandonner les modifications</button></div></div>`;
  }

  /** Tickets du plan avec leur avancement et les actions possibles sur chacun. */
  function itemsHtml(d) {
    const started = d.items.some((i) => i.status !== "proposed");
    const pending = d.items.filter((i) => i.status === "pending");
    const rows = d.items.map((t) => {
      const labels = t.labels.length ? t.labels.map((l) => `<span class="pill label">${esc(l)}</span>`).join(" ") : "";
      const ref = t.issueIid ? ` · ${t.issueUrl ? link(t.issueUrl, `#${t.issueIid}`) : `#${esc(t.issueIid)}`}` : "";
      const task = t.task ? ` · <a href="#dev/${esc(t.task.id)}">tâche #${esc(t.task.id)}</a>${t.task.mrUrl ? ` · ${link(t.task.mrUrl, "MR")}` : ""}` : "";
      const at = t.runAt ? ` · pas avant le ${esc(when(t.runAt))}` : "";
      const pi = pending.findIndex((p) => p.id === t.id);
      const actions = [
        pi >= 0 && ["scheduled", "running", "paused", "failed"].includes(d.plan.status) ? `<button type="button" class="btn sm" data-pl-pend-up="${t.id}" ${pi === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn sm" data-pl-pend-down="${t.id}" ${pi === pending.length - 1 ? "disabled" : ""}>↓</button>` : "",
        t.status === "failed" ? `<button type="button" class="btn sm" data-pl-retry="${t.id}">Relancer</button>` : "",
        t.status === "pending" || t.status === "failed" ? `<button type="button" class="btn sm" data-pl-skip="${t.id}">Écarter</button>` : "",
      ].join("");
      const code = t.task?.mrUrl ? `<div class="pl-code">${codeHtml(t.task.id)}</div>` : "";
      return `<details class="pl-item" data-pl-item="${t.id}" ${pl.open.has(t.id) ? "open" : ""}><summary>${pill(ITEM_STATUS, t.status)} <b>${t.position}. ${esc(t.title)}</b>${ref}${task}${at}</summary>
        ${labels ? `<div class="labels">${labels}</div>` : ""}${t.error ? `<p class="sc-err">${esc(t.error)}</p>` : ""}
        <div class="md">${window.Scribe.preview(t.description) || "<p><i>(description vide)</i></p>"}</div>${code}${actions ? `<div class="actions-inline">${actions}</div>` : ""}</details>`;
    }).join("");
    const canEdit = (d.plan.status === "review" || d.plan.status === "chatting") && !started && !d.plan.busy;
    return `<div class="panel"><div class="sc-card-head">Tickets du plan (${d.items.length})</div>${rows || `<p class="note">Pas encore de ticket : continue l'échange, l'orchestrateur proposera le plan quand le besoin sera clair.</p>`}
      ${canEdit && d.items.length ? `<div class="actions-inline"><button type="button" class="btn" data-pl-act="edit">Corriger le plan</button></div>` : ""}</div>`;
  }

  /** Validation, planification, pause, reprise et annulation selon l'état du plan. */
  function controlsHtml(d) {
    const s = d.plan.status;
    const buttons = [];
    if (s === "review" && !d.plan.busy) {
      return `<div class="callout info">${ICON.info}<h3>Rien n'est créé tant que tu n'as pas validé</h3>
        <p>Relis la liste, corrige-la si besoin, puis valide : les tickets sont alors créés chez ${esc(forgeName(d.plan.source))} et l'agent dev les traite dans l'ordre.</p>
        <label class="field"><span>Lancer l'exécution à partir de (facultatif, sinon tout de suite)</span><input type="datetime-local" data-pl="runAt" value="${esc(pl.runAt)}"></label>
        <label class="check"><input type="checkbox" data-pl="wait" ${(pl.wait ?? d.plan.waitForMerge) ? "checked" : ""}> Attendre la fusion de la MR de chaque ticket avant de lancer le suivant</label>
        <p class="note">À garder coché quand les tickets dépendent les uns des autres : sinon le suivant part d'une base sans le code de la MR précédente. L'outil ne fusionne jamais seul : le plan avance à la vitesse de tes fusions (sur la forge, ou depuis la tâche).</p>
        <div class="actions-inline"><button type="button" class="btn primary" data-pl-act="validate" ${pl.busy || pl.edit ? "disabled" : ""}>Valider le plan</button>${pl.edit ? "<small>Enregistre ou abandonne tes corrections d'abord.</small>" : ""}</div></div>`;
    }
    if (s === "scheduled" || s === "running") buttons.push(`<button type="button" class="btn" data-pl-act="pause">Mettre en pause</button>`);
    if (s === "paused") buttons.push(`<button type="button" class="btn primary" data-pl-act="resume">Reprendre</button>`);
    if (s === "failed" && !d.items.some((i) => i.status === "failed")) buttons.push(`<button type="button" class="btn primary" data-pl-act="resume">Reprendre</button>`);
    if (!["done", "cancelled"].includes(s)) buttons.push(`<button type="button" class="btn danger" data-pl-act="cancel">Annuler le plan</button>`);
    const schedule = s === "scheduled" && d.plan.runAt ? `<p>Exécution planifiée le <b>${esc(when(d.plan.runAt))}</b>.</p>` : "";
    const wait = d.plan.waitForMerge;
    const waitLine = ["scheduled", "running", "paused", "failed"].includes(s)
      ? `<p class="note">${wait ? "Chaque ticket attend la fusion de la MR du précédent." : "Les tickets s'enchaînent sans attendre la fusion des MR."} <button type="button" class="btn sm" data-pl-act="${wait ? "wait-off" : "wait-on"}" ${pl.busy ? "disabled" : ""}>${wait ? "Ne plus attendre" : "Attendre la fusion"}</button></p>`
      : "";
    return buttons.length || schedule || waitLine ? `<div class="panel">${schedule}${waitLine}<div class="actions-inline">${buttons.join("")}</div></div>` : "";
  }

  function progressHtml(d) {
    const c = { upcoming: 0, running: 0, done: 0, failed: 0, skipped: 0 };
    for (const i of d.items) {
      if (i.status === "proposed" || i.status === "pending") c.upcoming++;
      else if (i.status === "running") c.running++;
      else if (i.status === "done") c.done++;
      else if (i.status === "failed") c.failed++;
      else c.skipped++;
    }
    return `<p class="note">À venir : <b>${c.upcoming}</b> · En cours : <b>${c.running}</b> · Terminés : <b>${c.done}</b> · En échec : <b>${c.failed}</b>${c.skipped ? ` · Écartés : <b>${c.skipped}</b>` : ""}</p>`;
  }

  function detailHtml() {
    const d = pl.detail;
    if (!d) return pl.err ? "" : `<p class="note">Chargement…</p>`;
    const alert = d.plan.error ? `<div class="callout ${d.plan.status === "failed" ? "err" : "warn"}">${d.plan.status === "failed" ? ICON.err : ICON.warn}<h3>${d.plan.status === "failed" ? "Le plan s'est arrêté" : "À noter"}</h3><pre>${esc(d.plan.error)}</pre></div>` : "";
    return `<div class="panel"><h3>${esc(d.plan.title)}</h3><p>${pill(PLAN_STATUS, d.plan.status)} ${esc(d.plan.kind === "project" ? "Projet complet" : "Fonctionnalité")} · ${esc(d.plan.projectPath)} (${esc(forgeName(d.plan.source))})</p>${d.items.length ? progressHtml(d) : ""}</div>
      ${alert}${controlsHtml(d)}${pl.edit ? editHtml() : itemsHtml(d)}${chatHtml(d)}`;
  }

  function listHtml() {
    const f = pl.form;
    const picks = forges();
    const forgeSel = picks.length > 1 ? `<label class="field"><span>Forge</span><select data-pl="source">${picks.map((k) => `<option value="${k}" ${k === source() ? "selected" : ""}>${esc(forgeName(k))}</option>`).join("")}</select></label>` : "";
    const p = project();
    const projectSel = projects().length
      ? `<label class="field"><span>Projet</span><select data-pl="key">${projects().map((x) => `<option value="${esc(projectKey(x))}" ${p && projectKey(x) === projectKey(p) ? "selected" : ""}>${esc(x.path)}</option>`).join("")}</select></label>`
      : `<p class="note">Aucun projet ${esc(forgeName(source()))} n'est configuré pour l'agent dev. <a href="#settings">Ajoute-le dans Paramètres > Projets</a>.</p>`;
    const form = `<div class="panel sc-panel"><div class="sc-card-head">Nouveau plan</div>
      <div class="chips">${[["feature", "Une fonctionnalité"], ["project", "Un projet complet"]].map(([k, label]) => `<button type="button" class="fchip ${f.kind === k ? "active" : ""}" data-pl-kind="${k}">${label}</button>`).join("")}</div>
      <p class="note">Décris ce que tu veux : l'orchestrateur te pose des questions, puis propose une liste de tickets que tu relis. Rien n'est créé ni lancé sans ta validation.</p>
      ${forgeSel}${projectSel}
      <label class="field"><span>Ce que tu voudrais</span><textarea class="area" data-pl="idea" rows="4" maxlength="4000" placeholder="${f.kind === "project" ? "Ex. une petite appli pour suivre les rapports de mes clients" : "Ex. exporter les rapports du mois en Excel"}">${esc(f.idea)}</textarea></label>
      <label class="field"><span>Lancer le chat à partir de (facultatif, sinon tout de suite)</span><input type="datetime-local" data-pl="chatAt" value="${esc(f.chatAt)}"></label>
      <div class="actions-inline"><button type="button" class="btn primary" data-pl-act="create" ${pl.busy ? "disabled" : ""}>${f.chatAt ? "Planifier le chat" : "Démarrer le chat"}</button></div></div>`;
    const rows = (pl.plans || []).map((p2) => {
      const c = p2.counts;
      return `<a class="pl-row" href="#tickets/plans/${esc(p2.id)}">${pill(PLAN_STATUS, p2.status)} <b>${esc(p2.title)}</b><span class="spacer"></span><small>${esc(p2.projectPath)}${c.total ? ` · ${c.done}/${c.total} terminé${c.done > 1 ? "s" : ""}${c.failed ? `, ${c.failed} en échec` : ""}` : ""} · ${esc(ago(p2.createdAt))}</small></a>`;
    }).join("");
    return `${form}<div class="panel"><div class="sc-card-head">Mes plans</div>${rows || `<p class="note">Aucun plan pour l'instant.</p>`}</div>`;
  }

  /** Redessine la page dans la vue des tickets. La saisie en cours est conservée dans `pl`. */
  function paint() {
    const root = document.getElementById("view-tickets");
    if (!root || !isOpen()) return;
    let body;
    if (!forges().length) body = `<div class="callout info">${ICON.info}<h3>Aucune forge connectée</h3><p>Enregistre d'abord un jeton dans <a href="#settings">Paramètres > Connexion</a>.</p></div>`;
    else body = pl.id ? detailHtml() : listHtml();
    const err = pl.err ? `<div class="callout err">${ICON.err}<h3>Un souci</h3><pre>${esc(pl.err)}</pre></div>` : "";
    root.innerHTML = `<div class="page"><div class="page-inner">
      <div class="page-head"><div><h1>Plans</h1><div class="sub">Cadrer avec l'orchestrateur, valider la liste de tickets, puis suivre leur exécution</div></div><span class="spacer"></span>
        ${pl.id ? `<a class="btn" href="#tickets/plans">← Tous les plans</a>` : `<a class="btn" href="#tickets">← Mes tickets</a>`}</div>
      ${err}<div class="sc-panel">${body}</div></div></div>`;
  }

  /** Rafraîchit un plan qui évolue tout seul (chat planifié, exécution) sans écraser une saisie ou une correction en cours. */
  function startPolling() {
    if (pl.timer) return;
    pl.timer = setInterval(() => {
      if (!isOpen()) { clearInterval(pl.timer); pl.timer = null; return; }
      if (pl.busy || pl.edit) return;
      if (pl.id) { if (!pl.detail || LIVE.includes(pl.detail.plan.status) || pl.detail.plan.busy) loadDetail(); }
      else loadList();
    }, POLL_MS);
  }

  /**
   * Ouvre la page : la liste des plans, ou un plan si `sub` est son numéro. Appelée par le routage sur `#tickets/plans[/<id>]`.
   * @param {string} [sub] Numéro du plan.
   * @returns {Promise<void>}
   */
  async function show(sub) {
    if (!state.stats) await refreshHeader();
    if (!pl.projects) pl.projects = await api("/api/projects").catch(() => []);
    const id = Number(sub);
    if (pl.id !== (id > 0 ? id : null)) { pl.edit = null; pl.msg = ""; pl.runAt = ""; pl.wait = null; pl.detail = null; pl.code = {}; pl.open = new Set(); }
    pl.id = id > 0 ? id : null;
    pl.err = "";
    paint();
    if (pl.id) await loadDetail(); else await loadList();
    startPolling();
  }

  document.addEventListener("input", (ev) => {
    if (!isOpen()) return;
    const t = ev.target, d = t.dataset || {};
    if (d.plTitle !== undefined) { pl.edit[Number(d.plTitle)].title = t.value; return; }
    if (d.plDesc !== undefined) { pl.edit[Number(d.plDesc)].description = t.value; return; }
    if (d.plAt !== undefined) { pl.edit[Number(d.plAt)].runAt = t.value; return; }
    const k = d.pl;
    if (!k) return;
    if (k === "msg") pl.msg = t.value;
    else if (k === "runAt") pl.runAt = t.value;
    else if (k === "wait") pl.wait = t.checked;
    else if (k === "source") { pl.form.source = t.value; pl.form.key = null; paint(); }
    else if (k === "key") pl.form.key = t.value;
    else pl.form[k] = t.value;
  });

  document.addEventListener("click", (ev) => {
    if (!isOpen()) return;
    const q = (attr) => ev.target.closest?.(`[${attr}]`);
    let el;
    if ((el = q("data-pl-kind"))) { pl.form.kind = el.dataset.plKind === "project" ? "project" : "feature"; paint(); return; }
    if ((el = q("data-pl-up"))) return moveEdit(Number(el.dataset.plUp), -1);
    if ((el = q("data-pl-down"))) return moveEdit(Number(el.dataset.plDown), 1);
    if ((el = q("data-pl-del"))) { pl.edit.splice(Number(el.dataset.plDel), 1); paint(); return; }
    if ((el = q("data-pl-pend-up"))) return void movePending(Number(el.dataset.plPendUp), -1);
    if ((el = q("data-pl-pend-down"))) return void movePending(Number(el.dataset.plPendDown), 1);
    if ((el = q("data-pl-code"))) return void loadCode(Number(el.dataset.plCode));
    if ((el = q("data-pl-skip"))) return void act(() => api(`/api/plans/${pl.id}/items/${Number(el.dataset.plSkip)}/skip`, {}));
    if ((el = q("data-pl-retry"))) return void act(() => api(`/api/plans/${pl.id}/items/${Number(el.dataset.plRetry)}/retry`, {}));
    el = q("data-pl-act");
    if (!el) return;
    switch (el.dataset.plAct) {
      case "create": void create(); break;
      case "send": void send(); break;
      case "retry-turn": pl.msg = ""; void send(); break;
      case "validate": void validate(); break;
      case "edit": startEdit(); break;
      case "add": pl.edit.push({ title: "", description: "", labels: [], runAt: "" }); paint(); break;
      case "save-edit": void saveEdit(); break;
      case "cancel-edit": pl.edit = null; paint(); break;
      case "chat-now": void act(() => api(`/api/plans/${pl.id}/schedule`, { chatAt: null })); break;
      case "pause": void act(() => api(`/api/plans/${pl.id}/pause`, {})); break;
      case "resume": void act(() => api(`/api/plans/${pl.id}/resume`, {})); break;
      case "wait-on": void act(() => api(`/api/plans/${pl.id}/wait-for-merge`, { enabled: true })); break;
      case "wait-off": void act(() => api(`/api/plans/${pl.id}/wait-for-merge`, { enabled: false })); break;
      case "cancel":
        void ask({ title: "Annuler ce plan ?", html: "<p>Les tickets qui n'ont pas démarré ne seront pas exécutés et l'agent en cours sera arrêté. Les tickets déjà créés chez la forge y restent.</p>", okLabel: "Annuler le plan" })
          .then((ok) => { if (ok) return act(() => api(`/api/plans/${pl.id}/cancel`, {})); });
        break;
      default: break;
    }
  });

  /* Retient les tickets dépliés (l'événement « toggle » ne remonte pas : écoute en capture) */
  document.addEventListener("toggle", (ev) => {
    const id = ev.target?.dataset?.plItem;
    if (id === undefined) return;
    if (ev.target.open) pl.open.add(Number(id)); else pl.open.delete(Number(id));
  }, true);

  window.Plans = { show };
})();
