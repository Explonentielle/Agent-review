/* Popups de la forge : les vrais réglages de l'outil (jetons, terminal Claude, projets, tickets, revues), ouverts depuis le monde. */
(() => {
  "use strict";
  const S = window.ForgeSprites, A = window.ForgeAudio;
  let game = null;
  let current = null; // { id, params, def, el, sel }
  let fixNote = ""; // la consigne en plus de « Corriger avec la relecture », gardée quand la fenêtre se redessine

  const xpFloor = (level) => 25 * level * (level - 1);
  const pct = (n) => `<div class="fg-pbar"><i style="width:${Math.max(0, Math.min(100, n))}%"></i></div>`;
  const gradeTag = (grade) => `<span class="fg-grade g-${grade}">${esc(S.GRADE[grade].name)}</span>`;
  const weaponImg = (type, grade, cls = "") => `<img class="fg-wicon ${cls}" src="${S.icon(type, grade)}" alt="">`;
  const fmtKind = (k) => (k === "github" ? "GitHub" : "GitLab");

  /**
   * Ligne « type d'arme » d'un projet : le type choisi (définitif), ou les sept types à choisir une seule fois (le type par défaut est coché).
   * @param w Arme (un projet) de l'armurerie.
   * @param type Type d'arme actuel du projet.
   * @returns Le HTML de la ligne.
   */
  function typeRow(w, type) {
    const name = S.TYPES.find((t) => t.id === type)?.name ?? "";
    if ((game.data.armory.chosen ?? []).includes(w.key)) return `<div class="fg-types"><span>Type d'arme (choisi, il ne change plus)</span><span class="fg-type on" title="${esc(name)}">${weaponImg(type, w.grade)}</span></div>`;
    const picks = S.TYPES.map((t) => `<button type="button" class="fg-type ${t.id === type ? "on" : ""}" data-fg-wtype="${t.id}" data-fg-wkey="${esc(w.key)}" title="${esc(t.name)}">${weaponImg(t.id, w.grade)}</button>`).join("");
    return `<div class="fg-types"><span>Type d'arme (à choisir une seule fois)</span>${picks}</div><p class="fg-note">Pour l'instant : ${esc(name)}, tiré de ton projet. Un clic le fixe pour de bon : il décide des armes qui tombent en butin.</p>`;
  }

  /**
   * Fixe le type d'arme d'un projet après confirmation, puis redessine le râtelier.
   * @param key Clé `source:projectId` du projet.
   * @param type Type d'arme choisi.
   * @returns Rien.
   */
  async function chooseWeapon(key, type) {
    const w = game.data.armory.weapons.find((x) => x.key === key);
    if (!w) return;
    const name = S.TYPES.find((t) => t.id === type)?.name ?? type;
    const ok = await ask({ title: `Fixer le type d'arme : ${name} ?`, okLabel: "Fixer", html: `<p>Le projet <b>${esc(w.path)}</b> aura pour arme : <b>${esc(name)}</b>. Une fois fixé, le type ne change plus.</p>` });
    if (!ok) return;
    try {
      await api("/api/forge/weapon-type", { source: w.source, projectId: w.projectId, weaponType: type });
      A.sfx.select();
      await game.refresh();
      render();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
  }

  /** Quêtes de départ, hauts faits et règles de l'XP : le tableau et la page du profil les affichent de la même façon. */
  function questsBody(source = game) {
    const h = source.data.hero;
    const quest = (q) => `<div class="fg-quest-row ${q.done ? "done" : q.id === h.nextQuest ? "next" : ""}"><span class="chk">${q.done ? "✓" : ""}</span><div><b>${esc(q.title)}</b><small>${esc(q.hint)}</small></div><span class="xp">+${q.xp} XP</span></div>`;
    return `<h4>Quêtes de départ (${h.quests.filter((q) => q.done).length}/${h.quests.length})</h4>${h.quests.map(quest).join("")}
      <h4>Hauts faits (${h.achievements.filter((a) => a.unlocked).length}/${h.achievements.length})</h4>
      <div class="fg-achv">${h.achievements.map((a) => `<div class="${a.unlocked ? "" : "locked"}"><b>${esc(a.title)}</b><small>${esc(a.description)}</small></div>`).join("")}</div>
      <details><summary>Comment gagner de l'XP ?</summary><ul>${h.rules.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>`;
  }

  /* ---------- L'Intendant : les plans de l'orchestrateur (la page complète est #tickets/plans, public/plans.js) ---------- */
  const PLAN_STATUS = {
    waiting_chat: ["Chat planifié", "warn"], chatting: ["Chat en cours", "warn"], review: ["À valider", "warn"], scheduled: ["Planifié", ""],
    running: ["En cours", "ok"], paused: ["En pause", "warn"], done: ["Terminé", "ok"], failed: ["En échec", "warn"], cancelled: ["Annulé", ""],
  };
  const ITEM_STATUS = {
    proposed: ["Proposé", "warn"], pending: ["À venir", ""], running: ["En cours", "ok"], done: ["Terminé", "ok"],
    failed: ["En échec", "warn"], skipped: ["Écarté", ""], cancelled: ["Annulé", ""],
  };
  /** Saisie en cours dans la fenêtre : gardée quand elle se redessine (rafraîchissement automatique). */
  const planDraft = { kind: "feature", key: "", idea: "", chatAt: "", msg: "" };
  const planTag = (map, status) => { const [label, cls] = map[status] || [status, ""]; return `<span class="fg-tag ${cls}">${esc(label)}</span>`; };
  const planWhen = (iso) => (iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "");
  /** Lien vers la forge : seulement http(s), le reste n'est pas rendu cliquable. */
  const planLink = (url, text) => (/^https?:\/\//i.test(String(url || "")) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text));

  /** Liste des plans de la personne et formulaire d'un nouveau chat de cadrage. */
  async function planList() {
    const plans = await api("/api/plans");
    const projects = game.data.armory.weapons.filter((w) => w.devEnabled);
    const chosen = projects.find((w) => w.key === planDraft.key) ?? projects[0];
    const rows = plans.map((p) => {
      const c = p.counts;
      return `<button type="button" class="fg-ticket link" data-fg-sel="${p.id}"><div><b>${esc(p.title)}</b><small>${esc(p.projectPath)}${c.total ? ` · ${c.done}/${c.total} terminé${c.done > 1 ? "s" : ""}${c.failed ? `, ${c.failed} en échec` : ""}` : ""}</small></div>${planTag(PLAN_STATUS, p.status)}</button>`;
    }).join("");
    const form = projects.length
      ? `<h4>Nouveau plan</h4>
        <label class="fg-field-in">Ce que tu veux cadrer<select data-fg-pd="kind"><option value="feature" ${planDraft.kind === "feature" ? "selected" : ""}>Une fonctionnalité</option><option value="project" ${planDraft.kind === "project" ? "selected" : ""}>Un projet complet</option></select></label>
        <label class="fg-field-in">Projet<select data-fg-pd="key">${projects.map((w) => `<option value="${esc(w.key)}" ${w === chosen ? "selected" : ""}>${esc(w.path)}</option>`).join("")}</select></label>
        <label class="fg-field-in">Ce que tu voudrais<textarea data-fg-pd="idea" rows="3" maxlength="4000" placeholder="Ex. exporter les rapports du mois en Excel">${esc(planDraft.idea)}</textarea></label>
        <label class="fg-field-in">Lancer le chat à partir de (facultatif, sinon tout de suite)<input type="datetime-local" data-fg-pd="chatAt" value="${esc(planDraft.chatAt)}"></label>
        <div class="fg-inline"><button type="button" class="fg-btn" data-fg-plan-new>${planDraft.chatAt ? "Planifier le chat" : "Démarrer le chat"}</button></div>`
      : `<p class="fg-note">Aucun projet n'est autorisé pour l'agent dev : règle-le au râtelier, l'intendant ne planifie que sur ces projets.</p>`;
    return {
      title: "L'Intendant : les plans",
      html: `<p class="fg-note">L'intendant te pose des questions, propose une liste de tickets que tu relis, puis l'apprenti les forge l'un après l'autre. Rien n'est créé chez la forge ni lancé sans ta validation.</p>
        <h4>Mes plans (${plans.length})</h4>${rows || `<p class="fg-note">Aucun plan pour l'instant.</p>`}${form}
        <div class="fg-inline"><button type="button" class="fg-btn ghost" data-fg-go="#tickets/plans">Ouvrir la page Plans</button></div>`,
    };
  }

  /** Un plan : avancement ticket par ticket, chat de cadrage, pause, reprise et annulation. La relecture détaillée et la validation se font sur la page Plans. */
  async function planDetail(id) {
    const d = await api(`/api/plans/${id}`);
    const p = d.plan, s = p.status;
    const started = d.items.some((i) => i.status !== "proposed");
    const done = d.items.filter((i) => i.status === "done").length;
    const count = (...st) => d.items.filter((i) => st.includes(i.status)).length;
    const progress = d.items.length
      ? `${pct((done * 100) / d.items.length)}<p class="fg-note">À venir : <b>${count("proposed", "pending")}</b> · En cours : <b>${count("running")}</b> · Terminés : <b>${done}</b> · En échec : <b>${count("failed")}</b>${count("skipped", "cancelled") ? ` · Écartés : <b>${count("skipped", "cancelled")}</b>` : ""}</p>`
      : "";
    const alert = p.error ? `<div class="fg-err">${s === "failed" ? "Le plan s'est arrêté : " : ""}${esc(p.error)}</div>` : "";
    const pendingOrFailed = (t) => t.status === "pending" || t.status === "failed";
    const items = d.items.map((t) => {
      const ref = t.issueIid ? ` · ${planLink(t.issueUrl, `#${t.issueIid}`)}` : "";
      const mr = t.task?.mrUrl ? ` · ${planLink(t.task.mrUrl, "MR")}` : "";
      const at = t.runAt ? ` · pas avant le ${esc(planWhen(t.runAt))}` : "";
      const actions = [
        t.task ? `<button type="button" class="fg-btn ghost" data-fg-go="#dev/${esc(t.task.id)}">Tâche</button>` : "",
        t.status === "failed" ? `<button type="button" class="fg-btn" data-fg-plan-item="retry:${t.id}">Relancer</button>` : "",
        pendingOrFailed(t) ? `<button type="button" class="fg-btn ghost" data-fg-plan-item="skip:${t.id}">Écarter</button>` : "",
      ].join("");
      return `<div class="fg-ticket"><div><b>${t.position}. ${esc(t.title)}</b><small>${planTag(ITEM_STATUS, t.status)}${ref}${mr}${at}</small>${t.error ? `<small class="fg-fail">${esc(t.error)}</small>` : ""}</div><div class="fg-inline">${actions}</div></div>`;
    }).join("");
    const buttons = [];
    if (s === "scheduled" || s === "running") buttons.push(`<button type="button" class="fg-btn" data-fg-plan-act="pause">Mettre en pause</button>`);
    if (s === "paused" || (s === "failed" && !d.items.some((i) => i.status === "failed"))) buttons.push(`<button type="button" class="fg-btn" data-fg-plan-act="resume">Reprendre</button>`);
    if (!["done", "cancelled"].includes(s)) buttons.push(`<button type="button" class="fg-btn ghost" data-fg-plan-act="cancel">Annuler le plan</button>`);
    const review = s === "review" && !p.busy
      ? `<div class="fg-questions"><b>Rien n'est créé tant que tu n'as pas validé.</b> Relis et corrige la liste sur la page Plans : c'est là que tu valides, et que tu choisis l'heure de lancement.<div class="fg-inline"><button type="button" class="fg-btn" data-fg-go="#tickets/plans/${p.id}">Relire et valider</button></div></div>`
      : "";
    const schedule = s === "scheduled" && p.runAt ? `<p class="fg-note">Exécution planifiée le <b>${esc(planWhen(p.runAt))}</b>.</p>` : "";
    const log = d.messages.map((m) => `<div class="fg-ft-prev"><b>${m.role === "user" ? "Toi" : "Intendant"}</b><div class="fg-md">${esc(m.text).replace(/\n/g, "<br>")}</div></div>`).join("");
    const waiting = s === "waiting_chat" ? `<p class="fg-note">Le chat démarrera le <b>${esc(planWhen(p.chatAt))}</b> (à quelques secondes près).</p><div class="fg-inline"><button type="button" class="fg-btn" data-fg-plan-act="chat-now">Le lancer maintenant</button></div>` : "";
    const busy = p.busy ? `<p class="fg-note fg-wait">L'intendant réfléchit… (une dizaine de secondes)</p>` : "";
    const reply = (s === "chatting" || s === "review") && !started && !p.busy
      ? `<label class="fg-field-in">Ta réponse<textarea data-fg-pd="msg" rows="3" maxlength="4000" placeholder="Réponds aux questions, ou demande un changement du plan">${esc(planDraft.msg)}</textarea></label>
        <div class="fg-inline"><button type="button" class="fg-btn" data-fg-plan-act="send">Envoyer</button>${d.messages.at(-1)?.role === "user" ? `<button type="button" class="fg-btn ghost" data-fg-plan-act="retry-turn">Relancer la réponse</button>` : ""}</div>`
      : "";
    return {
      title: "L'Intendant : un plan",
      html: `<div class="fg-inline"><button type="button" class="fg-btn ghost" data-fg-sel="">← Tous les plans</button><button type="button" class="fg-btn ghost" data-fg-go="#tickets/plans/${p.id}">Ouvrir sur la page Plans</button></div>
        <h4>${esc(p.title)}</h4><p class="fg-note">${planTag(PLAN_STATUS, s)} ${esc(p.kind === "project" ? "Projet complet" : "Fonctionnalité")} · ${esc(p.projectPath)}</p>
        ${progress}${alert}${review}${schedule}${buttons.length ? `<div class="fg-inline">${buttons.join("")}</div>` : ""}
        <h4>Tickets du plan (${d.items.length})</h4>${items || `<p class="fg-note">Pas encore de ticket : continue l'échange, l'intendant proposera le plan quand le besoin sera clair.</p>`}
        <h4>Chat de cadrage</h4>${log}${waiting}${busy}${reply}`,
    };
  }

  /** Ouvre un chat de cadrage (tout de suite ou à la date choisie) avec la saisie de la fenêtre, puis affiche le plan. */
  async function planNew(btn) {
    const w = game.data.armory.weapons.find((x) => x.devEnabled && x.key === planDraft.key) ?? game.data.armory.weapons.find((x) => x.devEnabled);
    if (!w) { game.banner("Aucun projet n'est autorisé pour l'agent dev."); return A.sfx.error(); }
    if (!planDraft.idea.trim()) { game.banner("Décris d'abord ce que tu voudrais."); return A.sfx.error(); }
    btn.disabled = true;
    game.banner(planDraft.chatAt ? "Le chat est planifié." : "L'intendant réfléchit à tes premières questions…");
    try {
      const out = await api("/api/plans", { kind: planDraft.kind === "project" ? "project" : "feature", source: w.source, projectId: w.projectId, idea: planDraft.idea, chatAt: planDraft.chatAt ? new Date(planDraft.chatAt).toISOString() : null });
      planDraft.idea = ""; planDraft.chatAt = "";
      if (out.error) game.banner(out.error);
      A.sfx.select();
      if (current?.id === "plans") current.sel = String(out.id);
    } catch (err) { game.banner(err.message); A.sfx.error(); }
    render();
  }

  /** Action sur le plan ouvert : message du chat, pause, reprise ou annulation (après confirmation). */
  async function planAct(act, btn) {
    const id = Number(current?.sel);
    if (!id) return;
    const base = `/api/plans/${id}`;
    try {
      if (act === "cancel") {
        const ok = await ask({ title: "Annuler ce plan ?", okLabel: "Annuler le plan", html: "<p>Les tickets qui n'ont pas démarré ne seront pas exécutés et l'agent en cours sera arrêté. Les tickets déjà créés chez la forge y restent.</p>" });
        if (!ok) return;
      }
      btn.disabled = true;
      if (act === "send" || act === "retry-turn") {
        const text = act === "send" ? planDraft.msg.trim() : "";
        if (act === "send" && !text) { btn.disabled = false; game.banner("Écris un message."); return A.sfx.error(); }
        game.banner("L'intendant réfléchit…");
        const out = await api(`${base}/messages`, { text });
        planDraft.msg = "";
        if (out.error) game.banner(out.error);
      } else if (act === "chat-now") await api(`${base}/schedule`, { chatAt: null });
      else if (["pause", "resume", "cancel"].includes(act)) await api(`${base}/${act}`, {});
      else return;
      A.sfx.select();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
    render();
  }

  /** Relance ou écarte un ticket du plan ouvert. */
  async function planItem(spec, btn) {
    const id = Number(current?.sel);
    const [act, itemId] = spec.split(":");
    if (!id || !["retry", "skip"].includes(act) || !Number(itemId)) return;
    btn.disabled = true;
    try {
      await api(`/api/plans/${id}/items/${Number(itemId)}/${act}`, {});
      A.sfx.select();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
    render();
  }

  /* ---------- contenus ---------- */
  const defs = {
    /** Un four = une forge connectée : adresse et jeton, les vrais réglages de connexion. */
    forge: {
      rerender: true,
      async render({ kind }) {
        const { secrets } = await api("/api/secrets");
        state.secrets = secrets;
        const names = kind === "github" ? ["github.token"] : ["gitlab.url", "gitlab.token"];
        const rows = names.map((n) => secrets.find((s) => s.name === n)).filter(Boolean);
        const isLit = game.data.forges.includes(kind);
        const user = state.stats?.forges?.find((f) => f.kind === kind)?.username;
        const origin = (x) => (x.source === "env" ? `<span class="fg-tag">défini dans le .env</span>` : x.source === "vault" ? `<span class="fg-tag ok">enregistré, chiffré</span>` : `<span class="fg-tag warn">à renseigner</span>`);
        const field = (x) => {
          const input = x.secret === false
            ? `<input type="text" autocomplete="off" spellcheck="false" placeholder="https://gitlab.exemple.com" value="${esc(x.value || "")}" data-secret-input="${esc(x.name)}">`
            : `<input type="password" autocomplete="new-password" placeholder="${x.source === "vault" ? "Nouvelle valeur (remplace l'actuelle)" : "Coller le jeton"}" data-secret-input="${esc(x.name)}">`;
          const actions = x.source === "env"
            ? (x.secret === false && x.value ? `<code>${esc(x.value)}</code>` : "")
            : `<div class="fg-inline">${input}<button type="button" class="fg-btn" data-act="secret-save" data-name="${esc(x.name)}">Enregistrer</button>${x.source === "vault" ? `<button type="button" class="fg-btn ghost" data-act="secret-delete" data-name="${esc(x.name)}">Éteindre</button>` : ""}</div>`;
          return `<div class="fg-field"><b>${esc(x.label)}</b> ${origin(x)}${actions}</div>`;
        };
        const help = kind === "github"
          ? "Un jeton à portée fine, créé pour le compte ou l'organisation qui possède les dépôts : Contents, Pull requests et Issues en lecture et écriture, Checks et Commit statuses en lecture."
          : "L'adresse de ton instance GitLab, puis le jeton d'un compte qui a accès aux projets concernés (scopes api, read_repository, write_repository).";
        return {
          title: `Forge ${fmtKind(kind)}`,
          html: `<p class="fg-status">${isLit ? `<span class="fg-tag ok">Forge allumée</span>${user ? ` compte <b>@${esc(user)}</b>` : ""}` : `<span class="fg-tag warn">Forge éteinte</span> le four chauffe dès qu'un jeton valide est enregistré`}</p>
            ${rows.map(field).join("")}<p class="fg-note">${esc(help)}</p>${window.Scribe.rightsHtml(kind, false, "fg-rights")}
            <p class="fg-note">Les jetons sont chiffrés dans la base de l'outil, jamais renvoyés au navigateur. Rien n'est révoqué chez ${fmtKind(kind)} quand tu éteins le four : fais-le là-bas si un jeton a fuité.</p>`,
        };
      },
    },

    /** La Pierre d'éveil : connecter l'abonnement Claude avec le terminal. */
    stone: {
      wide: true,
      async render() {
        return {
          title: "Pierre d'éveil",
          html: `<p class="fg-note">Tes apprentis travaillent avec la CLI Claude Code de cette machine. Pose la main sur la pierre pour y connecter ton abonnement.</p>${claudeBlock()}`,
          after: () => refreshClaudeStatus(false),
          before: () => disposeTermView(),
        };
      },
    },

    /** Le râtelier : un projet = une arme. Niveau et qualité viennent du travail réel ; le type d'arme se choisit une seule fois, ici. */
    rack: {
      rerender: true,
      live: true,
      wide: true,
      async render(params, sel) {
        projectsData = await api("/api/projects");
        state.runtime ??= await api("/api/agent-runtime").catch(() => null);
        const weapons = game.data.armory.weapons;
        const chosen = weapons.find((w) => w.key === (sel ?? params.select)) ?? weapons[0];
        current.sel = chosen?.key;
        let ticketsHtml = "";
        if (chosen) {
          try { ticketsHtml = ticketsSection(chosen, await projectTickets(chosen)); } catch (err) { ticketsHtml = ticketsSection(chosen, null, err.message); }
        }
        const card = (w) => `<button type="button" class="fg-wcard ${w === chosen ? "sel" : ""}" data-fg-sel="${esc(w.key)}" title="${esc(w.path)}">${weaponImg(game.weaponType(w), w.grade)}<span><b>${esc(w.path)}</b>${gradeTag(w.grade)} <small>Niv. ${w.level}</small></span></button>`;
        const detail = chosen ? (() => {
          const type = game.weaponType(chosen), lo = xpFloor(chosen.level), hi = xpFloor(chosen.level + 1);
          return `<div class="fg-wdetail"><div class="fg-wbig">${weaponImg(type, chosen.grade, "big")}</div><div>
            <h4>${esc(chosen.path)}</h4><div>${gradeTag(chosen.grade)} · Niveau ${chosen.level} · ${chosen.xp} XP</div>${pct(((chosen.xp - lo) * 100) / (hi - lo))}
            <div class="fg-stats"><span><b>${chosen.forged}</b> pièce${chosen.forged > 1 ? "s" : ""} forgée${chosen.forged > 1 ? "s" : ""}</span><span><b>${chosen.reviews}</b> revue${chosen.reviews > 1 ? "s" : ""}</span><span><b>${chosen.failures}</b> échec${chosen.failures > 1 ? "s" : ""}</span><span><b>${chosen.blocked}</b> question${chosen.blocked > 1 ? "s" : ""}</span></div>
            <p class="fg-note">${chosen.devEnabled ? "L'agent dev est autorisé sur ce projet." : "L'agent dev n'est pas encore autorisé sur ce projet : règle-le pour qu'on puisse y forger."}</p></div></div>
            ${typeRow(chosen, type)}
            <div class="fg-inline"><button type="button" class="fg-btn" data-fg-edit="${esc(chosen.key)}">Régler le projet</button></div>`;
        })() : `<p class="fg-note">Aucune arme pour l'instant. Chaque projet que tu ajoutes devient une arme à forger.</p>`;
        return {
          title: "Le râtelier : tes projets",
          html: `<div class="fg-weapons">${weapons.map(card).join("")}</div>${detail}${ticketsHtml}
            <div class="fg-inline"><button type="button" class="fg-btn ${chosen ? "ghost" : ""}" data-fg-new>Forger une nouvelle arme (ajouter un projet)</button><button type="button" class="fg-btn ghost" data-fg-scribe="">Le Scribe : nouveau ticket ou projet</button></div>
            <div id="project-editor"></div>`,
          after: () => {
            const pre = params.prefill;
            if (pre) { params.prefill = null; openProjectEditor(null, pre.path, pre.source); }
          },
        };
      },
    },

    /** L'Intendant : l'orchestrateur. Ses plans, le chat de cadrage et l'avancement ticket par ticket. `sel` : numéro du plan ouvert. */
    plans: {
      wide: true,
      live: true,
      async render(params, sel) {
        const id = Number(sel ?? params.select) || 0;
        return id > 0 ? planDetail(id) : planList();
      },
    },

    /** L'Apprenti : l'agent dev. Ses tickets, et le bouton qui le lance. */
    tickets: {
      async render() {
        state.issues = await api("/api/issues");
        const list = state.issues.filter((i) => i.devReady || !i.task);
        const card = (i) => {
          const active = i.task && (i.task.status === "running" || i.task.status === "queued");
          const forged = i.task && i.task.mrUrl && (i.task.status === "mr_created" || i.task.status === "mr_updated");
          const ps = forged ? pieceStatus(i.task.piece) : null;
          const merged = ps && i.task.piece.state === "merged";
          const mrOpen = ps && ps.act !== "none";
          // Statut réel de la pièce : une pièce fusionnée n'a plus rien à lancer, une MR ouverte se reprend au lieu de se relancer
          const action = active ? `<span class="fg-tag ok">L'apprenti y travaille</span>`
            : merged ? ""
              : mrOpen && i.devReady ? `<button type="button" class="fg-btn ghost" data-fg-go="#dev/${i.task.id}" title="Ajouter un commit sur la MR existante, avec tes consignes">Reprendre la MR</button>`
                : i.devReady ? `<button type="button" class="fg-btn" data-fg-launch="${esc(`${i.source}:${i.projectId}:${i.iid}`)}">${i.task ? "Relancer" : "Forger"}</button>`
                  : `<button type="button" class="fg-btn ghost" data-fg-open="rack">Régler le projet</button>`;
          const status = ps ? `<small><span class="fg-tag ${ps.cls}">${esc(ps.label)}</span></small>` : "";
          const mr = i.task && i.task.mrUrl ? ` · <a href="${esc(i.task.mrUrl)}" target="_blank" rel="noopener noreferrer">ouvrir la MR</a>` : "";
          const why = i.task && i.task.status === "error" && i.task.error ? `<small class="fg-fail">Échec : ${esc(i.task.error)}</small>` : "";
          const piece = forged ? pieceButtons(i.task.id, ps) : "";
          const drop = i.task && !active ? `<button type="button" class="fg-btn ghost" data-fg-deltask="${i.task.id}" title="Supprime cet essai de l'outil (la branche ou la MR éventuelles restent chez la forge)">Supprimer l'essai</button>` : "";
          return `<div class="fg-ticket"><div><b>#${i.iid} ${esc(i.title)}</b><small>${esc(i.projectPath)}${i.labels.length ? ` · ${esc(i.labels.slice(0, 3).join(", "))}` : ""}${mr}</small>${status}${why}</div><div class="fg-inline">${piece}${action}${drop}</div></div>`;
        };
        return {
          title: "L'Apprenti : tes tickets",
          html: list.length
            ? `<p class="fg-note">Les tickets qui te sont assignés. Un clic sur « Forger » : l'apprenti lit le ticket, code sur une branche, puis l'outil ouvre une demande de fusion Draft.</p>${list.slice(0, 14).map(card).join("")}`
            : `<p class="fg-note">Aucun ticket ne t'est assigné pour l'instant, ou ta forge n'est pas encore allumée.</p>`,
        };
      },
    },

    /** Le Maître juré : les pièces forgées par les agents (à relire, puis fusionner) et les revues de demandes de fusion. */
    reviews: {
      wide: true,
      live: true,
      async render() {
        const [rows, pieces] = await Promise.all([api("/api/reviews"), api("/api/pieces").catch(() => [])]);
        const label = { needs_human: ["À analyser", "warn"], auto_ok: ["Rien de grave", "ok"], published: ["Publiée", "ok"], approved: ["Approuvée", "ok"], running: ["En cours", ""], queued: ["En attente", ""], detected: ["Détectée", ""], dismissed: ["Ignorée", ""], error: ["Échec", "warn"] };
        const order = ["needs_human", "running", "queued", "detected", "auto_ok", "published", "approved", "error", "dismissed"];
        const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
        const pieceRow = (p) => {
          const ps = pieceStatus({ state: p.mr ? p.mr.state : "unknown", draft: p.mr ? p.mr.draft : false, review: p.review });
          const target = p.mr ? p.mr.targetBranch : "";
          // La fusion est proposée ici dès que la relecture est OK et que les règles la permettent (CI comprise)
          const ready = p.readiness && p.readiness.ok;
          const buttons = ready
            ? `<button type="button" class="fg-btn" data-fg-piece-merge="${p.taskId}" data-target="${esc(target)}">Fusionner dans ${esc(target)}</button><button type="button" class="fg-btn ghost" data-fg-piece="${p.taskId}">La pièce</button>`
            : pieceButtons(p.taskId, ps);
          const blocked = ps.act === "fusionner" && p.readiness && !p.readiness.ok ? `<small class="fg-fail">${esc(p.readiness.reasons[0] ?? "")}</small>` : "";
          return `<div class="fg-ticket"><div><b>#${p.issueIid} ${esc(p.issueTitle)}</b><small>${esc(p.projectPath)} · ${p.mr && p.mr.draft ? "MR en brouillon" : "MR ouverte"} · <a href="${esc(p.mrUrl)}" target="_blank" rel="noopener noreferrer">ouvrir la MR</a></small><small><span class="fg-tag ${ps.cls}">${esc(ps.label)}</span></small>${blocked}</div>
            <div class="fg-inline">${buttons}</div></div>`;
        };
        const piecesHtml = pieces.length
          ? `<h4>Pièces forgées par tes apprentis (${pieces.length})</h4><p class="fg-note">Les demandes de fusion que tes agents ont ouvertes. Fais-les relire par le Maître juré, puis fusionne-les dans la branche du projet.</p>${pieces.map(pieceRow).join("")}`
          : `<h4>Pièces forgées par tes apprentis</h4><p class="fg-note">Aucune pièce n'attend. Quand un apprenti ouvre une demande de fusion, elle apparaît ici.</p>`;
        const revuesHtml = sorted.length
          ? `<h4>Revues des demandes de fusion</h4><p class="fg-note">Les demandes de fusion que tes agents ont contrôlées. Clique pour lire la revue dans le tableau de bord.</p>${sorted.slice(0, 14).map((r) => { const [t, c] = label[r.status] ?? [r.status, ""]; return `<button type="button" class="fg-ticket link" data-fg-review="${r.id}"><div><b>${esc(r.mr_title)}</b><small>${esc(r.project_path)} · ${esc(r.author)}</small></div><span class="fg-tag ${c}">${esc(t)}</span></button>`; }).join("")}`
          : `<h4>Revues des demandes de fusion</h4><p class="fg-note">Aucune revue pour l'instant. Elles arrivent quand une demande de fusion te désigne comme relecteur.</p>`;
        return { title: "Le Maître juré", html: piecesHtml + revuesHtml };
      },
    },

    /** Le tableau : missions du jour et de la semaine, série, maîtrises à paliers, prestige, quêtes de départ. La fenêtre garde l'onglet dans `sel`. */
    board: {
      live: true,
      async render(_params, sel) {
        const h = game.data.hero, pg = h.progress, pr = h.prestige;
        const tab = ["today", "mastery", "prestige", "quests"].includes(sel) ? sel : "today";
        const pending = game.claimable().length;
        const tabs = [["today", "Aujourd'hui", pending], ["mastery", "Maîtrises", 0], ["prestige", "Prestige", 0], ["quests", "Quêtes", 0]]
          .map(([id, label, n]) => `<button type="button" class="fg-tab ${id === tab ? "on" : ""}" data-fg-sel="${id}">${label}${n ? ` <i>${n}</i>` : ""}</button>`).join("");
        const rankBadge = `<span class="fg-rank" ${pr.rank.aura ? `style="--aura:${pr.rank.aura}"` : ""}>${esc(pr.rank.name)}${pr.stars ? " " + "★".repeat(Math.min(pr.stars, 5)) : ""}</span>`;
        const header = `<div class="fg-hero"><b>${esc(game.save.name || "Forgeron")}</b> ${rankBadge} · ${esc(h.heroClass)} ${esc(h.specialty.toLowerCase())}<div>Niveau ${h.level} · ${esc(h.title)} · ${h.xp} XP</div>${pct(h.percent)}
          <div class="fg-stats">${h.stats.map((s) => `<span><b>${s.value}</b> ${esc(s.label.toLowerCase())}</span>`).join("")}</div></div><div class="fg-tabs">${tabs}</div>`;

        const mission = (m) => {
          const key = game.claimKey(m), claimed = game.save.claimed[key];
          const right = claimed ? `<span class="fg-tag ok">Réclamé</span>` : m.done ? `<button type="button" class="fg-btn" data-fg-claim="${esc(key)}">Réclamer ${m.gold} or</button>` : `<span class="fg-reward">${m.gold} or</span>`;
          return `<div class="fg-mission ${m.done ? "done" : ""}"><div><b>${esc(m.title)}</b><small>${esc(m.hint)}</small>${pct((m.progress * 100) / m.target)}<small>${m.progress} / ${m.target}</small></div>${right}</div>`;
        };

        let body;
        if (tab === "today") {
          const s = pg.streak, nextStreak = pg.masteries.find((m) => m.id === "streak")?.next;
          const state = s.atRisk ? "Elle s'éteint à minuit : une pièce forgée ou une review suffit." : s.activeToday ? "Bien joué : elle est entretenue pour aujourd'hui." : "Fais forger une pièce ou contrôler une lame pour la lancer.";
          body = `<div class="fg-streakcard ${s.atRisk ? "risk" : ""}"><b>Série : ${s.current} jour${s.current > 1 ? "s" : ""}</b><small>Record : ${s.best} · ${state}${nextStreak ? ` Prochain palier : ${nextStreak.at} jours (+${nextStreak.xp} XP).` : ""}</small></div>
            <h4>Missions du jour</h4>${pg.daily.map(mission).join("")}${mission(pg.chest)}
            <h4>Missions de la semaine</h4>${pg.weekly.map(mission).join("")}
            ${pending > 1 ? `<div class="fg-inline"><button type="button" class="fg-btn" data-fg-claimall>Tout réclamer : ${game.claimable().reduce((n, m) => n + m.gold, 0)} or</button></div>` : ""}
            <p class="fg-note">De nouvelles missions arrivent chaque jour à minuit, et celles de la semaine le lundi. L'or sert chez le marchand.</p>`;
        } else if (tab === "mastery") {
          body = `<p class="fg-note">Chaque palier franchi te rapporte de l'XP, une seule fois. Elles montent avec ton travail réel : tickets forgés, reviews, jours de suite, raretés.</p>` + pg.masteries.map((m) => {
            const dots = m.tiers.map((t) => `<i class="${t.done ? "on" : ""}" title="${t.at} : +${t.xp} XP"></i>`).join("");
            const tail = m.next ? `${m.value} / ${m.next.at} · prochain palier : +${m.next.xp} XP` : "Tous les paliers sont franchis.";
            return `<div class="fg-mastery"><div class="head"><b>${esc(m.title)}</b><span class="dots">${dots}</span></div><small>${esc(m.unit)}</small>${pct(m.next ? (m.value * 100) / m.next.at : 100)}<small>${tail}</small></div>`;
          }).join("");
        } else if (tab === "prestige") {
          const perks = (r) => [`+${r.goldBonusPct} % d'or aux ventes`, r.aura ? "halo autour de ton forgeron" : null, ...game.cosmetics.filter((c) => c.rank === r.id).map((c) => `tenue : ${c.name}`)].filter(Boolean).join(" · ");
          const next = pr.next;
          body = `<div class="fg-rankcard" ${pr.rank.aura ? `style="--aura:${pr.rank.aura}"` : ""}><b>Rang ${esc(pr.rank.name)}${pr.stars ? " " + "★".repeat(Math.min(pr.stars, 5)) : ""}</b><small>${esc(perks(pr.rank))}</small></div>
            ${next ? `<p class="fg-note">Prochain : <b>${esc(next.name)}</b> au niveau ${next.level}. Encore ${next.levelsLeft} niveau${next.levelsLeft > 1 ? "x" : ""}, soit ${next.xpLeft} XP.</p>` : ""}
            <h4>Les rangs</h4>${pr.ranks.map((r) => `<div class="fg-rankrow ${r.reached ? "done" : ""}"><span class="sw" style="background:${r.aura || "#6b6f7b"}"></span><div><b>${esc(r.name)}</b> · niveau ${r.from}<small>${esc(perks(r))}</small></div><span class="chk">${r.reached ? "✓" : ""}</span></div>`).join("")}
            <p class="fg-note">Au-delà du dernier rang, une étoile ★ tous les 10 niveaux. Les tenues de prestige sont offertes chez le marchand.</p>`;
        } else body = questsBody();
        return { title: "Tableau des quêtes", html: header + body };
      },
    },

    /** Le marchand : le stock du jour (armes uniques et tenues tirées au hasard), le rachat des objets du sac, des pièces forgées, et des tenues fixes. */
    merchant: {
      live: true,
      async render() {
        const items = game.data.armory.loot.filter((i) => !game.save.sold.includes(i.id));
        const bonus = 1 + game.goldBonus() / 100, price = (i) => Math.round(i.value * bonus);

        const weapons = new Map(game.data.armory.weapons.map((w) => [w.key, w]));
        const row = (i) => {
          const w = weapons.get(i.weaponKey);
          const type = w ? game.weaponType(w) : "sword";
          return `<div class="fg-item">${weaponImg(type, i.grade)}<div><b>${esc(i.title)}</b> ${gradeTag(i.grade)}<small>${esc(w?.path ?? i.weaponKey)} · #${i.iid} · note ${i.score}</small></div><button type="button" class="fg-btn" data-fg-sell="${esc(i.id)}">Vendre ${price(i)} or</button></div>`;
        };
        const commons = items.filter((i) => i.grade === "common");
        const gold = game.save.gold;
        const cos = game.cosmetics.map((c) => {
          const owned = game.items.owns(c.id), worn = game.items.isEquipped(c.id);
          const rankName = c.rank ? game.data.hero.prestige.ranks.find((x) => x.id === c.rank)?.name : "";
          const locked = c.rank && game.rankOrder.indexOf(c.rank) > game.rankIndex();
          const buy = c.rank ? `<button type="button" class="fg-btn" data-fg-buy="${c.id}" ${locked ? "disabled" : ""}>${locked ? `Rang ${esc(rankName)} requis` : "Prendre (offert)"}</button>` : `<button type="button" class="fg-btn" data-fg-buy="${c.id}" ${gold < c.price ? "disabled" : ""}>Acheter ${c.price} or</button>`;
          const btn = owned ? `<button type="button" class="fg-btn ghost" data-fg-wear="${c.id}">${worn ? "Retirer" : "Équiper"}</button>` : buy;
          return `<div class="fg-item no-icon"><div><b>${esc(c.name)}</b> ${gradeTag(c.rarity)}<small>${c.rank ? `Tenue de prestige, rang ${esc(rankName)}` : "Une tenue pour ton forgeron"}</small></div>${btn}</div>`;
        }).join("");

        // Stock du jour : armes uniques (valeurs tirées) et tenues, renouvelé chaque jour à minuit
        const midnight = new Date(); midnight.setHours(24, 0, 0, 0);
        const hours = Math.max(1, Math.ceil((midnight - Date.now()) / 3600000));
        const offerRow = (o) => `<div class="fg-item"><img class="fg-ithumb" src="${game.items.thumb(o.item)}" alt=""><div><b>${esc(o.item.name)}</b> ${gradeTag(o.item.rarity)}${game.items.detailHtml(o.item)}</div>${o.bought ? `<button type="button" class="fg-btn ghost" disabled>Acheté</button>` : `<button type="button" class="fg-btn" data-fg-offer="${esc(o.offerId)}" ${gold < o.price ? "disabled" : ""}>Acheter ${o.price} or</button>`}</div>`;
        const stock = game.items.shopOffers();
        // Rachat des objets du sac : ceux qu'on ne porte pas ; un objet vendu quitte le sac
        const sellable = game.items.sellable();
        const sellRow = ({ item, copies, price: p }) => `<div class="fg-item"><img class="fg-ithumb" src="${game.items.thumb(item)}" alt=""><div><b>${esc(item.name)}</b>${copies > 1 ? ` <em>×${copies}</em>` : ""} ${gradeTag(item.rarity)}${game.items.detailHtml(item)}</div><button type="button" class="fg-btn" data-fg-sellitem="${esc(item.id)}">Vendre ${Math.round(p * bonus)} or</button></div>`;
        const sellCommons = sellable.filter((x) => x.item.rarity === "common");
        return {
          title: "Marchand Sélim",
          html: `<p class="fg-note">« Je rachète tout, et ma marchandise change chaque jour. » Ton or : <b>${gold}</b>.${game.goldBonus() ? ` Ton rang te vaut <b>+${game.goldBonus()} %</b> sur chaque vente.` : ""}</p>
            <h4>Stock du jour <small class="fg-note">nouveau stock dans environ ${hours} h</small></h4>
            ${stock.length ? stock.map(offerRow).join("") : `<p class="fg-note">Rien en rayon aujourd'hui.</p>`}
            <h4>Vendre mes objets</h4>
            <p class="fg-note">Le marchand rachète à 40 % de sa valeur. Un objet vendu quitte ton sac pour de bon ; un objet porté ne se vend pas.</p>
            ${sellable.length ? sellable.slice(0, 12).map(sellRow).join("") + (sellable.length > 12 ? `<p class="fg-note">… et ${sellable.length - 12} autre${sellable.length - 12 > 1 ? "s" : ""} dans ton sac.</p>` : "") : `<p class="fg-note">Rien à vendre : tout est porté, ou ton sac est vide.</p>`}
            ${sellCommons.length > 1 ? `<div class="fg-inline"><button type="button" class="fg-btn ghost" data-fg-sellall-common>Tout vendre : ${sellCommons.length} objets communs (${sellCommons.reduce((t, x) => t + Math.round(x.price * x.copies * bonus), 0)} or)</button></div>` : ""}
            <h4>Pièces forgées</h4>
            <p class="fg-note">Les demandes de fusion que tes apprentis ont ouvertes se vendent aussi. Vendre une pièce ne supprime rien sur ta forge : c'est du jeu.</p>
            ${items.length ? items.slice(0, 12).map(row).join("") : `<p class="fg-note">Aucune pièce à vendre. Chaque demande de fusion ouverte par l'agent en devient une.</p>`}
            ${commons.length > 1 ? `<div class="fg-inline"><button type="button" class="fg-btn ghost" data-fg-sellcommons>Tout vendre : ${commons.length} pièces communes (${commons.reduce((t, i) => t + price(i), 0)} or)</button></div>` : ""}
            <h4>Tenues</h4>${cos}`,
        };
      },
    },

    /** La pièce : la MR de l'agent. Relecture par le Maître juré, état de la CI, puis fusion dans la branche cible du projet. */
    piece: {
      wide: true,
      async render({ taskId }) {
        const p = await api(`/api/tasks/${taskId}/piece`);
        const stateTag = p.mr.state === "merged" ? ["Fusionnée", "ok"] : p.mr.state === "closed" ? ["Fermée", "warn"] : p.mr.draft ? ["Brouillon", ""] : ["Prête", "ok"];
        const rv = p.review;
        const reviewLabel = !rv ? ["Pas encore relue", ""]
          : ["queued", "running", "detected"].includes(rv.status) ? ["Le Maître juré relit…", ""]
            : rv.status === "needs_human" ? ["Des points à analyser", "warn"]
              : rv.status === "error" ? ["La relecture a échoué", "warn"]
                : rv.status === "dismissed" ? ["Relecture ignorée", "warn"] : ["Relecture OK", "ok"];
        const running = rv && ["queued", "running", "detected"].includes(rv.status);
        const stale = rv && !rv.current && !running;
        const counts = rv && rv.verdict ? `${rv.blocking ? `<b>${rv.blocking}</b> bloquant${rv.blocking > 1 ? "s" : ""} · ` : ""}${rv.important ? `<b>${rv.important}</b> important${rv.important > 1 ? "s" : ""} · ` : ""}<b>${rv.suggestion}</b> suggestion${rv.suggestion > 1 ? "s" : ""}` : "";
        const reviewBtn = p.mr.state !== "opened" || p.followup ? ""
          : running ? ""
            : !rv || stale ? `<button type="button" class="fg-btn" data-fg-piece-review="${taskId}">Faire relire par le Maître juré</button>`
              : `<button type="button" class="fg-btn ghost" data-fg-piece-review="${taskId}" data-again="1">Relire à nouveau</button>`;
        // Les points de la relecture (texte non fiable, échappé) : sévérité, titre, emplacement, explication, suggestion
        const sev = { blocking: ["Bloquant", "warn"], important: ["Important", "warn"], suggestion: ["Suggestion", ""] };
        const findingsHtml = rv && rv.findings && rv.findings.length && !running
          ? `<div class="fg-findings">${rv.findings.map((f) => `<div class="fg-finding sev-${esc(f.severity)}"><div class="fg-finding-head"><span class="fg-tag ${sev[f.severity]?.[1] ?? ""}">${esc(sev[f.severity]?.[0] ?? f.severity)}${f.confirmed ? "" : " · à vérifier"}</span> <b>${esc(f.title)}</b> <code>${esc(f.location)}</code></div><p>${esc(f.explanation)}</p>${f.suggestion ? `<p class="fg-note">Suggestion : ${esc(f.suggestion)}</p>` : ""}</div>`).join("")}</div>`
          : "";
        const questionsHtml = rv && rv.questions && rv.questions.length && !running ? `<p class="fg-note"><b>Questions de la relecture</b></p><ul class="fg-reasons">${rv.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul>` : "";
        const fixBox = p.followup
          ? `<div class="fg-done"><b>Un apprenti reprend la pièce.</b> Il corrige selon la relecture (tâche #${esc(p.followup.id)}) ; cette fenêtre se met à jour toute seule. Ensuite, fais relire la nouvelle version.</div>`
          : p.canFix
            ? `<div class="fg-fixbox"><label class="fg-note">Une consigne en plus (facultatif)<textarea data-fg-fixnote rows="2" maxlength="4000" placeholder="Par exemple : corrige surtout le premier point">${esc(fixNote)}</textarea></label><div class="fg-inline"><button type="button" class="fg-btn" data-fg-piece-fix="${taskId}">Corriger avec la relecture</button></div><p class="fg-note">Un apprenti reprend la même branche avec les points ci-dessus (il vérifie chacun avant de corriger), pousse un nouveau commit sur la MR, puis tu fais relire la nouvelle version.</p></div>`
            : "";
        const ci = p.checks.total === 0 ? "Aucune intégration continue" : p.checks.failed ? `<span class="fg-fail">${p.checks.failed} en échec</span>` : p.checks.pending ? `${p.checks.pending} en cours` : "Verte";
        const reasons = !p.readiness.ok && p.mr.state === "opened" ? `<ul class="fg-reasons">${p.readiness.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : "";
        const mergeBox = p.mr.state === "merged" ? `<div class="fg-done"><b>Fusionnée dans ${esc(p.mr.targetBranch)}.</b> Le code est sur la branche principale du projet. La mise en ligne se fait ensuite comme d'habitude pour ce projet.</div>`
          : p.mr.state === "closed" ? `<p class="fg-note">La MR est fermée : elle ne peut plus être fusionnée.</p>`
            : `<div class="fg-inline"><button type="button" class="fg-btn" data-fg-piece-merge="${taskId}" data-target="${esc(p.mr.targetBranch)}" ${p.readiness.ok ? "" : "disabled"}>Fusionner dans ${esc(p.mr.targetBranch)}</button></div>${reasons}`;
        return {
          title: "La pièce forgée",
          html: `<div class="fg-sc-card"><div class="fg-sc-card-head">Demande de fusion</div>
              <h4>${esc(p.mr.title)}</h4>
              <p><span class="fg-tag ${stateTag[1]}">${stateTag[0]}</span> <code>${esc(p.mr.sourceBranch)}</code> vers <code>${esc(p.mr.targetBranch)}</code> · <a href="${esc(p.mr.url)}" target="_blank" rel="noopener noreferrer">ouvrir la MR</a></p></div>
            <h4>1. Relecture par le Maître juré</h4>
            <p><span class="fg-tag ${reviewLabel[1]}">${reviewLabel[0]}</span> ${stale ? `<span class="fg-note">La MR a changé depuis la dernière relecture.</span>` : ""}</p>
            ${rv && rv.summary && !running ? `<p class="fg-note">${esc(rv.summary)}</p>` : ""}${counts ? `<p class="fg-note">${counts}</p>` : ""}${findingsHtml}${questionsHtml}${fixBox}
            <div class="fg-inline">${reviewBtn}${rv ? `<button type="button" class="fg-btn ghost" data-fg-review="${rv.id}">Lire la revue complète</button>` : ""}</div>
            <p class="fg-note">La relecture ne publie rien sur la MR : c'est un contrôle avant fusion.</p>
            <h4>2. Intégration continue</h4><p>${ci}</p>
            <h4>3. Fusion</h4>${mergeBox}`,
          after: () => {
            clearTimeout(current?.pollTimer);
            // Statut en direct : toutes les 3 s pendant une relecture, toutes les 6 s sinon, tant que la MR est ouverte
            if (p.mr.state === "opened" && current) current.pollTimer = setTimeout(function tick() { if (current?.id !== "piece") return; if (document.activeElement?.matches?.("[data-fg-fixnote]")) { current.pollTimer = setTimeout(tick, 3000); return; } render(); }, running || p.followup ? 3000 : 6000);
          },
          before: () => clearTimeout(current?.pollTimer),
        };
      },
    },

    /** Un apprenti au travail : ce qu'il fait, et un lien vers sa tâche. Une fois sa pièce forgée : relance avec une consigne, ou retrait de l'enclume. */
    worker: {
      async render({ worker }) {
        const [kind, id] = worker.id.split("-");
        const labels = { working: "Au travail", waiting: "Attend son tour", done: "A fini sa pièce", blocked: "A une question", failed: "S'est brisé la lame" };
        const finished = kind === "dev" && worker.state === "done";
        const relaunch = finished
          ? `<label class="fg-field-in">Une suite à lui confier ?<textarea data-fg-relaunch-text rows="3" maxlength="4000" placeholder="Nouvelle consigne ou message pour l'apprenti : corriger un point, ajouter un cas..."></textarea></label>
            <div class="fg-inline"><button type="button" class="fg-btn" data-fg-relaunch="${esc(id)}">Relancer l'apprenti</button><button type="button" class="fg-btn ghost" data-fg-unpin="${esc(worker.id)}" title="L'apprenti n'est plus affiché devant l'enclume : sa tâche et son historique restent dans l'outil">Retirer de l'enclume</button></div>`
          : "";
        return {
          title: "Un apprenti",
          html: `<p><b>${esc(worker.label)}</b></p><p><span class="fg-tag">${esc(labels[worker.state] ?? worker.state)}</span></p><p class="fg-bubble-copy">« ${esc(worker.line)} »</p>
            <div class="fg-inline"><button type="button" class="fg-btn" data-fg-go="${kind === "dev" ? "#dev" : "#reviews"}/${esc(id)}">${kind === "dev" ? "Voir la tâche de l'agent" : "Voir la revue"}</button></div>${relaunch}`,
        };
      },
    },
  };

  /* ---------- tickets d'un projet (râtelier) ---------- */
  const ticketCache = new Map(); // arme -> { at, data }
  async function projectTickets(w) {
    const hit = ticketCache.get(w.key);
    if (hit && Date.now() - hit.at < 6000) return hit.data;
    const data = await api(`/api/forge/tickets?source=${encodeURIComponent(w.source)}&projectId=${w.projectId}`);
    ticketCache.set(w.key, { at: Date.now(), data });
    return data;
  }
  /** Statut réel d'une pièce (la MR de l'agent), lu chez la forge, et ce qu'on peut en faire : relire, fusionner, ouvrir la pièce, ou rien. */
  function pieceStatus(pc) {
    if (!pc) return null;
    if (pc.state === "merged") return { label: "Fusionnée", cls: "ok", act: "none" };
    if (pc.state === "closed") return { label: "MR fermée", cls: "warn", act: "none" };
    if (pc.state === "unknown") return { label: "MR ouverte", cls: "", act: "piece" };
    const rv = pc.review;
    if (rv && ["queued", "running", "detected"].includes(rv.status)) return { label: "Relecture en cours…", cls: "", act: "piece" };
    if (!rv || rv.current === false) return { label: rv ? "MR modifiée depuis la relecture" : (pc.draft ? "Brouillon, pas encore relue" : "Pas encore relue"), cls: "", act: "relire" };
    if (["auto_ok", "published", "approved"].includes(rv.status)) return { label: "Relue : OK, à fusionner", cls: "ok", act: "fusionner" };
    if (rv.status === "needs_human") return { label: "Relue : points à analyser", cls: "warn", act: "piece" };
    return { label: "Relecture échouée", cls: "warn", act: "relire" };
  }
  /** Boutons d'une pièce selon son statut : jamais de fusion proposée pour une pièce déjà fusionnée ou fermée. */
  function pieceButtons(taskId, ps) {
    if (!ps) return "";
    if (ps.act === "relire") return `<button type="button" class="fg-btn" data-fg-piece-review="${taskId}">Faire relire</button><button type="button" class="fg-btn ghost" data-fg-piece="${taskId}">La pièce</button>`;
    if (ps.act === "fusionner") return `<button type="button" class="fg-btn" data-fg-piece="${taskId}">Fusionner</button>`;
    if (ps.act === "piece") return `<button type="button" class="fg-btn ghost" data-fg-piece="${taskId}">La pièce</button>`;
    return "";
  }

  function ticketsSection(w, data, err) {
    const head = `<h4>Tickets ouverts${data ? ` (${data.tickets.length})` : ""}</h4>`;
    const add = `<div class="fg-inline"><button type="button" class="fg-btn" data-fg-scribe="${esc(w.key)}">Nouveau ticket avec le Scribe</button></div>`;
    if (err) return `${head}<p class="fg-note">Impossible de lire les tickets : ${esc(err)}</p>${add}`;
    const column = { todo: ["À traiter", ""], inProgress: ["En cours", "ok"], techValidation: ["Validation technique", "warn"] };
    const taskTag = { running: ["L'apprenti y travaille", "ok"], queued: ["En attente", ""], mr_created: ["Pièce forgée", "ok"], mr_updated: ["Pièce forgée", "ok"], blocked: ["Question de l'apprenti", "warn"], error: ["Échec", "warn"] };
    const row = (t) => {
      const [colName, colCls] = column[t.column] ?? ["", ""];
      const forged = t.task && t.task.mrUrl && (t.task.status === "mr_created" || t.task.status === "mr_updated");
      const ps = forged ? pieceStatus(t.task.piece) : null;
      const [taskName, taskCls] = ps ? [ps.label, ps.cls] : (t.task && taskTag[t.task.status]) || ["", ""];
      const active = t.task && (t.task.status === "running" || t.task.status === "queued");
      // Une pièce dont la MR est ouverte se reprend (nouvelle consigne sur la même MR) ; fusionnée, il n'y a plus rien à lancer
      const mrOpen = ps && (ps.act !== "none");
      const merged = ps && t.task.piece.state === "merged";
      const forge = merged || active || !data.devReady ? "" : mrOpen ? `<button type="button" class="fg-btn ghost" data-fg-go="#dev/${t.task.id}" title="Ajouter un commit sur la MR existante, avec tes consignes">Reprendre la MR</button>` : `<button type="button" class="fg-btn" data-fg-launchraw="${esc(`${w.source}:${w.projectId}:${t.iid}`)}">${t.task ? "Relancer" : "Forger"}</button>`;
      const failed = t.task && t.task.status === "error";
      const why = failed && t.task.error ? `<small class="fg-fail">Échec : ${esc(t.task.error)}</small>` : "";
      const mr = t.task && t.task.mrUrl ? ` · <a href="${esc(t.task.mrUrl)}" target="_blank" rel="noopener noreferrer">ouvrir la MR</a>` : "";
      const piece = forged ? pieceButtons(t.task.id, ps) : "";
      const drop = t.task && !active ? `<button type="button" class="fg-btn ghost" data-fg-deltask="${t.task.id}" title="Supprime cet essai de l'outil (la branche ou la MR éventuelles restent chez la forge)">Supprimer l'essai</button>` : "";
      return `<div class="fg-ticket"><div><b>#${t.iid} ${esc(t.title)}</b><small>${colName ? `<span class="fg-tag ${colCls}">${esc(colName)}</span> ` : ""}${taskName ? `<span class="fg-tag ${taskCls}">${esc(taskName)}</span> ` : ""}${esc(t.labels.slice(0, 3).join(", "))} · <a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer">ouvrir</a>${mr}</small>${why}</div>${forge || drop || piece ? `<div class="fg-inline">${piece}${forge}${drop}</div>` : ""}</div>`;
    };
    const rows = data.tickets.length ? data.tickets.slice(0, 15).map(row).join("") : `<p class="fg-note">Aucun ticket ouvert dans ce projet.</p>`;
    const more = data.tickets.length > 15 ? `<p class="fg-note">… et ${data.tickets.length - 15} autres, dans l'onglet Tickets du tableau de bord.</p>` : "";
    const hint = data.devReady ? "" : `<p class="fg-note">L'agent dev n'est pas autorisé sur ce projet : règle-le pour pouvoir y forger.</p>`;
    return `${head}${hint}${rows}${more}${add}`;
  }

  /** Lance l'agent dev sur un ticket quelconque d'un projet (pas seulement ceux qui te sont assignés). */
  async function launchTicket(info) {
    const answer = await ask({
      title: `Lancer l'agent sur #${info.iid}`,
      okLabel: "Forger",
      input: true,
      attach: true,
      placeholder: "Consignes supplémentaires (optionnel) : piste à explorer, fichiers concernés, contraintes...",
      html: `<p><b>${esc(info.title)}</b></p><dl class="kv"><dt>Projet</dt><dd>${esc(info.projectPath)}</dd></dl>
        <p class="note">L'agent lit le ticket, code sur une branche créée pour lui, puis l'outil la pousse et ouvre une MR <b>Draft</b>. Aucune autre branche n'est touchée.</p>`,
    });
    if (!answer) return;
    try {
      await api("/api/tasks", { source: info.source, projectId: Number(info.projectId), issueIid: Number(info.iid), extraInstructions: answer.value, attachments: answer.attachments });
      state.issues = null;
      ticketCache.clear();
      close(true);
      game.setPopup(false);
      A.sfx.fanfare();
      game.banner("L'apprenti file à l'enclume : il forge ton ticket.");
      game.refresh();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
  }

  /** Fait relire la pièce (la MR de l'agent) par le Maître juré : aucun commentaire n'est publié. */
  async function reviewPiece(taskId, again) {
    try {
      const out = await api(`/api/tasks/${taskId}/review`, again ? { again: true } : {});
      A.sfx.select();
      game.banner(out.already && !again ? "Cette version est déjà relue ou en cours de relecture." : "Le Maître juré relit la pièce…");
      game.refresh();
      render();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
  }

  /** Relance l'agent sur la MR avec les points de la relecture (lus par le serveur) et, si la personne en a écrit une, sa consigne. */
  async function fixPiece(taskId) {
    const note = (current?.el?.querySelector("[data-fg-fixnote]")?.value ?? fixNote).trim();
    try {
      await api(`/api/tasks/${taskId}/fix-review`, { note });
      fixNote = "";
      A.sfx.select();
      game.banner("Un apprenti reprend la pièce avec la relecture…");
      game.refresh();
      render();
    } catch (err) { game.banner(err.message); A.sfx.error(); render(); }
  }

  /** Voile « chargement » sur la fenêtre ouverte : on voit qu'une action est en cours et rien d'autre ne répond. @returns La fonction qui l'enlève. */
  function busy(text) {
    const host = current?.el;
    if (!host) { game.banner(text); return () => undefined; }
    const veil = document.createElement("div");
    veil.className = "fg-loading";
    veil.setAttribute("role", "status");
    veil.innerHTML = `<div class="fg-loading-box"><span class="fg-spin" aria-hidden="true"></span><b>${esc(text)}</b><small>Chez ta forge, ça peut prendre quelques secondes.</small></div>`;
    host.append(veil);
    return () => veil.remove();
  }

  /** Fusionne la pièce dans la branche cible du projet, après confirmation. Le serveur revérifie toutes les règles. */
  async function mergePiece(taskId, target) {
    const ok = await ask({
      title: `Fusionner dans ${target} ?`,
      okLabel: "Fusionner",
      html: `<p>La MR de l'agent est <b>fusionnée dans la branche <code>${esc(target)}</code></b> chez ta forge, avec le code que le Maître juré a relu. La branche de l'agent n'est pas supprimée.</p>
        <p class="note">Pour revenir en arrière, il faudra annuler la fusion chez ta forge. L'outil ne déploie rien : la mise en ligne se fait comme d'habitude pour ce projet.</p>`,
    });
    if (!ok) return;
    const done = busy("Fusion en cours…");
    try {
      await api(`/api/tasks/${taskId}/merge`, {});
      ticketCache.clear();
      state.issues = null;
      A.sfx.fanfare();
      game.banner(`Pièce fusionnée dans ${target}.`);
      game.refresh();
      render();
    } catch (err) { done(); game.banner(err.message); A.sfx.error(); render(); return; }
    done();
  }

  /** Relance l'apprenti dont la pièce est forgée, avec la consigne saisie dans la popup : même MR, nouvelle tâche. Un message vide n'est pas envoyé. */
  async function relaunchWorker(taskId, button) {
    const field = current?.el.querySelector("[data-fg-relaunch-text]");
    const instructions = field?.value.trim() ?? "";
    if (!instructions) { game.banner("Écris une consigne pour relancer l'apprenti."); A.sfx.error(); field?.focus(); return; }
    button.disabled = true;
    try {
      await api(`/api/tasks/${taskId}/followup`, { instructions });
      state.issues = null;
      ticketCache.clear();
      close(true);
      game.setPopup(false);
      A.sfx.fanfare();
      game.banner("L'apprenti reprend sa pièce à l'enclume.");
      game.refresh();
    } catch (err) { button.disabled = false; game.banner(err.message); A.sfx.error(); }
  }

  /** Retire un apprenti de l'enclume, dans ce navigateur seulement : sa tâche et son historique ne sont pas touchés. */
  function unpinWorker(workerId) {
    const hidden = game.save.hiddenWorkers;
    if (!hidden.includes(workerId)) hidden.push(workerId);
    if (hidden.length > 60) hidden.splice(0, hidden.length - 60);
    game.persist();
    close(true);
    game.setPopup(false);
    A.sfx.select();
    game.banner("L'apprenti a quitté l'enclume.");
    game.refresh();
  }

  /** Supprime un essai de l'agent (échec, annulation, MR déjà faite) : rien n'est touché chez la forge. */
  async function deleteTask(id) {
    const ok = await ask({ title: "Supprimer cet essai ?", okLabel: "Supprimer", html: "<p>L'essai et son journal sont supprimés de l'outil. <b>Rien n'est touché chez la forge</b> : si l'agent y a poussé une branche ou ouvert une MR, elles y restent.</p>" });
    if (!ok) return;
    try {
      await api(`/api/tasks/${id}/delete`, {});
      ticketCache.clear();
      state.issues = null;
      A.sfx.select();
      game.banner("Essai supprimé.");
      game.refresh();
      render();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
  }

  /** Le Scribe est une page du tableau de bord (`#tickets/new`, public/scribe.js) : la forge y emmène la personne. */
  function openScribe() {
    close(true);
    game?.setPopup(false);
    ticketCache.clear();
    go("#tickets/new");
  }

  /* ---------- ouverture, fermeture ---------- */
  async function render() {
    if (!current) return;
    const { def, params, el } = current;
    let out;
    try {
      out = await def.render(params, current.sel);
    } catch (err) {
      out = { title: "La forge est silencieuse", html: `<p class="fg-note">${esc(err.message)}</p>` };
    }
    if (!current || current.el !== el) return;
    el.querySelector("h3").textContent = out.title;
    el.querySelector(".fg-pbody").innerHTML = out.html;
    current.before = out.before;
    out.after?.();
  }

  function open(id, params, g) {
    game = g;
    close(true);
    const def = defs[id];
    if (!def) return;
    // Les réglages de la page Paramètres partagent des identifiants avec les popups : on la vide, elle se recharge à la prochaine visite
    const settings = document.getElementById("settings");
    if (settings) settings.innerHTML = "";
    const back = document.createElement("div");
    back.className = "fg-popup-back";
    back.innerHTML = `<div class="fg-popup ${def.wide ? "wide" : ""}" role="dialog" aria-modal="true"><button type="button" class="fg-x" aria-label="Fermer"></button><h3>…</h3><div class="fg-pbody"><p class="fg-note">Un instant…</p></div></div>`;
    back.addEventListener("click", onClick);
    back.addEventListener("input", (ev) => {
      if (ev.target.matches?.("[data-fg-fixnote]")) fixNote = ev.target.value;
      const field = ev.target.dataset?.fgPd;
      if (field && Object.hasOwn(planDraft, field)) planDraft[field] = ev.target.value;
    });
    document.querySelector(".fg-popups").append(back);
    current = { id, params, def, el: back, sel: undefined };
    game.setPopup(true);
    A.sfx.open();
    render();
  }

  function close(silent = false) {
    if (!current) return;
    current.before?.();
    current.el.remove();
    current = null;
    game?.setPopup(false);
    if (!silent) { A.sfx.close(); game?.refresh(); }
  }

  /** Après une action des réglages (jeton, projet) : les popups qui affichent ces réglages se redessinent. */
  document.addEventListener("ra:changed", () => { if (current?.def.rerender) render(); });

  /* ---------- actions dans les popups ---------- */
  async function launch(key) {
    const [source, projectId, iid] = key.split(":");
    const i = state.issues.find((x) => x.source === source && String(x.projectId) === projectId && String(x.iid) === iid);
    if (!i) return;
    const answer = await ask({
      title: `Lancer l'agent sur #${i.iid}`,
      okLabel: "Forger",
      input: true,
      attach: true,
      placeholder: "Consignes supplémentaires (optionnel) : piste à explorer, fichiers concernés, contraintes...",
      html: `<p><b>${esc(i.title)}</b></p><dl class="kv"><dt>Projet</dt><dd>${esc(i.projectPath)}</dd><dt>Branche créée</dt><dd><code>${esc(i.branchPreview)}</code></dd><dt>MR Draft vers</dt><dd><code>${esc(i.targetBranch)}</code></dd></dl>
        <p class="note">L'agent lit le ticket, code sur cette branche, puis l'outil la pousse et ouvre une MR <b>Draft</b>. Aucune autre branche n'est touchée.</p>`,
    });
    if (!answer) return;
    try {
      await api("/api/tasks", { source, projectId: Number(projectId), issueIid: Number(iid), extraInstructions: answer.value, attachments: answer.attachments });
      state.issues = null;
      close(true);
      game.setPopup(false);
      A.sfx.fanfare();
      game.banner("L'apprenti file à l'enclume : il forge ton ticket.");
      game.refresh();
    } catch (err) { game.banner(err.message); A.sfx.error(); }
  }

  function onClick(ev) {
    const t = ev.target;
    if (t === current?.el || t.closest(".fg-x")) return close();
    const by = (attr) => t.closest(`[${attr}]`);
    let el;
    if ((el = by("data-fg-wtype"))) return chooseWeapon(el.dataset.fgWkey, el.dataset.fgWtype);
    if ((el = by("data-fg-deltask"))) return deleteTask(el.dataset.fgDeltask);
    if ((el = by("data-fg-relaunch"))) return relaunchWorker(el.dataset.fgRelaunch, el);
    if ((el = by("data-fg-unpin"))) return unpinWorker(el.dataset.fgUnpin);
    if ((el = by("data-fg-piece-review"))) return reviewPiece(el.dataset.fgPieceReview, el.dataset.again === "1");
    if ((el = by("data-fg-piece-fix"))) return fixPiece(el.dataset.fgPieceFix);
    if ((el = by("data-fg-piece-merge"))) return el.disabled ? undefined : mergePiece(el.dataset.fgPieceMerge, el.dataset.target);
    if ((el = by("data-fg-piece"))) { open("piece", { taskId: el.dataset.fgPiece }, game); return; }
    if (by("data-fg-scribe")) return openScribe();
    if ((el = by("data-fg-plan-new"))) return planNew(el);
    if ((el = by("data-fg-plan-act"))) return planAct(el.dataset.fgPlanAct, el);
    if ((el = by("data-fg-plan-item"))) return planItem(el.dataset.fgPlanItem, el);
    if ((el = by("data-fg-launchraw"))) {
      const [source, projectId, iid] = el.dataset.fgLaunchraw.split(":");
      const w = game.data.armory.weapons.find((x) => x.source === source && String(x.projectId) === projectId);
      const t = ticketCache.get(w?.key)?.data.tickets.find((x) => String(x.iid) === iid);
      if (w && t) launchTicket({ source, projectId, iid, title: t.title, projectPath: w.path });
      return;
    }
    if ((el = by("data-fg-sel"))) { current.sel = el.dataset.fgSel; A.sfx.select(); return render(); }
    if ((el = by("data-fg-edit"))) { openProjectEditor(el.dataset.fgEdit); return; }
    if (by("data-fg-new")) { openProjectEditor(null); return; }
    if ((el = by("data-fg-launch"))) return launch(el.dataset.fgLaunch);
    if ((el = by("data-fg-open"))) { open(el.dataset.fgOpen, {}, game); return; }
    if ((el = by("data-fg-review"))) { close(true); game.setPopup(false); go(`#reviews/${el.dataset.fgReview}`); return; }
    if ((el = by("data-fg-go"))) { close(true); game.setPopup(false); go(el.dataset.fgGo); return; }
    if ((el = by("data-fg-claim"))) { game.claim([el.dataset.fgClaim]); return render(); }
    if (by("data-fg-claimall")) { game.claim(null); return render(); }
    if ((el = by("data-fg-sell"))) return sell([el.dataset.fgSell]);
    if (by("data-fg-sellcommons")) return sell(game.data.armory.loot.filter((i) => i.grade === "common" && !game.save.sold.includes(i.id)).map((i) => i.id));
    if ((el = by("data-fg-offer"))) {
      const r = game.items.buyOffer(el.dataset.fgOffer);
      if (!r.ok) { game.banner(r.why); return A.sfx.error(); }
      game.persist(); A.sfx.coin(); game.renderHud();
      game.banner(`Acheté : ${r.item.name} pour ${r.price} or.`);
      return render();
    }
    if ((el = by("data-fg-sellitem"))) return sellItems([el.dataset.fgSellitem]);
    if (by("data-fg-sellall-common")) return sellItems(game.items.sellable().filter((x) => x.item.rarity === "common").flatMap((x) => Array(x.copies).fill(x.item.id)));
    if ((el = by("data-fg-buy"))) {
      const item = game.cosmetics.find((c) => c.id === el.dataset.fgBuy);
      if (!item || game.save.gold < item.price || (item.rank && game.rankOrder.indexOf(item.rank) > game.rankIndex())) return A.sfx.error();
      game.save.gold -= item.price;
      game.items.add(item.id, item.rank ? "prestige" : "bought");
      game.items.equip(item.id);
      game.persist(); A.sfx.coin(); game.renderHud(); return render();
    }
    if ((el = by("data-fg-wear"))) {
      const id = el.dataset.fgWear;
      if (game.items.isEquipped(id)) game.items.unequip(game.cosmetics.find((c) => c.id === id).part);
      else game.items.equip(id);
      game.persist(); A.sfx.select(); return render();
    }
  }
  /** Vend des objets du sac : chacun quitte le sac. Un objet épique ou légendaire demande une confirmation (on ne le retrouvera pas). */
  async function sellItems(ids) {
    const first = ids.length === 1 ? game.items.catalog().get(ids[0]) : null;
    if (first && ["epic", "legendary"].includes(first.rarity)) {
      const ok = await ask({ title: `Vendre ${first.name} ?`, okLabel: "Vendre", html: `<p>Cet objet (${esc(S.GRADE[first.rarity].name.toLowerCase())}) <b>quittera ton sac pour de bon</b> : une arme est unique, tu ne pourras pas la racheter.</p>` });
      if (!ok) return;
    }
    let total = 0, count = 0;
    for (const id of ids) {
      const r = game.items.sellItem(id);
      if (!r) continue;
      total += Math.round(r.price * (1 + game.goldBonus() / 100));
      count++;
    }
    if (!count) { game.banner("Cet objet ne peut pas être vendu (il est porté)."); return A.sfx.error(); }
    game.save.gold += total;
    game.persist(); A.sfx.coin(); game.renderHud();
    game.banner(`${count > 1 ? `${count} objets vendus` : "Vendu"} pour ${total} or.`);
    if (game.customUi) game.customUi.redraw();
    render();
  }
  function sell(ids) {
    let total = 0;
    for (const id of ids) {
      const item = game.data.armory.loot.find((i) => i.id === id);
      if (!item || game.save.sold.includes(id)) continue;
      game.save.sold.push(id);
      total += Math.round(item.value * (1 + game.goldBonus() / 100));
    }
    if (!total) return;
    game.save.gold += total;
    game.persist(); A.sfx.coin(); game.renderHud();
    game.banner(`Vendu pour ${total} or.`);
    render();
  }

  window.ForgePopups = {
    open,
    close: () => close(),
    /** Quêtes et hauts faits, pour la page du profil (le jeu fournit ses données : aucun popup n'a forcément été ouvert avant). */
    questsHtml: (source) => questsBody(source),
    /** Redessine les popups « vivants » (tableau, marchand) quand les données ont changé. */
    update() {
      if (!current?.def.live) return;
      // Un formulaire en cours de saisie (éditeur de projet du râtelier) ne doit pas être effacé par le rafraîchissement automatique
      if (current.id === "rack" && document.getElementById("project-editor")?.childElementCount) return;
      // Idem pour une réponse ou une idée en cours de frappe dans la fenêtre des plans
      if (current.id === "plans" && current.el.contains(document.activeElement) && document.activeElement.matches("textarea, input, select")) return;
      render();
    },
  };
})();
