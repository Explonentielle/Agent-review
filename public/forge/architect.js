/* L'Architecte : créer une salle (et un jeu) en la décrivant, la visiter, la jouer, la garder, la partager à son équipe.
   Le serveur contrôle tout (src/rooms/) ; ce fichier n'est que l'interface. */
(() => {
  "use strict";

  const EXAMPLES = [
    "Un platformer avec des pièces, des slimes et un drapeau à atteindre tout en haut",
    "Un labyrinthe vu de dessus : il faut prendre une clé pour ouvrir la porte, des crânes me poursuivent",
    "Une taverne chaleureuse avec un tavernier qui raconte des blagues et une cheminée",
    "Une salle de quiz sans jeu : trois personnages qui posent chacun une devinette",
  ];
  const TABS = [["create", "Créer"], ["mine", "Mes salles"], ["team", "Équipe"], ["manual", "À la main"]];
  const MODE = { platformer: "plateforme", topdown: "vue de dessus" };
  const VIS = { private: "Privée", team: "Équipe" };

  /**
   * @param ctx Ce que la fenêtre emprunte à `popups.js` : le jeu, le rendu, l'onglet choisi, l'audio, la fermeture.
   * @returns { def, handleClick, handleInput }
   */
  function create(ctx) {
    const game = () => ctx.game();
    const st = { idea: "", phase: "idea", draft: null, err: "", vis: "private", list: null, listErr: "" };
    const tab = () => (TABS.some(([k]) => k === ctx.sel()) ? ctx.sel() : "create");

    async function loadList() {
      try { st.list = await api("/api/user-rooms"); st.listErr = ""; } catch (err) { st.listErr = err.message; }
      if (ctx.isOpen()) ctx.rerender();
    }

    const summary = (room) => {
      const g = room.game;
      return `${esc(room.theme)} · ${room.objects.length} objet${room.objects.length > 1 ? "s" : ""} · ${room.npcs.length} personnage${room.npcs.length > 1 ? "s" : ""}${g ? ` · jeu « ${esc(g.title)} » (${MODE[g.mode] ?? esc(g.mode)})` : ""}`;
    };

    /* ---------- actions ---------- */
    async function draft() {
      if (!st.idea.trim()) { st.err = "Décris d'abord ta salle, même en quelques mots."; return ctx.rerender(); }
      st.phase = "drafting"; st.err = "";
      ctx.rerender();
      try {
        st.draft = await api("/api/rooms/draft", { idea: st.idea });
        st.phase = "review";
        ctx.sfx.open();
      } catch (err) {
        st.phase = "idea";
        st.err = err.message;
        ctx.sfx.error();
      }
      if (ctx.isOpen()) ctx.rerender();
    }

    async function keep() {
      st.err = "";
      try {
        const out = await api("/api/user-rooms", { room: st.draft.room, visibility: st.vis });
        ctx.sfx.fanfare();
        game().banner(`Salle gardée : « ${out.room.name} ».`);
        st.phase = "idea"; st.draft = null; st.idea = ""; st.list = null;
        ctx.setSel("mine");
        game().refresh();
      } catch (err) { st.err = err.message + (err.errors?.length ? " " + err.errors.join(" ; ") : ""); ctx.sfx.error(); }
      if (ctx.isOpen()) ctx.rerender();
    }

    async function setVisibility(id, visibility) {
      try { await api(`/api/user-rooms/${id}/visibility`, { visibility }); ctx.sfx.select(); st.list = null; } catch (err) { game().banner(err.message); ctx.sfx.error(); }
      ctx.rerender();
    }

    async function remove(id, name) {
      if (!(await ask({ title: "Supprimer cette salle ?", html: `<p>« ${esc(name)} » est supprimée pour de bon, pour toi et pour ton équipe si elle la voyait.</p>`, okLabel: "Supprimer" }))) return;
      try { await api(`/api/user-rooms/${id}/delete`, {}); st.list = null; game().banner("Salle supprimée."); } catch (err) { game().banner(err.message); ctx.sfx.error(); }
      ctx.rerender();
    }

    const roomOf = (id) => (st.draft?.room.id === id ? st.draft.room : st.list?.rooms.find((r) => r.room.id === id)?.room ?? null);

    /* ---------- onglets ---------- */
    function createHtml() {
      const err = st.err ? `<div class="fg-err" role="alert">${esc(st.err)}</div>` : "";
      if (st.phase === "drafting") return `${err}<p class="fg-note fg-wait">L'Architecte dessine ta salle… (20 secondes à une minute : il vérifie aussi que le jeu est gagnable)</p>`;
      if (st.phase === "review" && st.draft) {
        const d = st.draft, room = d.room;
        const solved = d.solved === true ? `<p class="fg-note">✓ Un robot a réussi à gagner ce niveau : il est jouable.</p>` : "";
        const warn = d.warnings.length ? `<div class="fg-err">${d.warnings.map(esc).join(" ")}</div>` : "";
        const notes = d.notes.length ? `<div class="fg-questions"><b>L'Architecte te dit :</b><ul>${d.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : "";
        return `${err}${notes}<div class="fg-sc-card"><div class="fg-sc-card-head">Proposition de l'Architecte</div><h4>${esc(room.name)}</h4><p><small>${summary(room)}</small></p>${room.game && room.game.intro ? `<p>${esc(room.game.intro)}</p>` : ""}</div>${solved}${warn}
          <div class="fg-inline"><button type="button" class="fg-btn" data-ar-act="visit" data-id="${esc(room.id)}">Visiter la salle</button>${room.game ? `<button type="button" class="fg-btn" data-ar-act="play" data-id="${esc(room.id)}">Jouer au jeu</button>` : ""}<button type="button" class="fg-btn ghost" data-ar-act="again">Refaire</button></div>
          <div class="fg-inline fg-ar-keep"><label class="fg-field-in">Qui la voit ?<select data-ar="vis"><option value="private" ${st.vis === "private" ? "selected" : ""}>Moi seul (privée)</option><option value="team" ${st.vis === "team" ? "selected" : ""}>Mon équipe</option></select></label><button type="button" class="fg-btn" data-ar-act="keep">Garder cette salle</button></div>
          <p class="fg-note">Visite et joue d'abord : rien n'est gardé tant que tu n'as pas cliqué sur « Garder ». Une salle est privée par défaut.</p>`;
      }
      return `${err}<p class="fg-note">Décris ta salle avec tes mots, et un petit jeu si tu veux. <b>L'Architecte écrit une description, pas du code</b> : le moteur de la forge la dessine et la fait jouer.</p>
        <details class="fg-ar-how"><summary>Comment marche le moteur à règles ?</summary>
          <p class="fg-note">Un jeu, c'est une <b>carte</b> (blocs, plateformes, piques), des <b>objets</b> (pièces, clés, ennemis, drapeau...), une <b>physique</b> (gravité, saut) et des <b>règles</b> du genre « si le joueur touche la pièce, alors +1 point », avec une <b>condition de victoire</b>. Tu peux demander un platformer ou un jeu vu de dessus. Avant de te le montrer, un robot essaie de gagner le niveau avec les vraies règles.</p></details>
        <label class="fg-field-in">Ce que tu voudrais<textarea data-ar="idea" rows="5" maxlength="4000" placeholder="Ex. une salle d'arcade avec un platformer où il faut attraper toutes les pièces avant le temps limite">${esc(st.idea)}</textarea></label>
        <div class="fg-chips">${EXAMPLES.map((e, i) => `<button type="button" class="fg-chip" data-ar-example="${i}">${esc(e)}</button>`).join("")}</div>
        <div class="fg-inline"><button type="button" class="fg-btn" data-ar-act="draft">Dessiner avec l'Architecte</button></div>
        <p class="fg-note">Rien n'est gardé tant que tu n'as pas dit oui. Tes salles sont privées ; tu peux ensuite les partager à ton équipe.</p>`;
    }

    function roomRow(v, mine) {
      const r = v.room;
      const buttons = [`<button type="button" class="fg-btn" data-ar-act="visit" data-id="${esc(r.id)}">Visiter</button>`];
      if (r.game) buttons.push(`<button type="button" class="fg-btn" data-ar-act="play" data-id="${esc(r.id)}">Jouer</button>`);
      if (mine) {
        buttons.push(`<button type="button" class="fg-btn ghost" data-ar-act="share" data-id="${esc(r.id)}" data-to="${v.visibility === "team" ? "private" : "team"}">${v.visibility === "team" ? "Rendre privée" : "Partager à l'équipe"}</button>`);
        buttons.push(`<button type="button" class="fg-btn ghost" data-ar-act="delete" data-id="${esc(r.id)}" data-name="${esc(r.name)}">Supprimer</button>`);
      }
      return `<div class="fg-item no-icon"><div><b>${esc(r.name)}</b> <span class="fg-tag ${v.visibility === "team" ? "ok" : ""}">${VIS[v.visibility]}</span>${mine ? "" : ` <small>par ${esc(v.owner.name)}</small>`}<small>${summary(r)}</small></div><div class="fg-inline">${buttons.join("")}</div></div>`;
    }
    function listHtml(mine) {
      if (st.listErr) return `<div class="fg-err">${esc(st.listErr)}</div>`;
      if (!st.list) { loadList(); return `<p class="fg-note fg-wait">Un instant…</p>`; }
      const rooms = st.list.rooms.filter((v) => v.mine === mine);
      if (!rooms.length) return mine
        ? `<p class="fg-note">Tu n'as encore dessiné aucune salle. Va dans « Créer » : décris-la, l'Architecte la dessine.</p>`
        : `<p class="fg-note">Personne n'a partagé de salle à l'équipe pour l'instant. Quand un membre de ton espace partage une de ses salles, elle apparaît ici et tu peux la visiter.</p>`;
      return `${mine ? `<p class="fg-note">${st.list.mine} salle${st.list.mine > 1 ? "s" : ""} sur ${st.list.max} au plus. Une salle est <b>privée</b> tant que tu ne la partages pas à ton équipe.</p>` : `<p class="fg-note">Les salles que les membres de ton espace ont partagées. Tu peux les visiter et y jouer.</p>`}${rooms.map((v) => roomRow(v, mine)).join("")}`;
    }

    /** Mode d'emploi pour écrire une salle à la main (le mode avancé, sans agent). */
    function manualHtml() {
      const r = game().rooms;
      if (!r?.catalog) return `<p class="fg-note">Les plans ne sont pas disponibles : le serveur n'a pas répondu. Réessaie dans un instant.</p>`;
      const cat = r.catalog, lim = cat.limits;
      const code = (t) => `<code>${esc(t)}</code>`;
      const steps = [
        `<b>Copie le modèle</b> : une salle complète et jouable. <button type="button" class="fg-btn" data-fg-copy-room>Copier le modèle</button>`,
        `Enregistre-le dans le dépôt sous ${code("public/rooms/<id>.json")}. L'identifiant (minuscules, chiffres et tirets) est aussi le nom du fichier.`,
        `Adapte-le : une grille de ${cat.grid.width} colonnes sur ${cat.grid.height} rangées (mur du fond rangées 0 à 2, sol 3 à ${cat.grid.floorBottom}, portes en bas), des objets du catalogue, des personnages et leurs répliques. Pour un jeu, voir ${code("docs/jeux.md")}.`,
        `Contrôle-le : ${code("npx tsx scripts/check-rooms.ts")}. Chaque erreur est dite en français.`,
        `Pousse, puis redéploie : ${code("git pull && docker compose up -d --build")}. Avec ${code('"hub": true')}, une porte magique apparaît dans le mur du fond de la forge (trois salles au plus).`,
      ];
      const objects = Object.entries(cat.objects).map(([type, o]) => `<span class="fg-tag" title="${esc(type)}">${esc(type)} · ${o.resizable ? "taille libre" : `${o.w} × ${o.h}`} ${o.where === "wall" ? "mur" : "sol"}</span>`).join(" ");
      const tpl = r.template ? `<details><summary>Voir le modèle (si la copie est refusée par le navigateur)</summary><pre class="fg-pre">${esc(JSON.stringify(r.template, null, 2))}</pre></details>` : "";
      const problems = r.problems?.length ? `<h4>À corriger</h4>${r.problems.map((p) => `<div class="fg-err"><b>${esc(p.file)}</b> : ${p.errors.map(esc).join(" ; ")}</div>`).join("")}` : "";
      return `<p class="fg-note">Pour les habitués : une salle est un fichier de données dans le dépôt. Le plus simple reste de décrire la tienne dans « Créer ».</p>
        <h4>Créer une salle à la main</h4><ol class="fg-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>${tpl}${problems}
        <h4>Ce que tu peux poser</h4><div class="fg-chips">${objects}</div>
        <p class="fg-note">Thèmes : ${cat.themes.map(esc).join(", ")}. Apparences : ${cat.looks.map(esc).join(", ")}. Limites : ${lim.objects} objets, ${lim.npcs} personnages, ${lim.doors} portes, ${Math.round(lim.fileBytes / 1024)} Ko par fichier. Détail : ${code("docs/salles.md")}.</p>`;
    }

    const def = {
      wide: true,
      async render() {
        const t = tab();
        const tabs = `<div class="fg-tabs">${TABS.map(([k, label]) => `<button type="button" class="fg-tab ${k === t ? "on" : ""}" data-fg-sel="${k}">${label}${k === "mine" && st.list ? ` <i>${st.list.mine}</i>` : ""}</button>`).join("")}</div>`;
        const body = t === "create" ? createHtml() : t === "mine" ? listHtml(true) : t === "team" ? listHtml(false) : manualHtml();
        return { title: "L'Architecte", html: tabs + body };
      },
    };

    /** Saisie mémorisée sans redessiner la fenêtre (le curseur ne saute pas). */
    function handleInput(ev) {
      const t = ev.target;
      if (t.dataset.ar === "idea") st.idea = t.value;
      else if (t.dataset.ar === "vis") st.vis = t.value;
    }

    /** @returns Vrai si le clic était pour l'Architecte. */
    function handleClick(ev) {
      const ex = ev.target.closest("[data-ar-example]");
      if (ex) { st.idea = EXAMPLES[Number(ex.dataset.arExample)]; st.err = ""; ctx.sfx.select(); ctx.rerender(); return true; }
      const el = ev.target.closest("[data-ar-act]");
      if (!el) return false;
      const act = el.dataset.arAct, id = el.dataset.id;
      if (act === "draft") draft();
      else if (act === "again") { st.phase = "idea"; st.err = ""; ctx.rerender(); }
      else if (act === "keep") keep();
      else if (act === "visit") { const r = roomOf(id); if (r) game().visitRoom(r); }
      else if (act === "play") { const r = roomOf(id); if (r) game().playRoom(r); }
      else if (act === "share") setVisibility(id, el.dataset.to);
      else if (act === "delete") remove(id, el.dataset.name);
      return true;
    }

    return { def, handleClick, handleInput };
  }

  window.ForgeArchitect = { create };
})();
