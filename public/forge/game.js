/* La forge : un petit monde 2D jouable. Le personnage se balade case par case, parle aux PNJ (les agents), touche les objets (fours, râtelier,
   pierre d'éveil...) qui ouvrent les vrais réglages dans des popups. Tout est déduit de l'état réel de l'outil ; la progression de jeu
   (nom, apparence, or, tenues, type d'arme par projet) est gardée dans ce navigateur. */
(() => {
  "use strict";
  const S = window.ForgeSprites, A = window.ForgeAudio, C = window.ForgeCombat;
  const T = S.T, W = 24, H = 15, SAVE_KEY = "ra.game.v1";
  const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const KEY_DIR = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", z: "up", w: "up", s: "down", q: "left", a: "left", d: "right" };
  const SKINS = ["#f2c9a0", "#d9a066", "#8d5a3b"];
  const HAIRS = ["#3a2a1c", "#c9a227", "#23252b", "#8a3b12", "#e8e4da"];
  const TUNICS = ["#3e6fb0", "#b0503e", "#3e9a6a", "#8a5cb0", "#d8a63a", "#2f7a8a"];
  const ANVIL_X = [8, 10, 13, 15];
  /** Tenues à acheter chez le marchand : un décor de jeu, sans effet sur l'outil. */
  const COSMETICS = [
    { id: "cape", rarity: "common", name: "Cape rouge", price: 120, part: "cape", value: "#b0302e" },
    { id: "helm", rarity: "rare", name: "Casque de cuivre", price: 200, part: "hat", value: "copper" },
    { id: "apron", rarity: "epic", name: "Tablier doré", price: 400, part: "apron", value: "#d8a63a" },
    // Tenues réservées à un rang de prestige : offertes dès que le rang est atteint
    { id: "cape-silver", rarity: "rare", name: "Cape d'argent", price: 0, part: "cape", value: "#c8d0dc", rank: "silver" },
    { id: "apron-gold", rarity: "epic", name: "Tablier de maître", price: 0, part: "apron", value: "#f4c542", rank: "gold" },
    { id: "helm-mithril", rarity: "epic", name: "Heaume de mithril", price: 0, part: "hat", value: "helmet", rank: "mithril" },
    { id: "cape-violet", rarity: "legendary", name: "Cape d'orichalque", price: 0, part: "cape", value: "#7a3fc4", rank: "orichalcum" },
  ];
  const RANK_ORDER = ["iron", "bronze", "silver", "gold", "mithril", "orichalcum"];
  const rect = (x, y, w, h) => { const out = []; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push([i, j]); return out; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- progression de jeu, dans ce navigateur ---------- */
  const freshSave = () => ({ v: 1, name: "", look: { skin: SKINS[0], hair: HAIRS[1], tunic: TUNICS[0] }, gold: 0, sold: [], owned: [], worn: {}, weapons: {}, seen: [], lastLevel: 0, created: false, intro: false, claimed: {}, lastRank: "", stats: { force: 0, agilite: 0, vitalite: 0, chance: 0 }, arena: { met: false, bestWave: 0, wins: 0, fights: 0, day: "", goldToday: 0 } });
  function loadSave() {
    const save = freshSave();
    try {
      const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || "{}");
      Object.assign(save, raw, { look: { ...save.look, ...(raw.look || {}) } });
    } catch { /* stockage indisponible ou illisible : on repart de zéro */ }
    for (const k of ["sold", "owned", "seen"]) if (!Array.isArray(save[k])) save[k] = [];
    for (const k of ["worn", "weapons", "claimed"]) if (!save[k] || typeof save[k] !== "object" || Array.isArray(save[k])) save[k] = {};
    if (typeof save.lastRank !== "string") save.lastRank = "";
    // Caractéristiques et arène : remises en forme (le plafond de points suit le niveau, il est appliqué à chaque lecture)
    save.stats = C.normalizeStats(save.stats, 99);
    const plain = (v) => v && typeof v === "object" && !Array.isArray(v);
    save.arena = { ...freshSave().arena, ...(plain(save.arena) ? save.arena : {}) };
    for (const k of ["bestWave", "wins", "fights", "goldToday"]) if (!Number.isFinite(save.arena[k]) || save.arena[k] < 0) save.arena[k] = 0;
    if (typeof save.arena.day !== "string") save.arena.day = "";
    // Les réclamations anciennes ne servent plus (une mission est liée à son jour) : on ne garde que les plus récentes
    const keys = Object.keys(save.claimed);
    if (keys.length > 80) for (const key of keys.slice(0, keys.length - 60)) delete save.claimed[key];
    return save;
  }

  const g = {
    root: null, stage: null, canvas: null, c: null, el: {},
    pieces: [], piecesAt: -999, play: false,
    roomId: "forge", rooms: { catalog: null, list: [], byId: new Map(), problems: [], template: null, at: -999 }, deco: [], transition: false,
    running: false, raf: 0, last: 0, time: 0, poll: 0,
    save: loadSave(), data: { hero: null, armory: { weapons: [], loot: [] }, forges: [] }, firstRefresh: true, done: null,
    player: { tx: 12, ty: 11, x: 12 * T, y: 11 * T, dir: "up", frame: 0, moving: null, path: [] },
    keys: [], fx: [], entities: [], dlg: null, popup: false, custom: null, labelEls: new Map(), hover: null, lastBump: 0, lastFire: 0, hammer: new Map(),
  };
  const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(g.save)); } catch { /* stockage indisponible */ } };
  /** Objets du forgeron : sac, équipement, butin, échanges (public/forge/items.js). */
  const items = window.ForgeItems.create(g, { baseItems: COSMETICS, persist, banner: (t) => banner(t), sfx: A.sfx, renderHud: () => renderHud(), rerender: () => g.customUi?.rerender(), redraw: () => g.customUi?.redraw() });
  items.migrate();

  /* ---------- données réelles ---------- */
  const flag = (id) => g.data.hero?.quests.some((q) => q.id === id && q.done) ?? false;
  /** Quêtes de départ puis quêtes de l'atelier (dessiner une salle...) : une seule liste à l'affichage. */
  const allQuests = (h) => [...(h?.quests ?? []), ...(h?.extraQuests ?? [])];
  const lit = (kind) => g.data.forges.includes(kind);
  const hasLoot = () => g.data.armory.loot.length > 0 || g.save.sold.length > 0;
  const modal = () => Boolean(g.dlg || g.popup || g.custom || g.transition || g.play);

  /* ---------- série, missions, prestige : ce qui donne envie de revenir (calculé par le serveur) ---------- */
  const progress = () => g.data.hero?.progress ?? null;
  const prestige = () => g.data.hero?.prestige ?? null;
  const rankIndex = () => Math.max(0, RANK_ORDER.indexOf(prestige()?.rank.id ?? "iron"));
  /** Bonus d'or du rang chez le marchand, en pourcent. */
  const goldBonus = () => prestige()?.rank.goldBonusPct ?? 0;
  const missionList = () => { const p = progress(); return p ? [...p.daily, p.chest, ...p.weekly] : []; };
  const claimKey = (m) => `${m.id}@${m.period}`;
  const claimable = () => missionList().filter((m) => m.done && !g.save.claimed[claimKey(m)]);
  /** Réclame l'or de missions accomplies (`keys` : leurs clés, ou rien pour tout réclamer). @returns L'or gagné. */
  function claim(keys) {
    let total = 0;
    for (const m of claimable()) {
      if (keys && !keys.includes(claimKey(m))) continue;
      g.save.claimed[claimKey(m)] = true;
      total += m.gold;
    }
    if (!total) return 0;
    g.save.gold += total;
    persist(); A.sfx.coin(); renderHud();
    banner(`+${total} or : récompenses réclamées.`);
    return total;
  }

  /** Type d'arme d'un projet : celui fixé à sa création (calculé par le serveur, il ne change jamais). */
  function weaponType(weapon) {
    return S.TYPES.some((t) => t.id === weapon.weaponType) ? weapon.weaponType : S.TYPES[0].id;
  }
  const rackWeapons = () => g.data.armory.weapons.slice(0, 6).map((w) => [weaponType(w), w.grade]);
  const playerLook = () => ({ ...g.save.look, ...items.look() });

  /* ---------- caractéristiques et arène (la logique du combat est dans public/forge/combat.js) ---------- */
  const ARENA_ROOM = "arene", ARENA_MASTER = "maitre-armes", ARENA_GATE_X = 18, ARENA_DAILY_GOLD = 150;
  const heroLevel = () => g.data.hero?.level ?? 1;
  /** L'équipement porté, tel que le combat le lit : l'arme (type, rareté, graine) et pour chaque tenue sa rareté, ses statistiques et ses bonus d'attaque. */
  function arenaEquipment() {
    const cat = items.catalog(), out = {};
    for (const slot of Object.keys(C.SLOT_STAT)) {
      const id = g.save.equip?.[slot], item = id && items.owns(id) ? cat.get(id) : null;
      if (item) out[slot] = slot === "weapon" ? { type: item.weapon, rarity: item.rarity, seed: item.seed } : { rarity: item.rarity, stats: item.stats, affixes: item.affixes };
    }
    return out;
  }
  const combatBuild = () => C.build({ level: heroLevel(), stats: g.save.stats, equipment: arenaEquipment() });
  const pointsLeft = () => C.pointsFor(heroLevel()) - C.spent(C.normalizeStats(g.save.stats, heroLevel()));
  /** Ajoute (+1) ou retire (-1) un point de caractéristique. Les points ne dépassent jamais le niveau. */
  function setStat(id, delta) {
    if (!C.STAT_IDS.includes(id)) return false;
    const cur = C.normalizeStats(g.save.stats, heroLevel());
    if (delta > 0 && pointsLeft() <= 0) return false;
    if (delta < 0 && cur[id] <= 0) return false;
    cur[id] += delta;
    g.save.stats = cur;
    persist();
    return true;
  }
  const resetStats = () => { g.save.stats = C.normalizeStats({}, 1); persist(); };

  /* ---------- le monde ---------- */
  function buildEntities() {
    const E = [];
    const add = (e) => E.push({ solid: true, ...e });
    add({ id: "brann", name: "Maître Brann", verb: "Parler", tiles: [[11, 10]], z: 11 * T, lx: 11.5, ly: 9.35, always: true, draw: (c) => S.person(c, 11 * T, 10 * T, { ...S.LOOKS.brann, dir: "down" }), interact: brannTalk });
    add({ id: "furnace-github", name: "Forge GitHub", verb: "Forger", tiles: rect(2, 1, 4, 3), z: 4 * T, lx: 4, ly: 4.35, always: true, draw: (c, t) => S.furnace(c, 2, 1, lit("github"), t), interact: () => furnaceTalk("github") });
    add({ id: "furnace-gitlab", name: "Forge GitLab", verb: "Forger", tiles: rect(18, 1, 4, 3), z: 4 * T, lx: 20, ly: 4.35, always: true, draw: (c, t) => S.furnace(c, 18, 1, lit("gitlab"), t), interact: () => furnaceTalk("gitlab") });
    add({ id: "board", name: "Tableau des quêtes", verb: "Lire", tiles: rect(11, 1, 2, 2), z: 3 * T, lx: 12, ly: 3.4, always: true, draw: (c) => S.board(c, 11, 1), interact: () => openPopup("board") });
    add({ id: "stone", name: "Pierre d'éveil", verb: "Toucher", tiles: [[6, 3], [6, 4]], z: 5 * T + 12, lx: 6.5, ly: 3.1, when: () => flag("forge"), draw: (c, t) => S.stone(c, 6, 3, flag("claude"), t), interact: () => openPopup("stone") });
    add({ id: "rack", name: "Râtelier", verb: "Choisir", tiles: rect(1, 5, 6, 2), z: 7 * T, lx: 4, ly: 4.85, when: () => flag("forge"), draw: (c) => S.rack(c, 1, 5, rackWeapons()), interact: rackTalk });
    add({ id: "anvils", tiles: ANVIL_X.map((x) => [x, 7]), z: 8 * T, when: () => flag("forge"), decor: true, draw: (c) => ANVIL_X.forEach((x) => S.anvil(c, x, 7)) });
    add({ id: "crates", tiles: [[22, 5], [22, 6], [1, 13]], z: 7 * T, when: () => flag("forge"), decor: true, draw: (c) => { S.barrel(c, 22, 5); S.crate(c, 22, 6); S.barrel(c, 1, 13); } });
    add({ id: "merchant", name: "Marchand Sélim", verb: "Commercer", tiles: rect(17, 7, 6, 3), z: 10 * T, lx: 19.5, ly: 4.6, when: hasLoot, draw: (c) => { S.person(c, 19 * T, 5 * T, { ...S.LOOKS.marchand, dir: "down" }); S.stall(c, 17, 7); }, interact: merchantTalk });
    add({ id: "apprentice", name: "Apprenti", verb: "Parler", tiles: [[9, 12]], z: 13 * T, lx: 9.5, ly: 11.35, when: () => flag("claude"), draw: (c) => S.person(c, 9 * T, 12 * T, { ...S.LOOKS.apprenti, dir: "right" }), interact: apprenticeTalk });
    add({ id: "guard", name: "Maître juré", verb: "Parler", tiles: [[4, 8]], z: 9 * T, lx: 4.5, ly: 7.35, when: () => flag("project"), draw: (c) => S.person(c, 4 * T, 8 * T, { ...S.LOOKS.gardien, dir: "down" }), interact: guardTalk });
    add({ id: "scribe", name: "Scribe", verb: "Parler", tiles: [[13, 4]], z: 5 * T, lx: 13.5, ly: 3.35, when: () => flag("forge"), draw: (c) => S.person(c, 13 * T, 4 * T, { ...S.LOOKS.scribe, dir: "up" }), interact: scribeTalk });
    add({ id: "architect", name: "Architecte", verb: "Parler", tiles: [[6, 11]], z: 12 * T, lx: 6.5, ly: 10.35, when: () => flag("forge"), draw: (c) => S.person(c, 6 * T, 11 * T, { ...S.LOOKS.architecte, dir: "left" }), interact: architectTalk });
    /** Décor plein d'un coin du hall : visible avec la forge, il bloque le passage comme les autres meubles. */
    const deco = (id, tiles, z, draw) => add({ id, tiles, z, when: () => flag("forge"), decor: true, draw });
    const obj = (type, x, y) => (c, t) => S.drawObject(c, { type, x, y }, t);
    // Armurerie (en haut à gauche) : râtelier, mannequin d'entraînement, armure
    deco("armory-dummy", [[1, 8], [1, 9]], 10 * T, obj("dummy", 1, 8));
    deco("armory-armor", [[6, 8], [6, 9]], 10 * T, obj("armorstand", 6, 8));
    // Scriptorium (en bas à gauche) : table de travail, chaises, plantes, coffre d'archives
    deco("scriptorium-table", rect(2, 11, 3, 2), 13 * T, obj("table", 2, 11));
    deco("scriptorium-chairs", [[2, 13], [4, 13]], 14 * T, (c, t) => { S.drawObject(c, { type: "chair", x: 2, y: 13 }, t); S.drawObject(c, { type: "chair", x: 4, y: 13 }, t); });
    deco("scriptorium-plants", [[1, 10], [7, 10]], 11 * T, (c, t) => { S.drawObject(c, { type: "plant", x: 1, y: 10 }, t); S.drawObject(c, { type: "plant", x: 7, y: 10 }, t); });
    deco("scriptorium-chest", [[7, 13]], 14 * T, obj("chest", 7, 13));
    // Entrée de l'arène (en bas à droite) : deux braseros de part et d'autre de la herse, un mannequin
    deco("arena-braziers", [[17, 13], [20, 13]], 14 * T, (c, t) => { S.drawObject(c, { type: "brazier", x: 17, y: 13 }, t); S.drawObject(c, { type: "brazier", x: 20, y: 13 }, t); });
    deco("arena-dummy", [[22, 12], [22, 13]], 14 * T, obj("dummy", 22, 12));
    // Atelier (au centre) : deux braseros au pied du tapis, une plante près de la pierre d'éveil
    deco("atelier-braziers", [[8, 13], [15, 13]], 14 * T, (c, t) => { S.drawObject(c, { type: "brazier", x: 8, y: 13 }, t); S.drawObject(c, { type: "brazier", x: 15, y: 13 }, t); });
    deco("atelier-plant", [[7, 3]], 4 * T, obj("plant", 7, 3));
    // Établi d'échange (en haut à droite, près des portails) : trois objets de même rareté contre un de la rareté au-dessus
    add({ id: "trade-bench", name: "Établi d'échange", verb: "Échanger", tiles: [[16, 4], [17, 4]], z: 5 * T, lx: 17, ly: 3.6, when: () => flag("forge"), draw: (c, t) => S.tradebench(c, 16, 4, t), interact: () => openCustomizer(false, "trade", { solo: true, title: "L'établi d'échange" }) });
    add({ id: "door", name: "Porte", verb: "Sortir", tiles: [[11, 14], [12, 14]], z: 0, lx: 12, ly: 13.7, always: true, decor: true, draw: () => undefined, interact: doorTalk });
    add({ id: "arena-gate", portal: true, name: "Arène", verb: "Entrer", tiles: [[ARENA_GATE_X, 14], [ARENA_GATE_X + 1, 14]], z: 0, lx: ARENA_GATE_X + 1, ly: 13.7, when: () => flag("project") && g.rooms.byId.has(ARENA_ROOM), draw: (c, t) => S.ironGate(c, ARENA_GATE_X, H, t), interact: arenaGateTalk });
    hubRooms().forEach((room, i) => {
      const x = HUB_SLOTS[i];
      add({ id: "portal-" + room.id, portal: true, name: room.name, verb: "Entrer", tiles: [[x, 2], [x + 1, 2]], z: 3 * T, lx: x + 1, ly: 3.4, when: () => flag("forge"), draw: (c, t) => S.hubDoor(c, x, 1, t), interact: () => portalTalk(room) });
    });
    return E;
  }

  /** Les apprentis au travail : un par agent actif (tâche ou review), à son enclume. */
  function workerEntities() {
    const looks = [S.LOOKS.apprenti, S.LOOKS.apprenti2, S.LOOKS.apprenti3, S.LOOKS.apprenti];
    return (g.data.hero?.workers ?? []).slice(0, ANVIL_X.length).map((w, i) => {
      const ax = ANVIL_X[i];
      return {
        id: `worker-${w.id}`, name: w.label, verb: "Voir", worker: w, slot: i, tiles: [[ax, 6]], z: 7 * T, lx: ax + 0.5, ly: 5.55, always: true, solid: true, bubble: w.line,
        interact: () => openPopup("worker", { worker: w }),
        draw: (c, t) => {
          const working = w.state === "working";
          const swing = working && Math.floor(t * 2.2 + i * 0.37) % 2 === 1;
          S.person(c, ax * T, 6 * T, { ...looks[i], dir: "down", frame: swing ? 1 : 0, item: working || w.state === "done" ? "hammer" : null });
          if (working) S.sparks(c, ax * T + 8, 7 * T + 6, t + i * 0.3);
        },
      };
    });
  }

  const isVisible = (e) => e.always || (e.when ? e.when() : true);
  const entityAt = (tx, ty) => g.entities.find((e) => isVisible(e) && e.tiles.some(([x, y]) => x === tx && y === ty)) ?? null;
  const free = (tx, ty) => {
    if (tx < 0 || tx >= W || ty < 3 || ty >= H - 1) return false;
    const e = entityAt(tx, ty);
    return !(e && e.solid);
  };
  const front = () => { const [dx, dy] = DIRS[g.player.dir]; return entityAt(g.player.tx + dx, g.player.ty + dy); };

  /* ---------- déplacements ---------- */
  function tryStep(dir) {
    const p = g.player;
    p.dir = dir;
    const [dx, dy] = DIRS[dir], nx = p.tx + dx, ny = p.ty + dy;
    if (!free(nx, ny)) {
      if (g.time - g.lastBump > 0.28) { g.lastBump = g.time; A.sfx.bump(); }
      return false;
    }
    p.moving = { fx: p.x, fy: p.y, tx: nx * T, ty: ny * T, k: 0 };
    p.tx = nx; p.ty = ny;
    return true;
  }
  function bfs(sx, sy, gx, gy) {
    const q = [[sx, sy]], from = new Map([[`${sx},${sy}`, null]]);
    while (q.length) {
      const [x, y] = q.shift();
      if (x === gx && y === gy) break;
      for (const d of Object.keys(DIRS)) {
        const nx = x + DIRS[d][0], ny = y + DIRS[d][1], k = `${nx},${ny}`;
        if (!from.has(k) && free(nx, ny)) { from.set(k, [x, y, d]); q.push([nx, ny]); }
      }
    }
    const out = [];
    let cur = from.has(`${gx},${gy}`) ? [gx, gy] : null;
    while (cur && from.get(`${cur[0]},${cur[1]}`)) { const [px, py, d] = from.get(`${cur[0]},${cur[1]}`); out.unshift(d); cur = [px, py]; }
    return out;
  }
  /** Marche jusqu'à une case, ou jusqu'à côté d'un objet puis lui parle. */
  function walkTo(tx, ty) {
    const p = g.player, target = entityAt(tx, ty);
    let gx = tx, gy = ty;
    if (!free(tx, ty)) {
      // Une case occupée : on va à la case libre la plus proche autour de l'objet (ou du mur)
      const tiles = target ? target.tiles : [[tx, ty]];
      const around = tiles.flatMap(([x, y]) => Object.values(DIRS).map(([dx, dy]) => [x + dx, y + dy])).filter(([x, y]) => free(x, y));
      const best = around
        .map(([x, y]) => ({ x, y, len: x === p.tx && y === p.ty ? 0 : bfs(p.tx, p.ty, x, y).length || Infinity }))
        .filter((c) => c.len !== Infinity)
        .sort((a, b) => a.len - b.len)[0];
      if (!best) return;
      gx = best.x; gy = best.y;
    }
    const steps = gx === p.tx && gy === p.ty ? [] : bfs(p.tx, p.ty, gx, gy);
    if (!steps.length && (gx !== p.tx || gy !== p.ty)) return;
    p.path = steps;
    if (target) p.path.push(`face:${target.id}`);
  }
  function faceEntity(id) {
    const p = g.player;
    for (const d of Object.keys(DIRS)) {
      const e = entityAt(p.tx + DIRS[d][0], p.ty + DIRS[d][1]);
      if (e && e.id === id) { p.dir = d; return true; }
    }
    return false;
  }

  /* ---------- dialogues à la Pokémon ---------- */
  function startDialog(dlg) {
    g.dlg = { speaker: "", lines: [], i: 0, shown: 0, options: null, sel: 0, timer: 0, ...dlg };
    g.player.path = [];
    const el = g.el.dialog;
    el.hidden = false;
    el.querySelector(".fg-who").textContent = g.dlg.speaker;
    el.querySelector(".fg-who").hidden = !g.dlg.speaker;
    showLine();
  }
  function showLine() {
    const d = g.dlg, text = d.lines[d.i];
    d.shown = 0;
    g.el.dialog.querySelector(".fg-options").innerHTML = "";
    g.el.dialog.querySelector(".fg-more").hidden = true;
    clearInterval(d.timer);
    d.timer = setInterval(() => {
      d.shown = Math.min(text.length, d.shown + 1);
      g.el.dialog.querySelector(".fg-text").textContent = text.slice(0, d.shown);
      if (d.shown % 2 === 0 && text[d.shown - 1] !== " ") A.sfx.blip((d.speaker.length + d.shown) % 5);
      if (d.shown >= text.length) { clearInterval(d.timer); lineDone(); }
    }, 22);
  }
  function lineDone() {
    const d = g.dlg, last = d.i >= d.lines.length - 1;
    if (last && d.options) renderOptions();
    else g.el.dialog.querySelector(".fg-more").hidden = false;
  }
  function renderOptions() {
    const d = g.dlg;
    g.el.dialog.querySelector(".fg-options").innerHTML = d.options.map((o, i) => `<button type="button" class="fg-opt ${i === d.sel ? "on" : ""}" data-opt="${i}">${esc(o)}</button>`).join("");
  }
  function endDialog(result) {
    const d = g.dlg;
    if (!d) return;
    clearInterval(d.timer);
    g.dlg = null;
    g.el.dialog.hidden = true;
    d.resolve(result);
  }
  function advance() {
    const d = g.dlg;
    if (!d) return;
    const text = d.lines[d.i];
    if (d.shown < text.length) { clearInterval(d.timer); d.shown = text.length; g.el.dialog.querySelector(".fg-text").textContent = text; lineDone(); return; }
    if (d.i < d.lines.length - 1) { d.i++; A.sfx.select(); showLine(); return; }
    if (d.options) { A.sfx.select(); endDialog(d.sel); return; }
    endDialog(0);
  }
  const say = (speaker, lines) => new Promise((resolve) => startDialog({ speaker, lines: [].concat(lines), resolve }));
  const choose = (speaker, text, options) => new Promise((resolve) => startDialog({ speaker, lines: [text], options, resolve }));

  /* ---------- toucher, parler ---------- */
  async function interact() {
    if (g.dlg) return advance();
    if (modal()) return;
    const e = front();
    if (!e || !e.interact) return;
    A.sfx.select();
    g.player.path = [];
    await e.interact(e);
  }

  const openPopup = (id, params = {}) => window.ForgePopups.open(id, params, api2);

  async function brannTalk() {
    const name = g.save.name || "forgeron", h = g.data.hero;
    if (!g.save.intro) {
      await say("Maître Brann", [
        `Te voilà, ${name}. Bienvenue dans ma forge.`,
        "Elle est vide, pour l'instant. Vois ces deux fours froids : ce sont tes forges. GitHub à gauche, GitLab à droite.",
        "Chaque projet que tu confieras à tes apprentis deviendra une arme, plus belle à mesure qu'ils travaillent.",
        "Marche avec les flèches (ou ZQSD), parle et touche avec E. Commence par un four : il s'allume avec un jeton.",
      ]);
      g.save.intro = true;
      persist();
      return;
    }
    const lines = {
      forge: ["Un four t'attend. Approche-toi et appuie sur E pour le forger : il lui faut un jeton."],
      claude: ["Tes fours chauffent. Réveille maintenant tes apprentis : touche la Pierre d'éveil, près du mur."],
      project: ["Pose ta première arme au râtelier, à gauche : choisis un projet à forger."],
      dev: ["Ton arme est posée. Au râtelier, autorise l'agent dev sur ce projet : tes apprentis pourront forger."],
      task: ["Parle à l'Apprenti : confie-lui un ticket. Tu le verras travailler à l'enclume."],
      review: ["Va voir le Maître juré : il contrôle les lames des autres, les revues de demandes de fusion."],
    }[h?.nextQuest ?? ""];
    if (lines) return say("Maître Brann", lines);
    const atelier = (h?.extraQuests ?? []).find((q) => !q.done);
    if (atelier) return say("Maître Brann", ["Ma forge est allumée, bravo. Maintenant, laisse parler ton imagination : va voir l'Architecte, en bas à gauche.", "Dis-lui la salle que tu rêves, et même un jeu : il la dessine, tu la visites, tu y joues. Elle reste à toi tant que tu ne la partages pas."]);
    if (flag("project") && g.rooms.byId.has(ARENA_ROOM) && !g.save.arena.met) return say("Maître Brann", ["Tu as une arme au râtelier : tu peux la mettre à l'épreuve. Vois la herse de fer, en bas à droite : c'est l'arène.", "Le Maître d'armes t'y apprendra à répartir tes points de caractéristique et à te battre contre des bots."]);
    const forged = g.data.armory.loot.length, pg = progress(), pr = prestige();
    const out = [`Niveau ${h?.level ?? 1}, rang ${pr?.rank.name ?? "Fer"}, ${forged} pièce${forged > 1 ? "s" : ""} forgée${forged > 1 ? "s" : ""}. Ma forge n'a jamais tourné aussi bien.`];
    const waiting = claimable().length;
    const open = pg ? [...pg.daily, ...pg.weekly].find((m) => !m.done) : null;
    if (waiting) out.push(`Des récompenses t'attendent au tableau : ${waiting} mission${waiting > 1 ? "s" : ""} à réclamer.`);
    else if (open) out.push(`Au tableau : « ${open.title} », ${open.progress}/${open.target}. Un peu d'or à la clé.`);
    if (pg?.streak.atRisk) out.push(`Ta série de ${pg.streak.current} jour${pg.streak.current > 1 ? "s" : ""} s'éteint ce soir. Une pièce ou une lame contrôlée, et la flamme tient.`);
    else if (pr?.next) out.push(`Encore ${pr.next.xpLeft} XP pour le rang ${pr.next.name}.`);
    await say("Maître Brann", out);
  }
  async function furnaceTalk(kind) {
    if (!lit(kind)) await say("", ["Le four est froid.", "Il lui faut un jeton pour s'allumer."]);
    openPopup("forge", { kind });
  }
  async function rackTalk() {
    if (!g.data.armory.weapons.length) await say("", ["Le râtelier est vide.", "Choisis un projet à forger : il deviendra ta première arme."]);
    openPopup("rack");
  }
  async function apprenticeTalk() {
    await say("Apprenti", ["Patron ! Quel ticket je forge ?"]);
    openPopup("tickets");
  }
  /** Pièces forgées qui attendent (relecture ou fusion), relues chez le serveur toutes les 45 s, pour le repère du Maître juré. */
  async function loadPieces() {
    g.piecesAt = g.time;
    try { g.pieces = await api("/api/pieces"); } catch { /* le Maître juré reste muet : la forge fonctionne sans */ }
  }
  const piecesReady = () => g.pieces.filter((p) => p.readiness && p.readiness.ok);
  const piecesUnread = () => g.pieces.filter((p) => !p.review || p.review.current === false);
  /** Fusionne une pièce que le Maître juré vient de proposer : le choix du dialogue est la confirmation. */
  async function mergePieceNow(p) {
    try {
      await api(`/api/tasks/${p.taskId}/merge`, {});
      A.sfx.fanfare();
      banner(`Pièce fusionnée dans ${p.mr.targetBranch}.`);
      g.pieces = g.pieces.filter((x) => x.taskId !== p.taskId);
      refresh();
    } catch (err) { banner(err.message); A.sfx.error(); }
  }
  async function guardTalk() {
    await loadPieces();
    const ready = piecesReady(), unread = piecesUnread();
    if (ready.length) {
      // La relecture est OK : le Maître juré propose lui-même la fusion
      const p = ready[0], more = ready.length > 1 ? ` (et ${ready.length - 1} autre${ready.length > 2 ? "s" : ""} aussi prête${ready.length > 2 ? "s" : ""})` : "";
      await say("Maître juré", ["Halte, forgeron ! J'ai relu la pièce #" + p.issueIid + " « " + p.issueTitle + " » : rien de grave" + more + "."]);
      const answer = await choose("Maître juré", "Je la fusionne dans « " + p.mr.targetBranch + " » ?", ["Fusionner", "Voir la liste", "Plus tard"]);
      if (answer === 0) return mergePieceNow(p);
      if (answer === 1) openPopup("reviews");
      return;
    }
    const lines = ["Halte ! Je surveille les lames : celles des autres, et celles que forgent tes apprentis."];
    if (unread.length) lines.push(`${unread.length} pièce${unread.length > 1 ? "s" : ""} forgée${unread.length > 1 ? "s" : ""} par tes apprentis attend${unread.length > 1 ? "ent" : ""} ma relecture.`);
    else if (g.pieces.length) lines.push("Je relis tes pièces. Dès qu'elles sont prêtes, je te propose de les fusionner.");
    else lines.push("Je te montre ce que j'ai contrôlé.");
    await say("Maître juré", lines);
    openPopup("reviews");
  }
  async function scribeTalk() {
    await say("Scribe", ["Tu me dictes une idée, j'écris le ticket. Ou tout un projet, avec ses premiers tickets.", "Je ne pose rien sur la forge sans que tu aies relu, patron."]);
    openPopup("scribe");
  }
  /** L'Architecte explique comment créer une salle. Le générateur automatique n'existe pas encore : il le dit. */
  async function architectTalk() {
    if (!g.rooms.catalog) await loadRooms();
    await say("Architecte", [
      "Je dessine les salles de ce monde. Dis-moi ce que tu veux : un décor, des personnages, et même un jeu à jouer.",
      "Je ne fais pas de code : je décris ta salle avec une carte, des objets et des règles, et le moteur de la forge la fait vivre.",
      "Tu la visites, tu y joues, puis tu la gardes. Elle reste privée tant que tu ne la partages pas à ton équipe.",
    ]);
    openPopup("architect");
  }
  async function merchantTalk() {
    const n = g.data.armory.loot.filter((i) => !g.save.sold.includes(i.id)).length;
    await say("Marchand Sélim", [n ? "Des pièces forgées ? Montre-moi ça, je rachète tout !" : "Rien à vendre ? Reviens quand tes apprentis auront forgé, ou regarde mes tenues."]);
    openPopup("merchant");
  }

  /* ---------- salles décrites par des données (public/rooms/*.json, validées par le serveur) ---------- */
  /** Colonnes (gauche) des portes magiques du mur du fond de la forge : une par salle qui demande à y figurer, trois au plus. */
  const HUB_SLOTS = [14, 9, 16]; // les deux premières portes sont séparées de cinq cases : leurs étiquettes ne se chevauchent pas
  const hubRooms = () => g.rooms.list.filter((r) => r.hub).slice(0, HUB_SLOTS.length);
  const currentRoom = () => g.rooms.byId.get(g.roomId) ?? null;
  const fillName = (text) => String(text).replaceAll("{name}", g.save.name || "forgeron");
  const tilesOf = (x, y, w, h) => { const out = []; for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) out.push([i, j]); return out; };
  const buildAll = () => (g.roomId === "forge" ? [...buildEntities(), ...workerEntities()] : buildRoomEntities());

  /**
   * Les entités d'une salle. Les décors sans effet (tapis, torches, bannières) n'en sont pas : ils n'occupent aucune case et ne cachent donc
   * jamais un meuble ou un personnage dans la recherche de ce qui est devant soi ; ils sont dessinés à part (g.deco).
   */
  function buildRoomEntities() {
    g.deco = [];
    const room = currentRoom();
    if (!room) return [];
    const catalog = g.rooms.catalog.objects, E = [];
    room.objects.forEach((o, i) => {
      const spec = catalog[o.type];
      if (!spec) return;
      const w = spec.resizable ? (o.w ?? 1) : spec.w, h = spec.resizable ? (o.h ?? 1) : spec.h;
      const readable = o.text !== undefined;
      if (!spec.solid && !readable) { g.deco.push({ z: o.type === "carpet" ? -1 : (o.y + h) * T, draw: (c, t) => S.drawObject(c, o, t) }); return; }
      const onWall = spec.where === "wall";
      E.push({
        id: "obj-" + i, always: true, solid: spec.solid, tiles: tilesOf(o.x, o.y, w, h), z: (o.y + h) * T,
        ...(readable ? { name: S.OBJECT_NAME[o.type], verb: "Examiner", lx: o.x + w / 2, ly: onWall ? o.y + h + 0.4 : o.y - 0.35, interact: () => say("", [fillName(o.text)]) } : {}),
        draw: (c, t) => S.drawObject(c, o, t),
      });
    });
    for (const n of room.npcs) {
      E.push({
        id: "npc-" + n.id, always: true, solid: true, name: n.name, verb: "Parler", tiles: [[n.x, n.y]], z: (n.y + 1) * T, lx: n.x + 0.5, ly: n.y - 0.65,
        draw: (c) => S.person(c, n.x * T, n.y * T, { ...(S.LOOKS[n.look] ?? S.LOOKS.brann), dir: n.dir }),
        interact: async () => {
          if (room.id === ARENA_ROOM && n.id === ARENA_MASTER) return arenaTalk(n);
          await say(n.name, n.lines.map(fillName));
          if (n.plays && room.game) {
            const answer = await choose(n.name, "Jouer à « " + room.game.title + " » ?", ["Jouer", "Plus tard"]);
            if (answer === 0) await playRoomGame(room);
          }
        },
      });
    }
    room.doors.forEach((d, i) => {
      E.push({ id: "door-" + i, always: true, solid: true, decor: true, name: d.label, verb: "Sortir", tiles: [[d.x, 14], [d.x + 1, 14]], z: 0, lx: d.x + 1, ly: 13.7, draw: (c, t) => S.doorBottom(c, d.x, H, d.style, t), interact: () => doorTo(d) });
    });
    return E;
  }

  /** Lance le jeu d'une salle (moteur à règles : public/forge/engine.js). Le meilleur score de chaque salle est gardé dans le navigateur. */
  let gameplay = null;
  async function playRoomGame(room) {
    gameplay ??= window.ForgeGameplay.create({
      stage: g.el.stage, sfx: A.sfx, look: playerLook,
      onKeysCaptured: (on) => { g.play = on; if (on) { g.keys = []; g.player.path = []; } },
    });
    const best = g.save.bests?.[room.id] ?? 0;
    const result = await gameplay.start(room.game, { theme: room.theme, best });
    if (result.best > best) { g.save.bests = { ...(g.save.bests || {}), [room.id]: result.best }; persist(); }
    if (result.state === "won") { A.sfx.fanfare(); banner("Gagné ! Score : " + result.score + "."); }
  }

  /* ---------- l'arène : le Maître d'armes explique, puis on combat des bots avec son équipement ---------- */
  const ARENA_HELP = [
    "Chaque niveau te donne un point à répartir entre quatre caractéristiques : Force pour les dégâts, Agilité pour la vitesse, Vitalité pour les points de vie, Chance pour les critiques et l'or.",
    "Ton équipement compte aussi : la cape donne de l'Agilité, le tablier de la Vitalité, le couvre-chef de la Chance. Plus l'objet est rare, plus il donne.",
    "Chaque arme est unique : ses dégâts, sa cadence et ses points de caractéristique sont tirés au hasard dans la fourchette de sa rareté. Un bon rare peut valoir mieux qu'un mauvais épique, et un jet parfait existe à chaque rareté. Avant chaque combat, tu choisis ton arme sur l'écran d'introduction (flèches gauche et droite), ou dans ton équipement (touche I).",
    "Chaque arme a son effet. La dague est rapide, très courte, et frappe souvent en critique. La lance transperce deux ennemis alignés. L'arc tire vite et loin, mais faiblement. Le marteau assomme et secoue le sol autour de l'impact. Le bâton ralentit ceux qu'il touche. La hache balaie tout devant toi, et l'épée reste équilibrée.",
    "Les vagues de bots ne s'arrêtent pas : un boss toutes les 5 vagues (le Seigneur des braises, le Colosse de pierre, l'Archimage, puis on recommence, plus fort). Tu combats jusqu'à tomber, ou tu bats en retraite avec Échap et tes vagues comptent. Chaque style a sa place : l'arc et le bâton pour tenir à distance, la lance pour la portée, la dague pour les assassins rapides, le marteau et la hache pour les groupes.",
    "Tu gagnes un peu d'or par vague (plafonné par jour), jamais d'objet rare : ceux-là viennent de ton vrai travail. Les points se règlent dans ton profil (touche P).",
  ];
  async function arenaTalk(npc) {
    await say(npc.name, npc.lines.map(fillName));
    if (!g.save.arena.met) { g.save.arena.met = true; persist(); await say(npc.name, ARENA_HELP); }
    for (;;) {
      const left = pointsLeft();
      const answer = await choose(npc.name, left > 0 ? `Tu as ${left} point${left > 1 ? "s" : ""} de caractéristique à répartir.` : "Que veux-tu faire ?", ["Combattre", "Changer d'arme", "Mes caractéristiques", "Comment ça marche ?", "Plus tard"]);
      if (answer === 0) return playArena();
      if (answer === 1) { items.ui.cat = "weapon"; return openCustomizer(false, "inv"); }
      if (answer === 2) return openCustomizer(false, "profile");
      if (answer !== 3) return;
      await say(npc.name, ARENA_HELP);
    }
  }
  async function arenaGateTalk() {
    const answer = await choose("", "Une herse de fer s'ouvre sur l'arène.", ["Entrer", "Rester"]);
    if (answer === 0) enterRoom(ARENA_ROOM, null);
  }
  let arena = null;
  async function playArena() {
    arena ??= window.ForgeArena.create({
      stage: g.el.stage, sfx: A.sfx, look: playerLook, onFightEnd: arenaFightEnd,
      // Le choix de l'arme depuis l'écran d'introduction : les armes du sac, et l'équipement de l'une d'elles (renvoie le forgeron recalculé)
      weapons: () => items.weapons(),
      equipWeapon: (id) => { if (!items.equip(id)) return null; persist(); renderHud(); return { built: combatBuild(), equipment: arenaEquipment() }; },
      onKeysCaptured: (on) => { g.play = on; if (on) { g.keys = []; g.player.path = []; } },
    });
    const a = g.save.arena;
    await arena.start({ built: combatBuild(), equipment: arenaEquipment(), best: a.bestWave ? { wave: a.bestWave, wins: a.wins } : null });
    renderHud();
  }
  /** Un combat est fini : l'or est crédité (plafonné par jour, la progression est dans ce navigateur) et le record gardé. */
  function arenaFightEnd(result) {
    const a = g.save.arena, now = new Date(), day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (a.day !== day) { a.day = day; a.goldToday = 0; }
    a.fights++;
    if (result.state === "won" || result.cleared >= C.WAVES.length) a.wins++; // le premier boss est tombé dans cette partie
    const record = result.cleared > a.bestWave;
    if (record) a.bestWave = result.cleared;
    const wanted = C.reward(result, combatBuild()), gold = Math.max(0, Math.min(wanted, ARENA_DAILY_GOLD - a.goldToday));
    a.goldToday += gold; g.save.gold += gold;
    persist(); renderHud();
    if (gold > 0) A.sfx.coin();
    return { gold, note: gold < wanted ? `plafond de ${ARENA_DAILY_GOLD} or par jour` : record ? "nouveau record !" : "" };
  }

  /** Visite une salle (un brouillon de l'Architecte ou une salle d'utilisateur) : elle est connue du monde le temps de la visite. */
  async function visitRoom(room) {
    g.rooms.byId.set(room.id, room);
    window.ForgePopups.close(true);
    await enterRoom(room.id, null);
  }
  /** Joue directement au jeu d'une salle (sans y entrer). */
  function playRoom(room) {
    if (!room.game) { banner("Cette salle n'a pas de jeu."); return; }
    return playRoomGame(room);
  }

  async function portalTalk(room) {
    const answer = await choose("", "Une porte mène à « " + room.name + " ».", ["Entrer", "Rester"]);
    if (answer === 0) enterRoom(room.id, null);
  }
  async function doorTo(d) {
    if (d.to === "forge") return enterRoom("forge", null);
    const name = g.rooms.byId.get(d.to)?.name ?? d.to;
    const answer = await choose("", "Cette porte mène à « " + name + " ».", ["Passer", "Rester"]);
    if (answer === 0) enterRoom(d.to, d.spawn ?? null);
  }

  /** Change de salle : fondu, nouvelle salle, arrivée à l'endroit prévu (sous la porte magique quand on revient dans la forge). */
  async function enterRoom(id, spawn) {
    if (g.transition) return;
    const room = g.rooms.byId.get(id);
    if (id !== "forge" && !room) { banner("Cette salle est introuvable."); return; }
    const from = g.roomId;
    g.transition = true; g.keys = []; g.player.path = [];
    g.el.stage.classList.add("fg-fade");
    await sleep(300);
    g.roomId = id;
    let tx, ty, dir;
    if (id === "forge") {
      const slot = hubRooms().findIndex((r) => r.id === from);
      [tx, ty, dir] = from === ARENA_ROOM ? [ARENA_GATE_X, 13, "up"] : slot >= 0 ? [HUB_SLOTS[slot], 3, "down"] : [12, 11, "up"];
    } else {
      [tx, ty] = spawn ?? room.spawn;
      dir = "up";
    }
    Object.assign(g.player, { tx, ty, x: tx * T, y: ty * T, dir, moving: null, frame: 0, path: [] });
    g.entities = buildAll();
    A.sfx.open();
    await sleep(120);
    g.el.stage.classList.remove("fg-fade");
    g.transition = false;
    if (id !== "forge") banner(room.name);
    g.canvas.focus({ preventScroll: true });
  }

  /** Les salles sont facultatives : si le serveur ne répond pas, la forge fonctionne seule. */
  async function loadRooms() {
    g.rooms.at = g.time;
    try {
      const out = await api("/api/rooms");
      g.rooms = { catalog: out.catalog, list: out.rooms, byId: new Map(out.rooms.map((r) => [r.id, r])), problems: out.problems ?? [], template: out.template ?? null, at: g.time };
    } catch { /* pas de salles */ }
  }

  async function doorTalk() {
    const answer = await choose("", "La porte mène au tableau de bord classique.", ["Sortir de la forge", "Rester"]);
    if (answer === 0) go("#tickets");
  }

  /* ---------- données et événements ---------- */
  async function refresh() {
    try {
      const [hero, armory, loot] = await Promise.all([api(`/api/hero?tz=${new Date().getTimezoneOffset()}`), api("/api/forge/armory"), api("/api/forge/loot").catch(() => null)]);
      g.data = { hero, armory, forges: hero.forges ?? [] };
      // Le butin tombé de l'activité réelle (pièces forgées, reviews, fusions) : ramassé une seule fois par événement
      if (loot) { g.lootCatalog = loot.catalog; items.claim(loot.drops); }
    } catch (err) {
      banner(`Forge hors ligne : ${err.message}`);
      return;
    }
    if (!g.rooms.catalog || g.time - g.rooms.at > 30) await loadRooms();
    if (flag("project") && g.time - g.piecesAt > 45) await loadPieces();
    if (g.roomId !== "forge" && !currentRoom()) await enterRoom("forge", null);
    g.entities = buildAll();
    afterRefresh();
    renderHud();
    if (g.popup) window.ForgePopups.update();
  }
  function afterRefresh() {
    const hero = g.data.hero;
    const doneNow = new Set(allQuests(hero).filter((q) => q.done).map((q) => q.id));
    const visible = g.roomId === "forge" ? g.entities.filter((e) => !e.worker && !e.decor && isVisible(e)) : [];
    if (g.firstRefresh) {
      for (const e of visible) if (!g.save.seen.includes(e.id)) g.save.seen.push(e.id);
      g.save.lastLevel = g.save.lastLevel || hero.level;
    } else {
      for (const e of visible) {
        if (g.save.seen.includes(e.id)) continue;
        g.save.seen.push(e.id);
        const [tx, ty] = e.tiles[0];
        g.fx.push({ x: tx * T + 8, y: ty * T + 4, t0: g.time });
        A.sfx.spawn();
        banner(e.portal ? `Une porte s'est ouverte : ${e.name}.` : `${e.name} est arrivé dans la forge.`);
      }
      for (const q of allQuests(hero)) if (doneNow.has(q.id) && !g.done.has(q.id)) { A.sfx.fanfare(); banner(`Quête accomplie : ${q.title} (+${q.xp} XP)`); }
      if (hero.level > g.save.lastLevel) { A.sfx.fanfare(); banner(`Niveau ${hero.level} : ${hero.title} !`); }
      g.save.lastLevel = hero.level;
    }
    announceProgress(hero);
    g.done = doneNow;
    g.firstRefresh = false;
    persist();
  }

  /** Annonce ce qui a changé depuis le dernier rafraîchissement : mission faite, palier de maîtrise, rang de prestige, série. */
  function announceProgress(hero) {
    const p = hero.progress, pr = hero.prestige;
    if (!p || !pr) return;
    const doneKeys = new Set(missionList().filter((m) => m.done).map(claimKey));
    const tiers = Object.fromEntries(p.masteries.map((m) => [m.id, m.reached]));
    if (g.prog) {
      for (const m of missionList()) if (m.done && !g.prog.missions.has(claimKey(m))) { A.sfx.fanfare(); banner(`Mission accomplie : ${m.title}. ${m.gold} or à réclamer au tableau.`); }
      for (const m of p.masteries) if (m.reached > (g.prog.tiers[m.id] ?? 0)) { A.sfx.fanfare(); banner(`Maîtrise « ${m.title} » : palier ${m.reached}/${m.tiers.length} (+${m.tiers[m.reached - 1].xp} XP)`); }
      if (p.streak.current > g.prog.streak) banner(`Série de ${p.streak.current} jour${p.streak.current > 1 ? "s" : ""} : la flamme brûle !`);
    } else if (p.streak.atRisk) {
      banner(`Ta série de ${p.streak.current} jour${p.streak.current > 1 ? "s" : ""} s'éteint à minuit : une pièce ou une review suffit.`);
    } else if (claimable().length) {
      banner(`${claimable().length} récompense${claimable().length > 1 ? "s" : ""} t'attend${claimable().length > 1 ? "ent" : ""} au tableau.`);
    }
    if (g.save.lastRank && g.save.lastRank !== pr.rank.id && RANK_ORDER.indexOf(pr.rank.id) > RANK_ORDER.indexOf(g.save.lastRank)) {
      A.sfx.fanfare();
      banner(`Prestige : rang ${pr.rank.name} ! Bonus d'or de ${pr.rank.goldBonusPct} % chez le marchand.`);
      const pl = g.player;
      for (let i = 0; i < 5; i++) g.fx.push({ x: pl.x + 2 + i * 3, y: pl.y + 2 - (i % 2) * 6, t0: g.time + i * 0.1 });
    }
    g.save.lastRank = pr.rank.id;
    g.prog = { missions: doneKeys, tiers, streak: p.streak.current };
  }

  function banner(text) {
    const el = document.createElement("div");
    el.className = "fg-banner";
    el.textContent = text;
    g.el.banners.append(el);
    setTimeout(() => el.remove(), 4200);
  }

  function renderHud() {
    const h = g.data.hero, e = g.el;
    const next = allQuests(h).find((q) => !q.done);
    // Un seul bouton : toute la barre ouvre le profil (équipement, sac, quêtes, rang, série...)
    e.hud.title = `${h?.title ?? ""} · ${h?.xp ?? 0} XP · Ouvrir ton profil (touche P)`;
    const fresh = items.freshCount();
    e.hud.innerHTML = `<span class="fg-name">${esc(g.save.name || "Forgeron")}</span><span>Niv. ${h?.level ?? 1}</span><span class="fg-bar"><i style="width:${h?.percent ?? 0}%"></i></span><span class="fg-gold">${g.save.gold} or</span>${fresh ? `<span class="fg-pending" title="Objets nouveaux dans ton sac">${fresh} nouveau${fresh > 1 ? "x" : ""}</span>` : ""}`;
    // Deuxième ligne : seulement ce qui demande une action (récompenses à réclamer au tableau, série qui va s'éteindre)
    const pg = progress(), pending = claimable().length;
    const parts = [];
    if (pending) parts.push(`<button type="button" class="fg-pending" data-fg="board" title="Récompenses de missions à réclamer au tableau">${pending} à réclamer</button>`);
    if (pg?.streak.atRisk) parts.push(`<span class="fg-streak risk" title="Fais une pièce ou une review avant minuit pour garder ta série">Série ${pg.streak.current} j en danger</span>`);
    e.hud2.innerHTML = parts.join("");
    e.hud2.hidden = parts.length === 0;
    e.quest.title = next ? `${next.title} : ${next.hint}` : "";
    e.quest.innerHTML = next ? `<b>Quête</b> ${esc(next.title)} <small>${esc(next.hint)}</small>` : `<b>Toutes les quêtes sont accomplies</b>`;
    const pr = A.prefs();
    e.tools.innerHTML = `<button type="button" class="fg-tool ${pr.sfx ? "on" : ""}" data-fg="sfx" title="Effets sonores">Son</button>
      <button type="button" class="fg-tool ${pr.music ? "on" : ""}" data-fg="music" title="Musique">Musique</button>`;
  }

  /** Nom et niveau, sous l'aperçu du forgeron (colonne de gauche du popup). */
  function sideIdHtml() {
    const h = g.data.hero;
    return `<div class="fg-side-id"><b>${esc(g.save.name || "Forgeron")}</b>${h ? `<small>Niveau ${h.level} · ${esc(h.title)}</small>` : ""}</div>`;
  }

  /** Page « Profil » : identité, niveau, or, rang, série, collection, quête en cours et travail réel (tout est lu, rien n'est modifiable ici). */
  function profileHtml() {
    const h = g.data.hero;
    if (!h) return `<p class="fg-empty">Les données du forgeron arrivent…</p>`;
    const rk = prestige(), pg = progress(), pending = claimable();
    const rank = rk ? `<span class="fg-rank" ${rk.rank.aura ? `style="--aura:${rk.rank.aura}"` : ""} title="Rang de prestige">${esc(rk.rank.name)}${rk.stars ? " " + "★".repeat(Math.min(rk.stars, 5)) : ""}</span>` : "";
    const nextRank = rk?.next ? `Encore ${rk.next.xpLeft} XP pour le rang ${esc(rk.next.name)} (niveau ${rk.next.level}).` : "";
    const col = items.collection();
    const next = allQuests(h).find((q) => !q.done);
    const tile = (label, value, note, cls = "") => `<div class="fg-tile ${cls}"><small>${label}</small><b>${value}</b><small>${note}</small></div>`;
    // Toujours trois tuiles : la grille reste alignée même quand la série n'existe pas encore
    const tiles = [
      tile("Or", `${g.save.gold}`, rk ? `+${rk.rank.goldBonusPct} % aux ventes` : "à dépenser chez le marchand"),
      pg ? tile("Série", `${pg.streak.current} j`, pg.streak.atRisk ? "s'éteint à minuit !" : `record ${pg.streak.best} j`, pg.streak.atRisk ? "risk" : "") : tile("Série", "0 j", "pas encore lancée"),
      tile("Collection", `${col.owned}/${col.total}`, "objets différents"),
    ].join("");
    const claim = pending.length ? `<button type="button" class="fg-btn fg-block" data-pf-board>${pending.length} récompense${pending.length > 1 ? "s" : ""} à réclamer : ${pending.reduce((n, m) => n + m.gold, 0)} or</button>` : "";
    const quest = next
      ? `<div class="fg-quest-row next"><span class="chk"></span><div><b>${esc(next.title)}</b><small>${esc(next.hint)}</small></div><span class="xp">+${next.xp} XP</span></div>`
      : `<div class="fg-quest-row done"><span class="chk">✓</span><div><b>Toutes les quêtes sont accomplies</b><small>Les missions du jour et de la semaine continuent au tableau.</small></div></div>`;
    return `<div class="fg-pf">
      <div class="fg-box fg-pf-head">
        <div class="fg-pf-id"><div><span class="fg-pf-name">${esc(g.save.name || "Forgeron")}</span> ${rank}<small>${esc(h.heroClass)} ${esc(h.specialty.toLowerCase())}</small></div><button type="button" class="fg-mini" data-pf-tab="look">Modifier</button></div>
        <div class="fg-pf-level"><span>Niveau ${h.level} · ${esc(h.title)}</span><span>${h.xp} XP</span></div>
        <div class="fg-pbar"><i style="width:${Math.max(0, Math.min(100, h.percent))}%"></i></div>
        ${nextRank ? `<small class="fg-note">${nextRank}</small>` : ""}
      </div>
      <div class="fg-tiles">${tiles}</div>
      ${claim}
      <h4>Quête en cours<button type="button" class="fg-mini" data-pf-tab="quests">Toutes les quêtes</button></h4>${quest}
      <h4>Ton travail</h4>
      <div class="fg-tiles compact">${h.stats.map((s) => `<div class="fg-tile"><b>${s.value}</b><small>${esc(s.label.toLowerCase())}</small></div>`).join("")}</div>
    </div>`;
  }

  /** Page « Combat » : points à répartir, valeurs de combat, bonus de l'équipement, record de l'arène. */
  function combatHtml() {
    const h = g.data.hero;
    if (!h) return `<p class="fg-empty">Les données du forgeron arrivent…</p>`;
    const b = combatBuild(), left = pointsLeft(), a = g.save.arena, d = b.derived;
    const rows = C.STATS.map((st) => `<div class="fg-stat">
        <div class="fg-stat-name"><b>${st.name}</b><small>${esc(st.hint)}</small></div>
        <div class="fg-stat-val">
          <button type="button" class="fg-mini" data-stat-sub="${st.id}" ${b.base[st.id] ? "" : "disabled"} aria-label="Retirer un point de ${st.name}">−</button>
          <span class="fg-stat-n" title="Points répartis + bonus de l'équipement"><b>${b.total[st.id]}</b><small>${b.base[st.id]} + ${b.bonus[st.id]}</small></span>
          <button type="button" class="fg-mini" data-stat-add="${st.id}" ${left > 0 ? "" : "disabled"} aria-label="Ajouter un point de ${st.name}">+</button>
        </div></div>`).join("");
    const tile = (label, value, note) => `<div class="fg-tile"><small>${label}</small><b>${value}</b><small>${note}</small></div>`;
    const tiles = [
      tile("Points de vie", d.maxHp, "Vitalité"), tile("Dégâts", d.damage, esc(b.weapon.spec.name) + (b.weapon.training ? " d'entraînement" : "")), tile("Vitesse", d.speed, "Agilité"),
      tile("Critique", `${Math.round(d.crit * 100)} %`, "Chance"), tile("Roulade", `${d.dashCd} s`, "Agilité"), tile("Or gagné", `+${Math.round((d.goldMult - 1) * 100)} %`, "Chance"),
    ].join("");
    const worn = Object.entries(b.slots).map(([slot, sl]) => `${C.SLOT_NAME[slot]} ${items.rarityName(sl.rarity).toLowerCase()} : ${(sl.lines ?? [{ stat: sl.stat, points: sl.points }]).map((l) => `+${l.points} ${C.STATS.find((x) => x.id === l.stat).name.toLowerCase()}`).concat((sl.affixes || []).map((a) => a.text)).join(", ")}${sl.standard === false ? ` (${sl.label})` : ""}`);
    return `<div class="fg-pf">
      <div class="fg-box fg-pf-head"><div class="fg-pf-level"><span><b>${left}</b> point${left > 1 ? "s" : ""} à répartir</span><span>1 point par niveau (niveau ${h.level})</span></div>
        <small class="fg-note">${left > 0 ? "Plus tu montes de niveau en travaillant, plus tu en gagnes." : "Tous tes points sont répartis."}</small>
        <small class="fg-note"><b>${esc(b.weapon.spec.name)}</b>${b.weapon.training ? " d'entraînement" : ""} : ${esc(b.weapon.spec.perk)}</small>
        ${(b.weapon.roll.affixes || []).map((a) => `<small class="fg-note fg-aff"><i></i>${esc(a.text)}</small>`).join("")}</div>
      <div class="fg-box fg-stats">${rows}</div>
      <div class="fg-tiles">${tiles}</div>
      <h4>Équipement</h4>
      <p class="fg-note">${worn.length ? esc(worn.join(" · ")) : "Aucun équipement porté : équipe des objets du sac pour gagner des points."}</p>
      <h4>Arène</h4>
      <p class="fg-note">${a.fights ? `${a.fights} combat${a.fights > 1 ? "s" : ""}, record : ${a.bestWave} vague${a.bestWave > 1 ? "s" : ""}, premier boss vaincu ${a.wins} fois.` : "Pas encore de combat : la herse de fer, en bas à droite de la forge, mène à l'arène."}</p>
      <p><button type="button" class="fg-mini" data-stat-reset>Réinitialiser mes points</button></p>
    </div>`;
  }

  /** Popup du profil : un seul endroit pour le forgeron (profil, sac, apparence, échange, quêtes). Le jeu garde l'aperçu et l'équipement visibles à gauche. */
  function openCustomizer(first, tab = "profile", opts = {}) {
    if (g.custom) return;
    const look = { ...g.save.look };
    let current = first ? "look" : tab;
    let nameValue = g.save.name;
    let seenBag = false, shown = null;
    const el = document.createElement("div");
    el.className = "fg-custom";
    const swatches = (key, list) => `<div class="fg-swatches" data-key="${key}">${list.map((c) => `<button type="button" class="fg-sw ${look[key] === c ? "on" : ""}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}</div>`;
    const tabs = first || opts.solo ? "" : `<div class="fg-tabs fg-ctabs">${[["profile", "Profil"], ["inv", "Équipement"], ["progress", "Progression"], ["quests", "Quêtes"]].map(([k, label]) => `<button type="button" class="fg-tab" data-ctab="${k}">${label}${k === "inv" && items.freshCount() ? ` <i>${items.freshCount()}</i>` : ""}</button>`).join("")}</div>`;
    /** Nom et couleurs du forgeron (à la création, ou section Apparence de l'onglet Profil). */
    const lookFormHtml = () => `<label>Ton nom<input data-name maxlength="24" value="${esc(nameValue)}" placeholder="Aldric" autocomplete="off"></label>
        <div class="fg-box fg-looks">
          <div class="fg-row"><span>Peau</span>${swatches("skin", SKINS)}</div>
          <div class="fg-row"><span>Cheveux</span>${swatches("hair", HAIRS)}</div>
          <div class="fg-row"><span>Tunique</span>${swatches("tunic", TUNICS)}</div>
        </div>${first ? "" : `<p class="fg-note">L'aperçu à gauche change tout de suite. Clique sur « Enregistrer et fermer » pour garder ton nom et tes couleurs.</p>`}`;
    /** Onglet Profil : les caractéristiques (points, valeurs de combat, record de l'arène), puis l'apparence. */
    const profileTabHtml = () => `${combatHtml()}<h4>Apparence</h4><div class="fg-look">${lookFormHtml()}</div>`;
    // Hors création du personnage, le popup a toujours la même taille : aperçu et équipement à gauche, l'onglet choisi à droite
    el.innerHTML = `<div class="fg-card ${first ? "" : "wide"}">
      ${first ? "" : `<button type="button" class="fg-x" data-cancel aria-label="Fermer" title="Fermer sans enregistrer l'apparence (Échap)"></button>`}
      <h2>${first ? "Qui es-tu, forgeron ?" : opts.title ?? "Ton forgeron"}</h2>
      ${tabs}
      <div class="fg-side"><canvas class="fg-preview" width="32" height="40"></canvas><div class="fg-worn" ${first ? "hidden" : ""}></div></div>
      ${first ? `<div class="fg-look">${lookFormHtml()}</div>` : ""}
      <div class="fg-panel" hidden></div>
      <button type="button" class="fg-btn" data-ok>${first ? "Entrer dans la forge" : opts.solo ? "Fermer" : "Enregistrer et fermer"}</button></div>`;
    g.el.stage.append(el);
    g.custom = el;
    const draw = () => {
      const c = el.querySelector("canvas").getContext("2d");
      c.clearRect(0, 0, 32, 40);
      S.px(c, 0, 0, 32, 40, "#3a3345");
      S.person(c, 8, 16, { ...look, ...items.look(), dir: "down" });
    };
    /** Affiche l'onglet courant : l'apparence, ou le panneau des objets (sac, échange). */
    const show = () => {
      const panel = el.querySelector(".fg-panel"), pane = el.querySelector(".fg-look");
      el.querySelectorAll("[data-ctab]").forEach((b) => b.classList.toggle("on", b.dataset.ctab === current));
      if (first) { pane.hidden = false; panel.hidden = true; } else panel.hidden = false;
      if (!first) el.querySelector(".fg-worn").innerHTML = sideIdHtml() + items.equippedHtml();
      // Un changement d'équipement redessine l'onglet : on garde la position dans la liste, sauf quand on change d'onglet
      const scroller = first ? pane : panel;
      const keep = shown === current ? scroller.scrollTop : 0;
      if (!first) panel.innerHTML = current === "profile" ? profileTabHtml() : current === "progress" ? profileHtml() : current === "quests" ? window.ForgePopups.questsHtml(api2) : items.panelHtml(current);
      scroller.scrollTop = keep;
      shown = current;
      if (current === "inv") seenBag = true;
    };
    /** Ferme le popup : les objets nouveaux ne sont marqués « vus » que si le sac a été ouvert. L'équipement, lui, est déjà enregistré à chaque clic. */
    const close = () => {
      if (seenBag) items.markSeen();
      persist();
      el.remove();
      g.custom = null;
      g.customUi = null;
      A.sfx.open();
      renderHud();
    };
    g.customUi = { redraw: draw, rerender: show, close: first ? null : close };
    draw();
    show();
    el.addEventListener("input", (ev) => { if (ev.target.matches("[data-name]")) nameValue = ev.target.value; });
    el.addEventListener("click", (ev) => {
      const t = ev.target.closest("[data-ctab], [data-pf-tab]");
      if (t) { current = t.dataset.ctab ?? t.dataset.pfTab; A.sfx.select(); show(); return; }
      if (ev.target.closest("[data-cancel]")) { close(); return; }
      if (ev.target.closest("[data-pf-board]")) { close(); openPopup("board"); return; }
      const st = ev.target.closest("[data-stat-add], [data-stat-sub], [data-stat-reset]");
      if (st) {
        if (st.hasAttribute("data-stat-reset")) { resetStats(); A.sfx.select(); } else if (setStat(st.dataset.statAdd ?? st.dataset.statSub, st.hasAttribute("data-stat-add") ? 1 : -1)) A.sfx.select();
        show();
        return;
      }
      if (items.onClick(ev)) return;
      const sw = ev.target.closest(".fg-sw");
      if (sw) { look[sw.parentElement.dataset.key] = sw.dataset.c; sw.parentElement.querySelectorAll(".fg-sw").forEach((b) => b.classList.toggle("on", b === sw)); A.sfx.select(); draw(); return; }
      if (ev.target.closest("[data-ok]")) {
        if (!opts.solo) { g.save.name = nameValue.trim() || "Forgeron"; g.save.look = look; g.save.created = true; }
        close();
        if (first) startAdventure();
      }
    });
    if (first) el.querySelector("input").focus();
  }
  async function startAdventure() {
    await sleep(500);
    if (!g.running || g.save.intro) return;
    g.player.dir = "up";
    await brannTalk();
  }

  /* ---------- boucle ---------- */
  function update(dt) {
    const p = g.player;
    if (p.moving) {
      p.moving.k += dt * 6;
      const k = Math.min(1, p.moving.k);
      p.x = p.moving.fx + (p.moving.tx - p.moving.fx) * k;
      p.y = p.moving.fy + (p.moving.ty - p.moving.fy) * k;
      p.frame = k < 0.5 ? 1 : 2;
      if (k >= 1) { p.x = p.moving.tx; p.y = p.moving.ty; p.moving = null; p.frame = 0; A.sfx.step(); }
    } else if (!modal()) {
      const held = g.keys[g.keys.length - 1];
      if (held) tryStep(held);
      else if (p.path.length) {
        const s = p.path.shift();
        if (s.startsWith("face:")) { if (faceEntity(s.slice(5))) interact(); } else if (!tryStep(s)) p.path = [];
      }
    }
    g.fx = g.fx.filter((f) => g.time - f.t0 < 1.1);
    // Coups de marteau des apprentis au travail, et crépitement des fours allumés : plus forts quand on s'approche
    for (const e of g.entities) {
      if (!e.worker || e.worker.state !== "working") continue;
      const phase = Math.floor(g.time * 2.2 + e.slot * 0.37) % 2; // 1 : marteau levé, 0 : il retombe
      if (g.hammer.get(e.id) === 1 && phase === 0) A.sfx.hammer(Math.max(0.12, 1 - Math.hypot(e.tiles[0][0] - p.tx, e.tiles[0][1] - p.ty) / 14));
      g.hammer.set(e.id, phase);
    }
    if (g.time - g.lastFire > 0.2) {
      g.lastFire = g.time;
      const furnaces = [["github", 4, 2], ["gitlab", 20, 2]].filter(([k]) => lit(k));
      const d = furnaces.length ? Math.min(...furnaces.map(([, x, y]) => Math.hypot(x - p.tx, y - p.ty))) : 99;
      A.setFire(g.roomId === "forge" && furnaces.length ? Math.max(0.1, 1 - d / 16) : 0);
    }
  }

  /** Halo du rang de prestige : un anneau au sol qui respire, et quelques étincelles qui montent. */
  function drawAura(c, p, color, t) {
    c.save();
    c.globalAlpha = 0.32 + 0.1 * Math.sin(t * 3);
    c.fillStyle = color;
    c.beginPath();
    c.ellipse(p.x + 8, p.y + T - 1, 9, 3.5, 0, 0, Math.PI * 2);
    c.fill();
    for (let i = 0; i < 3; i++) {
      const phase = (t * 0.8 + i / 3) % 1;
      c.globalAlpha = 1 - phase;
      c.fillRect(Math.round(p.x + 4 + i * 4 + Math.sin(t * 2 + i) * 1.5), Math.round(p.y + T - 4 - phase * 16), 1, 1);
    }
    c.restore();
  }
  /** Un « ! » doré qui flotte au-dessus du tableau tant qu'une récompense de mission attend. */
  function drawMarker(c, x, y, t) {
    const by = y + Math.round(Math.sin(t * 4) * 1.5);
    S.px(c, x - 1, by - 1, 6, 11, "#231a10");
    S.px(c, x, by, 4, 6, "#ffd37a");
    S.px(c, x, by + 7, 4, 2, "#ffd37a");
  }

  function draw() {
    const c = g.c, t = g.time, p = g.player;
    // Double résolution : tout le dessin garde ses coordonnées de tuiles de 16 px, le canevas a deux fois plus de pixels
    c.setTransform(2, 0, 0, 2, 0, 0);
    // Sol, murs, tapis : un calque fixe, fini au demi-pixel, rendu une fois par salle
    const hall = g.roomId === "forge", theme = hall ? "forge" : currentRoom()?.theme ?? "forge", key = `${hall ? "hall" : "shell"}:${theme}`;
    if (g.layer?.key !== key) g.layer = { key, cv: S.buildRoomLayer(W, H, theme, hall) };
    c.drawImage(g.layer.cv, 0, 0, W * T, H * T);
    if (hall) S.roomTorches(c, t, W);
    const items = g.entities.filter(isVisible).map((e) => [e.z, () => e.draw(c, t)]);
    for (const d of g.deco) items.push([d.z, () => d.draw(c, t)]);
    const aura = prestige()?.rank.aura;
    if (aura) items.push([p.y + T - 1, () => drawAura(c, p, aura, t)]);
    if (g.roomId === "forge" && claimable().length) items.push([99 * T, () => drawMarker(c, 12 * T - 2, 5, t)]);
    // Une pièce attend la relecture ou la fusion : un « ! » au-dessus du Maître juré
    if (g.roomId === "forge" && flag("project") && (piecesReady().length || piecesUnread().length)) items.push([99 * T, () => drawMarker(c, 6 * T + 5, 11 * T - 17, t)]);
    items.push([p.y + T, () => S.person(c, p.x, p.y, { ...playerLook(), dir: p.dir, frame: p.frame })]);
    items.sort((a, b) => a[0] - b[0]).forEach((it) => it[1]());
    for (const f of g.fx) S.sparkle(c, f.x, f.y, (g.time - f.t0) / 1.1);
    const e = !modal() && !p.moving ? front() : null;
    if (e && e.interact) S.pointer(c, e.lx * T, e.ly * T - 2, t);
    S.lightPass(c, t, W, H);
  }

  /** Bulles des agents, et nom du personnage ou de l'objet que la souris survole (jamais de nom affiché pour la seule proximité du joueur). */
  function updateLabels() {
    const p = g.player, want = new Map(), hover = g.hover && !modal() ? g.hover : null;
    for (const e of g.entities) {
      if (!isVisible(e) || e.decor) continue;
      if (e.bubble) { want.set(e.id, { cls: "bubble", text: e.bubble, x: e.lx, y: e.ly }); continue; }
      if (e.name && hover && e.tiles.some(([tx, ty]) => tx === hover.tx && ty === hover.ty)) want.set(e.id, { cls: "pill", text: e.name, x: e.lx, y: e.ly });
    }
    const f = !modal() && !p.moving ? front() : null;
    if (f && f.interact) want.set("prompt", { cls: "prompt", text: `E · ${f.verb ?? "Parler"}`, x: f.lx, y: f.ly - 0.55 });
    for (const [id, el] of g.labelEls) if (!want.has(id)) { el.remove(); g.labelEls.delete(id); }
    for (const [id, w] of want) {
      let el = g.labelEls.get(id);
      if (!el) { el = document.createElement("div"); g.el.labels.append(el); g.labelEls.set(id, el); }
      el.className = `fg-label ${w.cls}`;
      if (el.textContent !== w.text) el.textContent = w.text;
      el.style.left = `${(w.x * T / (W * T)) * 100}%`;
      el.style.top = `${(w.y * T / (H * T)) * 100}%`;
    }
  }

  function frame(now) {
    if (!g.running) return;
    const dt = Math.min(0.05, (now - g.last) / 1000);
    g.last = now;
    g.time += dt;
    update(dt);
    draw();
    updateLabels();
    g.raf = requestAnimationFrame(frame);
  }

  /* ---------- clavier et souris ---------- */
  const typing = (t) => t && (t.matches?.("input, textarea, select") || t.isContentEditable);
  function onKeyDown(ev) {
    if (!g.running || g.play || ev.ctrlKey || ev.metaKey || ev.altKey) return; // pendant un jeu, les touches sont à lui
    A.start();
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (typing(ev.target)) { if (key === "Escape") { if (g.popup) window.ForgePopups.close(); else g.customUi?.close?.(); } return; }
    if (key === "Escape") {
      if (g.dlg) { endDialog(-1); ev.preventDefault(); } else if (g.popup) { window.ForgePopups.close(); ev.preventDefault(); } else if (g.customUi?.close) { g.customUi.close(); ev.preventDefault(); }
      return;
    }
    if (key === "m") { A.toggleAll(); renderHud(); return; }
    if (g.popup || g.custom) return;
    if (key === "i" && !g.dlg) { ev.preventDefault(); openCustomizer(false, "inv"); return; }
    if (key === "p" && !g.dlg) { ev.preventDefault(); openCustomizer(false, "profile"); return; }
    if (g.dlg) {
      if (key === "e" || key === " " || key === "Enter") { ev.preventDefault(); advance(); }
      else if (g.dlg.options && (key === "ArrowUp" || key === "ArrowDown" || key === "z" || key === "s" || key === "w")) {
        ev.preventDefault();
        const d = g.dlg, n = d.options.length;
        d.sel = (d.sel + (key === "ArrowDown" || key === "s" ? 1 : n - 1)) % n;
        A.sfx.blip(2);
        renderOptions();
      }
      return;
    }
    if (key === "e" || key === " " || key === "Enter") { ev.preventDefault(); interact(); return; }
    const dir = KEY_DIR[key];
    if (dir) { ev.preventDefault(); g.player.path = []; if (!g.keys.includes(dir)) g.keys.push(dir); }
  }
  function onKeyUp(ev) {
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    const dir = KEY_DIR[key];
    if (dir) g.keys = g.keys.filter((d) => d !== dir);
  }
  function onCanvasClick(ev) {
    A.start();
    if (g.dlg) return advance();
    if (modal()) return;
    const r = g.canvas.getBoundingClientRect();
    const tx = Math.floor(((ev.clientX - r.left) / r.width) * W), ty = Math.floor(((ev.clientY - r.top) / r.height) * H);
    g.keys = [];
    walkTo(tx, ty);
  }
  /** Retient la case sous la souris : c'est elle qui décide quel nom s'affiche (`updateLabels`). */
  function onCanvasMove(ev) {
    const r = g.canvas.getBoundingClientRect();
    g.hover = { tx: Math.floor(((ev.clientX - r.left) / r.width) * W), ty: Math.floor(((ev.clientY - r.top) / r.height) * H) };
  }
  const onCanvasLeave = () => { g.hover = null; };
  function onStageClick(ev) {
    const t = ev.target.closest("[data-fg]");
    if (t) {
      A.start();
      const what = t.dataset.fg;
      if (what === "sfx") A.set("sfx", !A.prefs().sfx);
      if (what === "music") A.set("music", !A.prefs().music);
      if (what === "profile" && !modal()) openCustomizer(false, "progress");
      if (what === "board" && !modal()) openPopup("board");
      renderHud();
      return;
    }
    const opt = ev.target.closest("[data-opt]");
    if (opt && g.dlg?.options) { g.dlg.sel = Number(opt.dataset.opt); advance(); }
    else if (ev.target.closest(".fg-dialog")) advance();
  }

  /* ---------- montage ---------- */
  function build(root) {
    root.innerHTML = `<div class="fg-wrap"><div class="fg-stage">
      <canvas class="fg-canvas" width="${W * T * 2}" height="${H * T * 2}" tabindex="0"></canvas>
      <div class="fg-labels"></div>
      <div class="fg-hud" data-fg="profile" role="button"></div><div class="fg-hud2"></div><div class="fg-quest"></div><div class="fg-tools"></div>
      <div class="fg-help">Flèches ou ZQSD : marcher · E : parler, toucher · clic : aller là · P : profil · I : sac · M : couper le son</div>
      <div class="fg-dialog" hidden><span class="fg-who"></span><div class="fg-text"></div><div class="fg-options"></div><span class="fg-more" hidden>▼ E</span></div>
      <div class="fg-banners"></div>
    </div><div class="fg-popups"></div></div>`;
    const q = (s) => root.querySelector(s);
    g.root = root; g.stage = q(".fg-stage"); g.canvas = q(".fg-canvas"); g.c = g.canvas.getContext("2d");
    g.c.imageSmoothingEnabled = false;
    g.el = { stage: g.stage, labels: q(".fg-labels"), hud: q(".fg-hud"), hud2: q(".fg-hud2"), quest: q(".fg-quest"), tools: q(".fg-tools"), dialog: q(".fg-dialog"), banners: q(".fg-banners"), popups: q(".fg-popups") };
    g.canvas.addEventListener("click", onCanvasClick);
    g.canvas.addEventListener("mousemove", onCanvasMove);
    g.canvas.addEventListener("mouseleave", onCanvasLeave);
    g.stage.addEventListener("click", onStageClick);
    g.labelEls.clear();
    g.entities = buildAll();
    renderHud();
  }

  function start() {
    if (g.running) return;
    g.running = true;
    g.last = performance.now();
    g.raf = requestAnimationFrame(frame);
    clearInterval(g.poll);
    g.poll = setInterval(refresh, 8000);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("ra:changed", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    A.resume();
    refresh();
    if (!g.save.created) openCustomizer(true);
  }
  const onBlur = () => { g.keys = []; };
  const onVisibility = () => { if (document.hidden) A.stop(); else if (g.running) A.resume(); };

  function pause() {
    if (!g.running) return;
    g.running = false;
    cancelAnimationFrame(g.raf);
    clearInterval(g.poll);
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("ra:changed", refresh);
    document.removeEventListener("visibilitychange", onVisibility);
    if (g.popup) window.ForgePopups.close();
    if (g.dlg) endDialog(-1);
    // Un jeu ou l'arène ouverts capturent le clavier de toute la page : on les ferme en quittant la forge
    gameplay?.close();
    arena?.close();
    g.keys = [];
    g.hover = null;
    A.stop();
  }

  /** Ce que les popups peuvent utiliser du jeu. */
  const api2 = {
    get data() { return g.data; },
    get save() { return g.save; },
    get rooms() { return g.rooms; },
    cosmetics: COSMETICS,
    persist, say, choose, banner, refresh, renderHud, weaponType, items, claim, claimable, claimKey, goldBonus, rankIndex, rankOrder: RANK_ORDER,
    setPopup(open) { g.popup = open; if (open) { g.keys = []; g.player.path = []; } },
    openCustomizer: () => openCustomizer(false),
    visitRoom, playRoom,
  };

  window.ForgeGame = {
    mount(root) {
      if (g.root !== root || !root.querySelector(".fg-wrap")) build(root);
      start();
      g.canvas.focus({ preventScroll: true });
    },
    pause,
    enter: (id) => enterRoom(id, null),
    debug: () => g,
  };
})();
