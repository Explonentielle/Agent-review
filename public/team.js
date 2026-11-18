/* Équipe : membres, rôles, invitations et limites par personne (Paramètres > Équipe, administrateurs seulement).
   Elle utilise les fonctions communes de index.html (api, esc, toast, ask, pill, forgeName, state). */
(() => {
  "use strict";

  const ROLE_NAMES = { admin: "Administrateur", member: "Membre", viewer: "Lecteur" };
  const ROLE_HELP = { admin: "règle l'espace, invite, voit le journal", member: "lance les agents, relit, fusionne", viewer: "lecture seule" };
  const usd = (n) => `${Number(n).toFixed(2)} $`;
  /** Valeur d'un champ numérique : vide = null (reprendre la valeur par défaut de l'espace). */
  const numberOrNull = (el) => (el && el.value.trim() !== "" ? Number(el.value) : null);

  /**
   * @param {string} current Rôle à cocher.
   * @param {string} [attr] Attribut de données posé sur la liste.
   * @returns {string} Une liste de rôles.
   */
  const roleSelect = (current, attr = "") => `<select ${attr}>${Object.entries(ROLE_NAMES).map(([id, name]) => `<option value="${id}" ${id === current ? "selected" : ""}>${name}</option>`).join("")}</select>`;

  /** Ce que la personne a consommé, en une ligne. */
  function usageText(member, team) {
    const runs = `${member.usage.runsToday} agent${member.usage.runsToday > 1 ? "s" : ""} aujourd'hui`;
    return team.agentAuth === "api" ? `${runs} · ${usd(member.usage.monthUsd)} ce mois` : runs;
  }

  /**
   * Une ligne de membre : qui, ses comptes de forge, son rôle, sa consommation, ses limites et le bouton pour le retirer.
   * @param {object} m Membre renvoyé par `/api/team`.
   * @param {object} team État de l'équipe (réglages par défaut, mode de connexion à Claude).
   * @returns {string} Le HTML de la ligne.
   */
  function memberRow(m, team) {
    const forges = m.identities.length ? m.identities.map((i) => pill("gray", `${esc(forgeName(i.provider))} @${esc(i.login)}`)).join(" ") : `<span class="note">aucun compte de forge lié</span>`;
    const budgetHint = team.defaults.perUserMonthlyUsd > 0 ? `par défaut : ${team.defaults.perUserMonthlyUsd} $` : "par défaut : sans limite";
    const runsHint = team.defaults.perUserDailyRuns > 0 ? `par défaut : ${team.defaults.perUserDailyRuns}` : "par défaut : sans limite";
    return `<div class="team-member" data-team-user="${m.userId}">
      <div class="team-who"><b>${esc(m.name)}</b>${m.you ? ` ${pill("accent", "toi")}` : ""} ${forges}
        <div class="note">${esc(usageText(m, team))}</div></div>
      <label class="field team-role"><span>Rôle</span>${roleSelect(m.role, `data-team-role="${m.userId}"`)}</label>
      <label class="field team-quota"><span>Budget mensuel ($)</span><input type="number" min="0" step="1" data-team-budget placeholder="${esc(budgetHint)}" value="${m.quota.budgetUsd ?? ""}" ${team.agentAuth === "api" ? "" : "disabled"}><small>0 = sans limite${team.agentAuth === "api" ? "" : " · mode clé API seulement"}</small></label>
      <label class="field team-quota"><span>Agents par jour</span><input type="number" min="0" step="1" data-team-runs placeholder="${esc(runsHint)}" value="${m.quota.dailyRuns ?? ""}"><small>0 = sans limite</small></label>
      <div class="team-actions"><button type="button" class="btn sm" data-act="team-quota" data-user="${m.userId}">Enregistrer les limites</button>
        <button type="button" class="btn sm danger" data-act="team-remove" data-user="${m.userId}" data-name="${esc(m.name)}">${m.you ? "Quitter l'espace" : "Retirer"}</button></div>
    </div>`;
  }

  /** @returns Le formulaire de création d'une invitation, et le lien juste créé (affiché une seule fois). */
  function inviteBox(team) {
    if (!team.loginEnabled) return `<div class="callout warn">${ICON.warn}<h3>Invitations indisponibles</h3><p>La connexion par compte de forge n'est pas configurée sur cette installation (variables <code>AUTH_*</code> du .env) : personne ne pourrait accepter une invitation.</p></div>`;
    if (!team.canInvite) return `<div class="callout info">${ICON.info}<h3>Espace personnel</h3><p>On n'invite que dans un espace d'équipe : transforme-le d'abord, avec le bouton ci-dessus. Tes données restent en place.</p></div>`;
    const link = state.teamLink
      ? `<div class="callout ok">${ICON.ok}<h3>Lien d'invitation créé</h3><p>Il n'est affiché <b>qu'une seule fois</b> : copie-le et envoie-le à la personne par le moyen de ton choix. Il ne sert qu'une fois et expire.</p>
          <div class="team-link"><input readonly value="${esc(state.teamLink)}" data-team-link><button type="button" class="btn sm primary" data-copy="${esc(state.teamLink)}">Copier</button><button type="button" class="btn sm ghost" data-act="team-link-close">Fermer</button></div></div>` : "";
    return `${link}<div class="team-invite" id="team-invite-form">
      <label class="field"><span>Rôle</span>${roleSelect("member", "data-team-new-role")}<small>${esc(Object.entries(ROLE_HELP).map(([id, help]) => `${ROLE_NAMES[id]} : ${help}`).join(" · "))}</small></label>
      <label class="field"><span>Mot d'accompagnement (facultatif)</span><input maxlength="200" data-team-note placeholder="Ex. pour Dan, de l'équipe back"></label>
      <label class="field"><span>Réservée à un compte (facultatif)</span><input maxlength="100" data-team-forge placeholder="github:dan ou gitlab:dan"><small>Si renseigné, seul ce compte peut accepter.</small></label>
      <label class="field"><span>Valable (jours)</span><input type="number" min="1" max="30" value="7" data-team-days></label>
      <div class="team-actions"><button type="button" class="btn primary" data-act="team-invite">Créer le lien d'invitation</button></div></div>`;
  }

  /** @returns Les invitations en attente, avec de quoi les révoquer. */
  function pendingInvitations(team) {
    if (!team.invitations.length) return `<p class="note">Aucune invitation en attente.</p>`;
    return team.invitations.map((i) => `<div class="team-pending"><div><b>${esc(ROLE_NAMES[i.role])}</b>${i.forgeLogin ? ` ${pill("gray", esc(i.forgeLogin))}` : ""} ${i.note ? esc(i.note) : ""}
        <div class="note">créée par ${esc(i.createdBy)} · expire le ${esc(String(i.expiresAt).slice(0, 10))}</div></div>
      <button type="button" class="btn sm ghost" data-act="team-revoke" data-id="${i.id}">Révoquer</button></div>`).join("");
  }

  /**
   * Contenu de la section : l'espace, ses membres, les invitations.
   * @param {object} team État de l'équipe renvoyé par `/api/team`.
   * @returns {string} Le HTML.
   */
  function inner(team) {
    const w = team.workspace;
    const rename = `<div class="team-ws"><label class="field"><span>Nom de l'espace</span><input maxlength="100" data-team-ws-name value="${esc(w.name)}"></label>
        <button type="button" class="btn sm" data-act="team-rename">Renommer</button>
        ${w.kind === "personal" ? `<button type="button" class="btn sm primary" data-act="team-convert">Transformer en espace d'équipe</button>` : ""}</div>`;
    return `${rename}
      <div class="sub-title">Membres (${team.members.length})</div>
      <div class="team-members">${team.members.map((m) => memberRow(m, team)).join("")}</div>
      <div class="sub-title">Inviter quelqu'un</div>
      ${inviteBox(team)}
      <div class="sub-title">Invitations en attente</div>
      ${pendingInvitations(team)}`;
  }

  /**
   * La section « Équipe » des Paramètres.
   * @param {object|null} team État de l'équipe, ou null (réservé aux administrateurs : rien n'est affiché).
   * @returns {string} Le HTML de la section, ou une chaîne vide.
   */
  function html(team) {
    if (!team) return "";
    return `<section class="card-section" id="team-section">
      <h2>Équipe</h2>
      <p class="desc">Les personnes de l'espace, leur rôle et leurs limites. Un <b>administrateur</b> règle l'espace, un <b>membre</b> lance les agents et relit, un <b>lecteur</b> consulte seulement. Chacun garde ses propres jetons de forge : l'outil ne les partage jamais. Les limites par défaut se règlent dans Modèles ; celles d'un membre priment, vides elles reprennent la valeur par défaut.</p>
      <div id="team-box">${inner(team)}</div>
    </section>`;
  }

  /** Recharge l'état de l'équipe et redessine la section. */
  async function refresh() {
    state.team = await api("/api/team");
    const box = document.getElementById("team-box");
    if (box) box.innerHTML = inner(state.team);
  }

  /**
   * Fait une action sur l'équipe, puis redessine : en cas de refus, le message du serveur est affiché et l'écran reprend l'état réel.
   * @param {string} path Route à appeler.
   * @param {object} body Corps de la requête.
   * @param {string} [done] Message de réussite.
   * @returns {Promise<object|null>} La réponse, ou null en cas d'échec.
   */
  async function act(path, body, done) {
    let res = null;
    try {
      res = await api(path, body);
      if (done) toast(done);
    } catch (err) {
      toast(err.message, true);
    }
    await refresh().catch((err) => toast(err.message, true));
    return res;
  }

  const rowOf = (el) => el.closest("[data-team-user]");

  document.addEventListener("change", (ev) => {
    const select = ev.target.closest?.("[data-team-role]");
    if (select) return act(`/api/team/members/${select.dataset.teamRole}/role`, { role: select.value }, "Rôle modifié.");
  });

  document.addEventListener("click", async (ev) => {
    const el = ev.target.closest?.("[data-act]");
    if (!el || !el.dataset.act.startsWith("team-")) return;
    const box = document.getElementById("team-box");
    const act_ = el.dataset.act;

    if (act_ === "team-quota") {
      const row = rowOf(el);
      return act(`/api/team/members/${el.dataset.user}/quota`, { budgetUsd: numberOrNull(row.querySelector("[data-team-budget]")), dailyRuns: numberOrNull(row.querySelector("[data-team-runs]")) }, "Limites enregistrées.");
    }
    if (act_ === "team-remove") {
      const ok = await ask({ title: `${el.dataset.name} : quitter l'espace ?`, html: "<p>La personne perd l'accès à cet espace tout de suite : ses sessions sont fermées, ses détecteurs arrêtés et ses jetons de forge de cet espace effacés. Les reviews et tâches qu'elle a lancées restent.</p>", okLabel: "Retirer" });
      if (!ok) return;
      const res = await act(`/api/team/members/${el.dataset.user}/remove`, {}, "Membre retiré.");
      if (res && Number(el.dataset.user) === state.me?.user?.id) location.reload(); // on s'est retiré soi-même : l'espace n'est plus le nôtre
      return;
    }
    if (act_ === "team-invite") {
      const form = document.getElementById("team-invite-form");
      const res = await act("/api/team/invitations", {
        role: form.querySelector("[data-team-new-role]").value,
        note: form.querySelector("[data-team-note]").value,
        forgeLogin: form.querySelector("[data-team-forge]").value.trim(),
        days: Number(form.querySelector("[data-team-days]").value) || 7,
      });
      if (res) { state.teamLink = res.link; if (box) box.innerHTML = inner(state.team); document.querySelector("[data-team-link]")?.select(); }
      return;
    }
    if (act_ === "team-link-close") { state.teamLink = null; if (box) box.innerHTML = inner(state.team); return; }
    if (act_ === "team-revoke") return act(`/api/team/invitations/${el.dataset.id}/revoke`, {}, "Invitation révoquée.");
    if (act_ === "team-rename") return act("/api/team/rename", { name: document.querySelector("[data-team-ws-name]").value }, "Espace renommé.");
    if (act_ === "team-convert") {
      const ok = await ask({ title: "Transformer en espace d'équipe ?", html: "<p>Tes projets, réglages, reviews et tâches restent en place. L'espace pourra recevoir d'autres membres, sur invitation. Cette transformation ne se défait pas.</p>", okLabel: "Transformer" });
      if (!ok) return;
      await act("/api/team/convert", { name: document.querySelector("[data-team-ws-name]").value }, "L'espace est une équipe.");
      return refreshMe();
    }
  });

  window.Team = { html, refresh, inner };
})();
