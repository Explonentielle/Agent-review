/* Objets du forgeron : inventaire, équipement, raretés, butin et échanges. La progression reste dans le navigateur (g.save), le catalogue et le butin
   viennent du serveur (src/game/loot.ts) : le tirage est déterministe, donc recharger la page ne change rien. */
(() => {
  "use strict";
  const S = window.ForgeSprites;

  const RARITIES = ["common", "rare", "epic", "legendary"];
  const NEXT = { common: "rare", rare: "epic", epic: "legendary" };
  const SOURCES = { bought: "Acheté", loot: "Obtenu", trade: "Échangé", prestige: "Prestige" };
  const PARTS = ["cape", "hat", "apron", "weapon"];
  const PART_NAME = { cape: "Cape", hat: "Couvre-chef", apron: "Tablier", weapon: "Arme" };
  const TRADE_COUNT = 3;
  /** Au premier passage, on ne déverse pas tout l'historique d'un coup : les plus récents sont ramassés, le reste compte comme déjà ramassé. */
  const FIRST_RUN_LOOT = 5;
  const MAX_LOOTED = 1000;

  const color = (rarity) => S.GRADE[rarity]?.c ?? "#9aa0ab";
  const rarityName = (rarity) => S.GRADE[rarity]?.name ?? rarity;
  const tag = (rarity) => `<span class="fg-grade g-${rarity}">${esc(rarityName(rarity))}</span>`;

  /**
   * @param g État du jeu (g.save est la sauvegarde du navigateur, g.lootCatalog le catalogue du serveur).
   * @param ctx Ce qu'il emprunte au jeu : objets de la boutique, sauvegarde, bannières, sons, redessin de l'aperçu et du panneau.
   * @returns Les opérations sur les objets du forgeron.
   */
  function create(g, ctx) {
    const save = () => g.save;
    const thumbs = new Map();

    /** Boutique et butin réunis, par identifiant. Une arme tirée au sort est un exemplaire unique : « identifiant-du-modèle#graine ». */
    function catalog() {
      const map = new Map();
      for (const item of ctx.baseItems) map.set(item.id, { kind: "cosmetic", ...item });
      for (const item of g.lootCatalog || []) map.set(item.id, { ...item });
      for (const item of map.values()) if (item.kind === "weapon") item.part = "weapon";
      // Les exemplaires uniques possédés : le modèle du catalogue, plus leur graine (qui fixe leurs valeurs)
      for (const id of Object.keys(save().items || {})) {
        const [baseId, seed] = splitId(id), base = seed ? map.get(baseId) : null;
        if (base?.kind === "weapon") {
          // Une arme épique ou légendaire prend un surnom de son premier effet : « Lance mythique des braises »
          const epithet = window.ForgeCombat.rollWeapon(base.weapon, base.rarity, seed)?.epithet;
          map.set(id, { ...base, id, seed, unique: true, name: epithet ? `${base.name} ${epithet}` : base.name });
        }
      }
      return map;
    }
    /** Sépare « modèle#graine ». */
    const splitId = (id) => { const i = String(id).indexOf("#"); return i < 0 ? [String(id), ""] : [id.slice(0, i), id.slice(i + 1)]; };
    /** Identifiant sous lequel un objet de butin entre dans le sac : une arme est unique (modèle et graine de l'événement). */
    const dropId = (d, cat) => (cat.get(d.itemId)?.kind === "weapon" && d.seed ? `${d.itemId}#${d.seed}` : d.itemId);
    /** Fiche de combat d'une arme du sac (valeurs tirées, bonus, qualité du jet). */
    const cardOf = (item) => (item?.kind === "weapon" ? window.ForgeCombat.weaponCard(item.weapon, item.rarity, item.seed) : null);
    const fmt = (n) => String(n).replace(".", ",");
    const STAT_NAME = { force: "Force", agilite: "Agilité", vitalite: "Vitalité", chance: "Chance" };

    /** Remet en forme une sauvegarde plus ancienne : objets possédés avec leur origine, un objet porté par emplacement. */
    function migrate() {
      const s = save();
      if (!s.items || typeof s.items !== "object" || Array.isArray(s.items)) {
        s.items = {};
        const base = new Map(ctx.baseItems.map((i) => [i.id, i]));
        for (const id of s.owned || []) s.items[id] = { n: 1, from: { [base.get(id)?.rank ? "prestige" : "bought"]: 1 } };
      }
      if (!s.equip || typeof s.equip !== "object" || Array.isArray(s.equip)) {
        s.equip = {};
        // Comme avant : parmi les tenues possédées et non rangées, la dernière de chaque emplacement
        for (const item of ctx.baseItems) if ((s.owned || []).includes(item.id) && (s.worn || {})[item.id] !== false) s.equip[item.part] = item.id;
      }
      if (!Array.isArray(s.looted)) s.looted = [];
      if (!Array.isArray(s.fresh)) s.fresh = [];
      s.owned = Object.keys(s.items).filter((id) => s.items[id].n > 0);
    }

    const count = (id) => save().items[id]?.n ?? 0;
    const owns = (id) => count(id) > 0;
    const isEquipped = (id) => PARTS.some((p) => save().equip[p] === id);
    const partOf = (id) => catalog().get(id)?.part ?? null;

    /** Ajoute un exemplaire. `src` : bought, loot, trade ou prestige. */
    function add(id, src) {
      const s = save();
      const entry = (s.items[id] ??= { n: 0, from: {} });
      entry.n++;
      entry.from[src] = (entry.from[src] || 0) + 1;
      s.owned = Object.keys(s.items).filter((k) => s.items[k].n > 0);
    }
    function equip(id) {
      const part = partOf(id);
      if (!part || !owns(id)) return false;
      save().equip[part] = id;
      save().fresh = save().fresh.filter((x) => x !== id);
      return true;
    }
    function unequip(part) { if (PARTS.includes(part)) save().equip[part] = null; }

    /** Ce que le forgeron porte, au format du dessin (`S.person`). */
    function look() {
      const cat = catalog(), out = {}, s = save();
      for (const part of ["cape", "hat", "apron"]) {
        const item = cat.get(s.equip[part]);
        if (item && owns(item.id)) out[part] = item.value;
      }
      const w = cat.get(s.equip.weapon);
      if (w && owns(w.id)) out.item = `weapon:${w.weapon}:${w.rarity}`;
      return out;
    }

    /** Ramasse le butin que le serveur dit tombé, une seule fois par événement. */
    function claim(drops) {
      const s = save(), cat = catalog(), looted = new Set(s.looted);
      const fresh = drops.filter((d) => !looted.has(d.eventId) && cat.has(d.itemId));
      const firstRun = !s.lootInit;
      s.lootInit = true;
      if (!fresh.length) return;
      const given = firstRun ? fresh.slice(0, FIRST_RUN_LOOT) : fresh; // les plus récents d'abord
      for (const d of fresh) s.looted.push(d.eventId);
      if (s.looted.length > MAX_LOOTED) s.looted = s.looted.slice(-MAX_LOOTED);
      const ids = new Map();
      for (const d of given) { const id = dropId(d, cat); ids.set(d, id); add(id, "loot"); if (!s.fresh.includes(id)) s.fresh.push(id); }
      const best = [...given].sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity))[0];
      const rare = best && RARITIES.indexOf(best.rarity) >= 2;
      const after = catalog();
      /** Nom d'un objet tombé, avec la qualité du jet pour une arme : « Épée d'acier, bon jet ». */
      const label = (d) => { const item = after.get(ids.get(d)), card = cardOf(item); return `${item.name} (${rarityName(d.rarity)}${card && !card.standard ? `, ${card.label}` : ""})`; };
      if (given.length <= 3) for (const d of given) ctx.banner(`Butin : ${label(d)}`);
      else ctx.banner(`${given.length} objets de butin, dont ${label(best)}`);
      if (rare) ctx.sfx.fanfare(); else ctx.sfx.coin();
      ctx.renderHud();
      ctx.rerender();
    }

    /** Exemplaires qu'on peut échanger : ceux qui ne sont pas portés. */
    function freeCopies(id) { return count(id) - (isEquipped(id) ? 1 : 0); }
    function tradeValidity(giveIds, getId) {
      const cat = catalog();
      if (giveIds.length !== TRADE_COUNT) return { ok: false, why: `Choisis ${TRADE_COUNT} objets à donner.` };
      const rarity = cat.get(giveIds[0])?.rarity;
      if (!rarity || !NEXT[rarity]) return { ok: false, why: "Cette rareté ne s'échange pas plus haut." };
      const used = {};
      for (const id of giveIds) {
        used[id] = (used[id] || 0) + 1;
        if (cat.get(id)?.rarity !== rarity) return { ok: false, why: "Les trois objets donnés doivent avoir la même rareté." };
        if (used[id] > freeCopies(id)) return { ok: false, why: "Un objet porté ne s'échange pas." };
      }
      const target = cat.get(getId);
      if (!target || target.unique || target.rarity !== NEXT[rarity] || target.rank) return { ok: false, why: `Choisis un objet ${rarityName(NEXT[rarity]).toLowerCase()} à recevoir.` };
      return { ok: true, why: "" };
    }
    function trade(giveIds, getId) {
      if (!tradeValidity(giveIds, getId).ok) return false;
      const s = save();
      for (const id of giveIds) {
        s.items[id].n--;
        // Les origines suivent les exemplaires qui restent : on retire d'abord le butin, puis le reste
        const from = s.items[id].from;
        const src = ["loot", "trade", "bought", "prestige"].find((k) => from[k] > 0);
        if (src) from[src]--;
        if (s.items[id].n <= 0) delete s.items[id];
      }
      // Une arme reçue en échange est unique elle aussi : sa graine est tirée à l'instant de l'échange
      const received = catalog().get(getId)?.kind === "weapon" ? `${getId}#trade-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}` : getId;
      add(received, "trade");
      s.fresh.push(received);
      return true;
    }

    /** Petite image d'un objet : sa tenue sur un forgeron neutre, ou l'icône de l'arme. */
    function thumb(item) {
      if (item.kind === "weapon") return S.icon(item.weapon, item.rarity);
      if (!thumbs.has(item.id)) {
        const cv = document.createElement("canvas");
        cv.width = 20; cv.height = 28;
        const c = cv.getContext("2d");
        S.px(c, 0, 0, 20, 28, "#3a3345");
        S.person(c, 2, 6, { dir: item.part === "cape" ? "up" : "down", [item.part]: item.value });
        thumbs.set(item.id, cv.toDataURL());
      }
      return thumbs.get(item.id);
    }

    /* ---------- interface : inventaire et échange ---------- */
    const ui = { tab: "inv", cat: "all", give: [], get: null };

    /** Origine d'un objet en clair : « Obtenu, Acheté ». */
    const sourcesText = (id) => Object.keys(save().items[id]?.from || {}).filter((k) => save().items[id].from[k] > 0).map((k) => SOURCES[k] ?? k).join(", ");
    const quality = (item) => cardOf(item)?.quality ?? 0;
    const byRarity = (a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || quality(b) - quality(a) || a.name.localeCompare(b.name, "fr");

    /** Les valeurs d'une arme en une ligne : « 12 dégâts · 0,45 s · +3 Force, +2 Agilité ». */
    function weaponLine(card) {
      const bonus = card.lines.map((l) => `+${l.points} ${STAT_NAME[l.stat]}`).join(", ");
      return `${fmt(card.damage)} dégâts · ${fmt(card.cooldown)} s${bonus ? ` · ${bonus}` : ""}`;
    }
    /** Jauge de qualité du jet : de faible à exceptionnel. */
    const qualityHtml = (card) => card.standard ? "" : `<span class="fg-qual" title="Qualité du tirage de cette arme"><span class="fg-qbar"><i style="width:${Math.round(card.quality * 100)}%"></i></span>${esc(card.label)} · ${Math.round(card.quality * 100)} %</span>`;

    /** Les effets spéciaux d'une arme, un par ligne. */
    const affixesHtml = (card) => (card.affixes || []).map((a) => `<small class="fg-aff"><i></i>${esc(a.text)}</small>`).join("");

    /** Statistiques et bonus d'attaque d'une tenue (hors arme), s'il y en a : « +2 Force, +1 Chance », puis un effet par ligne. Rien sinon. */
    function gearHtml(item) {
      if (item.kind === "weapon") return "";
      const extras = window.ForgeCombat.gearExtras(item);
      const stats = extras.lines.map((l) => `+${l.points} ${STAT_NAME[l.stat]}`).join(", ");
      return `${stats ? `<small>${esc(stats)}</small>` : ""}${affixesHtml(extras)}`;
    }

    /** Les armes du sac, de la meilleure rareté à la moins bonne, pour les choisir depuis l'arène. */
    function weapons() {
      const cat = catalog();
      return [...cat.values()].filter((i) => i.kind === "weapon" && owns(i.id)).sort(byRarity).map((item) => ({ id: item.id, name: item.name, rarity: item.rarity, icon: thumb(item), card: cardOf(item), worn: isEquipped(item.id), line: weaponLine(cardOf(item)) }));
    }

    /** Les quatre emplacements du forgeron, avec l'icône de l'objet porté : affichés à côté de son aperçu. */
    function slotsHtml(cat) {
      return `<div class="fg-slots">${PARTS.map((part) => {
        const item = cat.get(save().equip[part]);
        const icon = item ? `<img class="fg-ithumb sm" src="${thumb(item)}" alt="">` : `<span class="fg-ithumb sm blank"></span>`;
        return `<div class="fg-slot ${item ? "" : "bare"}" ${item ? `style="--rc:${color(item.rarity)}"` : ""}>${icon}<div><small>${PART_NAME[part]}</small><b>${item ? esc(item.name) : "Vide"}</b></div>${item ? `<button type="button" class="fg-xs" data-it-unequip="${part}" title="Retirer" aria-label="Retirer ${esc(item.name)}"></button>` : ""}</div>`;
      }).join("")}</div>`;
    }

    function inventoryHtml() {
      const cat = catalog(), s = save();
      const all = [...cat.values()].filter((i) => !i.unique); // la collection : une case par modèle, pas par exemplaire d'arme
      const mine = [...cat.values()].filter((i) => owns(i.id));
      const shown = mine.filter((i) => ui.cat === "all" || i.part === ui.cat).sort(byRarity);
      const progress = RARITIES.map((r) => `<span><i style="background:${color(r)}"></i>${rarityName(r)} ${all.filter((i) => owns(i.id) && i.rarity === r).length}/${all.filter((i) => i.rarity === r).length}</span>`).join("");
      const filters = [["all", "Tout"], ...PARTS.map((p) => [p, PART_NAME[p]])].map(([k, label]) => `<button type="button" class="fg-fchip ${ui.cat === k ? "on" : ""}" data-it-cat="${k}">${label}</button>`).join("");
      const worn0 = cat.get(s.equip.weapon), ref = worn0 && owns(worn0.id) ? cardOf(worn0) : null;
      const cards = shown.map((item) => {
        const worn = isEquipped(item.id), isNew = s.fresh.includes(item.id), isWeapon = item.kind === "weapon";
        let detail = `<small>${tag(item.rarity)} · ${PART_NAME[item.part] ?? ""}</small>${gearHtml(item)}`;
        if (isWeapon) {
          // Une arme : son effet, ses valeurs, son jet, et la différence de dégâts par seconde avec l'arme portée
          const card = cardOf(item), diff = ref && !worn ? card.dps - ref.dps : 0;
          const delta = ref && !worn ? `<em class="${diff >= 0 ? "up" : "down"}">${diff >= 0 ? "+" : "-"}${fmt(Math.abs(Math.round(diff * 10) / 10))} dégâts/s</em>` : "";
          detail = `<small>${tag(item.rarity)} · Arme ${delta}</small><small>${esc(card.perk)}</small><small>${esc(weaponLine(card))} · ${fmt(card.dps)} dégâts/s</small>${affixesHtml(card)}${qualityHtml(card)}`;
        }
        return `<div class="fg-icard ${isWeapon ? "fg-wcard" : ""} ${worn ? "worn" : ""}" style="--rc:${color(item.rarity)}"><img src="${thumb(item)}" alt="" class="fg-ithumb">
          <div><div class="fg-icard-name"><b title="${esc(item.name)}">${esc(item.name)}</b>${count(item.id) > 1 ? `<em>×${count(item.id)}</em>` : ""}</div>
          ${detail}<small class="fg-origin">${esc(sourcesText(item.id))}</small></div>${isNew ? '<span class="fg-new">nouveau</span>' : ""}
          <button type="button" class="fg-mini" data-it-${worn ? "unequip" : "equip"}="${worn ? item.part : esc(item.id)}">${worn ? "Retirer" : "Équiper"}</button></div>`;
      }).join("");
      // L'en-tête (progression et filtres) reste en haut pendant que la liste défile
      const weaponNote = mine.some((i) => i.kind === "weapon") ? `<p class="fg-note">Chaque arme est unique : ses dégâts, sa cadence, ses bonus et ses effets sont tirés au hasard dans la fourchette de sa rareté. Les dégâts par seconde (sans tes caractéristiques ni les critiques) permettent de comparer.</p>` : "";
      return `<div class="fg-sticky"><div class="fg-prog">${progress}</div><div class="fg-fchips">${filters}</div></div>
        ${weaponNote}<div class="fg-igrid">${cards || `<p class="fg-empty">Rien ici pour l'instant. Les objets s'obtiennent en forgeant des pièces, en faisant relire et fusionner tes pièces (butin aléatoire), un peu en créant un projet, chez le marchand, ou à l'établi d'échange de la forge.</p>`}</div>`;
    }

    function tradeHtml() {
      const cat = catalog(), all = [...cat.values()];
      const rarity = ui.give.length ? cat.get(ui.give[0])?.rarity : null;
      const tradable = all.filter((i) => owns(i.id) && NEXT[i.rarity] && freeCopies(i.id) > 0 && (!rarity || i.rarity === rarity)).sort(byRarity);
      const chosen = (id) => ui.give.filter((x) => x === id).length;
      const give = tradable.map((item) => `<button type="button" class="fg-pick ${chosen(item.id) ? "on" : ""}" style="--rc:${color(item.rarity)}" data-it-give="${esc(item.id)}"><img src="${thumb(item)}" alt=""><span><b>${esc(item.name)}</b><small>${tag(item.rarity)} · ${freeCopies(item.id) - chosen(item.id)} libre${freeCopies(item.id) - chosen(item.id) > 1 ? "s" : ""}${chosen(item.id) ? ` · ${chosen(item.id)} donné${chosen(item.id) > 1 ? "s" : ""}` : ""}</small></span></button>`).join("");
      const targetRarity = rarity ? NEXT[rarity] : null;
      const rewards = targetRarity ? all.filter((i) => i.rarity === targetRarity && !i.rank && !i.unique).sort(byRarity) : [];
      const want = rewards.map((item) => `<button type="button" class="fg-pick ${ui.get === item.id ? "on" : ""}" style="--rc:${color(item.rarity)}" data-it-get="${esc(item.id)}"><img src="${thumb(item)}" alt=""><span><b>${esc(item.name)}</b><small>${tag(item.rarity)} · ${PART_NAME[item.part] ?? ""}${owns(item.id) ? ` · tu en as ${count(item.id)}` : ""}</small></span></button>`).join("");
      const check = tradeValidity(ui.give, ui.get ?? "");
      const left = `<section><h4>Je donne (${ui.give.length}/${TRADE_COUNT})${ui.give.length ? `<button type="button" class="fg-mini" data-it-clear>Vider</button>` : ""}</h4>
        <div class="fg-picks">${give || `<p class="fg-empty">Aucun objet à échanger : il faut des exemplaires non portés, communs, rares ou épiques.</p>`}</div></section>`;
      const right = `<section><h4>Je reçois${targetRarity ? ` · ${esc(rarityName(targetRarity).toLowerCase())}` : ""}</h4>
        ${targetRarity ? `<div class="fg-picks">${want}</div>` : `<p class="fg-empty">Choisis d'abord les objets à donner : les objets de la rareté au-dessus s'afficheront ici.</p>`}</section>`;
      return `<p class="fg-note">Échange ${TRADE_COUNT} objets de la même rareté contre <b>1 objet de la rareté au-dessus, que tu choisis</b>. Les objets portés ne s'échangent pas.</p>
        <div class="fg-trade">${left}${right}</div>
        <div class="fg-trade-bar"><button type="button" class="fg-btn" data-it-trade ${check.ok ? "" : "disabled"}>Échanger</button>${check.ok || !ui.give.length ? "" : `<span class="fg-note">${esc(check.why)}</span>`}</div>`;
    }

    /** Avancement de la collection : objets différents possédés sur le total du catalogue. */
    function collection() {
      const all = [...catalog().values()].filter((i) => !i.unique);
      return { owned: all.filter((i) => owns(i.id)).length, total: all.length };
    }

    /** Ce que le forgeron porte, emplacement par emplacement : affiché à côté de son aperçu, sur les onglets du profil. */
    const equippedHtml = () => slotsHtml(catalog());

    /** Contenu des onglets « Inventaire » et « Échange » de la page du personnage. */
    function panelHtml(tab) {
      ui.tab = tab;
      return tab === "trade" ? tradeHtml() : inventoryHtml();
    }

    /** Clics du panneau. @returns Vrai si le clic était pour les objets. */
    function onClick(ev) {
      const by = (attr) => ev.target.closest(`[${attr}]`);
      let el;
      if ((el = by("data-it-equip"))) { equip(el.dataset.itEquip); ctx.sfx.select(); }
      else if ((el = by("data-it-unequip"))) { unequip(el.dataset.itUnequip); ctx.sfx.select(); }
      else if ((el = by("data-it-cat"))) { ui.cat = el.dataset.itCat; ctx.sfx.select(); }
      else if ((el = by("data-it-give"))) {
        const id = el.dataset.itGive;
        if (ui.give.length && ui.give.filter((x) => x === id).length >= freeCopies(id)) ui.give = ui.give.filter((x) => x !== id);
        else if (ui.give.length < TRADE_COUNT) ui.give.push(id);
        ui.get = null;
        ctx.sfx.select();
      }
      else if ((el = by("data-it-get"))) { ui.get = ui.get === el.dataset.itGet ? null : el.dataset.itGet; ctx.sfx.select(); }
      else if (by("data-it-clear")) { ui.give = []; ui.get = null; }
      else if (by("data-it-trade")) {
        const cat = catalog(), target = cat.get(ui.get);
        if (trade([...ui.give], ui.get)) {
          ctx.banner(`Échange réussi : ${target.name} (${rarityName(target.rarity)})`);
          ctx.sfx.fanfare();
          ui.give = []; ui.get = null;
        } else ctx.sfx.error();
      }
      else return false;
      ctx.persist();
      ctx.redraw();
      ctx.rerender();
      return true;
    }

    /** Objets nouveaux (butin ou échange pas encore vus dans le sac). */
    const freshCount = () => save().fresh.length;
    function markSeen() { save().fresh = []; }

    return { catalog, migrate, count, owns, isEquipped, add, equip, unequip, look, claim, tradeValidity, trade, thumb, panelHtml, equippedHtml, collection, onClick, freshCount, markSeen, rarityName, color, weapons, ui };
  }

  window.ForgeItems = { create, RARITIES, NEXT, PART_NAME, TRADE_COUNT };
})();
