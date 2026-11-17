/* Arène de la forge : caractéristiques du forgeron et combat en temps réel contre des bots.
   Logique pure (aucun DOM, aucun code d'utilisateur) : le navigateur la joue (public/forge/arena.js), les tests la font jouer sans écran.
   Tout est déterministe : un tirage de départ (`seed`) et un pas de temps fixe donnent toujours le même combat. Règles : docs/arene.md. */
(() => {
  "use strict";

  const T = 16, W = 24, H = 15;
  const STEP = 1 / 60;

  /* ---------- caractéristiques ---------- */
  const STATS = [
    { id: "force", name: "Force", hint: "Dégâts de tes coups" },
    { id: "agilite", name: "Agilité", hint: "Vitesse de déplacement et d'attaque, roulade plus fréquente" },
    { id: "vitalite", name: "Vitalité", hint: "Points de vie" },
    { id: "chance", name: "Chance", hint: "Coups critiques et or gagné" },
  ];
  const STAT_IDS = STATS.map((s) => s.id);
  const RARITIES = ["common", "rare", "epic", "legendary"];
  /** Points de caractéristique donnés par un objet porté, selon sa rareté. Chaque emplacement nourrit sa caractéristique. */
  const RARITY_STAT = { common: 1, rare: 2, epic: 4, legendary: 7 };
  const SLOT_STAT = { weapon: "force", cape: "agilite", apron: "vitalite", hat: "chance" };
  const SLOT_NAME = { weapon: "Arme", cape: "Cape", apron: "Tablier", hat: "Couvre-chef" };
  const RARITY_DMG = { common: 1, rare: 1.15, epic: 1.35, legendary: 1.6 };

  /* ---------- armes : chacune a sa façon de se battre ---------- */
  const WEAPONS = {
    sword: { name: "Épée", blurb: "Équilibrée : portée moyenne, bonne cadence.", dmg: 12, cd: 0.45, windup: 0.08, reach: 22, arc: 110, knock: 50 },
    axe: { name: "Hache", blurb: "Lente mais large : touche tout ce qui t'entoure devant toi.", dmg: 18, cd: 0.8, windup: 0.15, reach: 20, arc: 170, knock: 60 },
    hammer: { name: "Marteau", blurb: "Très lent, énorme : assomme ce qu'il touche.", dmg: 28, cd: 1.15, windup: 0.25, reach: 20, arc: 120, knock: 110, stun: 0.6 },
    dagger: { name: "Dague", blurb: "Très rapide, très courte : il faut coller l'ennemi.", dmg: 8, cd: 0.26, windup: 0.04, reach: 15, arc: 100, knock: 20 },
    spear: { name: "Lance", blurb: "Longue portée, étroite : on frappe avant d'être touché.", dmg: 13, cd: 0.55, windup: 0.12, reach: 36, arc: 36, knock: 60 },
    bow: { name: "Arc", blurb: "Tire de loin : garde tes distances.", dmg: 11, cd: 0.65, windup: 0.08, ranged: true, range: 210, projSpeed: 210, knock: 25 },
    staff: { name: "Bâton", blurb: "Un trait magique lent qui traverse tout ce qu'il croise.", dmg: 13, cd: 0.85, windup: 0.12, ranged: true, range: 170, projSpeed: 130, pierce: true, knock: 15 },
  };
  const TRAINING_WEAPON = { type: "sword", rarity: "common" };

  /* ---------- l'arène : 24 x 15 tuiles, quatre piliers ---------- */
  const BOUNDS = { x0: 1 * T, x1: 23 * T, y0: 2 * T, y1: 14 * T };
  const PILLARS = [[6, 5], [17, 5], [6, 10], [17, 10]];
  const OBSTACLES = PILLARS.map(([tx, ty]) => ({ x: tx * T, y: ty * T, w: T, h: T }));
  const HERO_START = { x: 12 * T, y: 11.5 * T };
  const SPAWNS = [[3 * T, 3.5 * T], [21 * T, 3.5 * T], [12 * T, 3 * T], [3 * T, 12.5 * T], [21 * T, 12.5 * T], [8 * T, 3 * T], [16 * T, 3 * T]];

  /* ---------- les bots ---------- */
  const BOTS = {
    gobelin: { name: "Gobelin", weapon: "dagger", rarity: "common", hp: 22, dmg: 4, speed: 56, reach: 14, windup: 0.3, cd: 0.9, r: 5 },
    soldat: { name: "Soldat", weapon: "sword", rarity: "rare", hp: 36, dmg: 6, speed: 46, reach: 21, windup: 0.38, cd: 1.1, r: 5 },
    brute: { name: "Brute", weapon: "hammer", rarity: "epic", hp: 75, dmg: 12, speed: 32, reach: 21, windup: 0.65, cd: 1.9, knock: 70, r: 6 },
    archer: { name: "Archer", weapon: "bow", rarity: "common", hp: 22, dmg: 5, speed: 42, ranged: true, pref: 95, windup: 0.45, cd: 1.7, projSpeed: 140, range: 220, r: 5 },
    mage: { name: "Mage", weapon: "staff", rarity: "rare", hp: 26, dmg: 7, speed: 38, ranged: true, pref: 110, windup: 0.6, cd: 2.3, projSpeed: 95, range: 220, r: 5 },
    seigneur: { name: "Seigneur des braises", weapon: "axe", rarity: "legendary", hp: 200, dmg: 11, speed: 42, reach: 26, windup: 0.5, cd: 1.4, boss: true, r: 8 },
  };
  const WAVES = [
    { name: "Les rôdeurs", bots: ["gobelin", "gobelin"] },
    { name: "La garde", bots: ["gobelin", "gobelin", "soldat"] },
    { name: "Tirs croisés", bots: ["soldat", "soldat", "archer"] },
    { name: "Les brutes", bots: ["brute", "mage", "gobelin", "gobelin"] },
    { name: "Le Seigneur des braises", bots: ["seigneur"] },
  ];

  const HERO_R = 5;
  const DASH_SPEED = 230, DASH_TIME = 0.17, DASH_INV = 0.24, HIT_INV = 0.5;
  const BETWEEN_TIME = 2.4, SPAWN_TIME = 0.7, TIME_LIMIT = 600;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clampInt = (v, lo, hi) => clamp(Math.trunc(Number(v)) || 0, lo, hi);
  const round1 = (v) => Math.round(v * 10) / 10;
  const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
  /** Petit générateur à graine : le même combat se rejoue à l'identique. */
  function mulberry32(a) {
    let s = a >>> 0;
    return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  /* ---------- caractéristiques : points, équipement, valeurs de combat ---------- */
  /** Un point de caractéristique par niveau du forgeron (le niveau vient du serveur : il se gagne en travaillant). */
  const pointsFor = (level) => clampInt(level, 1, 99);
  const zeroStats = () => Object.fromEntries(STAT_IDS.map((id) => [id, 0]));
  const spent = (stats) => STAT_IDS.reduce((n, id) => n + (stats?.[id] || 0), 0);

  /** Nettoie des points répartis venant du navigateur : entiers positifs, jamais plus que le niveau ne donne. */
  function normalizeStats(raw, level) {
    const out = zeroStats();
    let left = pointsFor(level);
    for (const id of STAT_IDS) {
      const own = raw && typeof raw === "object" && Object.hasOwn(raw, id) ? raw[id] : 0; // seulement ses propres champs, jamais ceux hérités
      const v = Math.min(clampInt(own, 0, 99), left);
      out[id] = v;
      left -= v;
    }
    return out;
  }

  /**
   * Tout ce que le combat lit du forgeron.
   * @param opts { level, stats (points répartis), equipment: { weapon: { type, rarity }, cape|apron|hat: { rarity } } }
   * @returns { level, base, bonus, total, weapon, derived }
   */
  function build(opts = {}) {
    const level = clampInt(opts.level ?? 1, 1, 99);
    const base = normalizeStats(opts.stats, level);
    const eq = opts.equipment || {};
    const bonus = zeroStats();
    const slots = {};
    for (const slot of Object.keys(SLOT_STAT)) {
      const item = eq[slot];
      if (!item || !RARITIES.includes(item.rarity)) continue;
      if (slot === "weapon" && !WEAPONS[item.type]) continue;
      bonus[SLOT_STAT[slot]] += RARITY_STAT[item.rarity];
      slots[slot] = { rarity: item.rarity, stat: SLOT_STAT[slot], points: RARITY_STAT[item.rarity] };
    }
    const total = Object.fromEntries(STAT_IDS.map((id) => [id, base[id] + bonus[id]]));
    const w = eq.weapon && WEAPONS[eq.weapon.type] && RARITIES.includes(eq.weapon.rarity) ? eq.weapon : TRAINING_WEAPON;
    const spec = WEAPONS[w.type];
    const agi = total.agilite;
    const derived = {
      maxHp: Math.round(50 + 2 * level + 8 * total.vitalite),
      speed: round1(62 * (1 + 0.012 * Math.min(agi, 50))),
      damage: round1(spec.dmg * RARITY_DMG[w.rarity] * (1 + 0.06 * total.force)),
      cooldown: Math.round((spec.cd / (1 + 0.01 * Math.min(agi, 60))) * 1000) / 1000,
      crit: Math.round(Math.min(0.5, 0.05 + 0.012 * total.chance) * 1000) / 1000,
      critMult: 1.6,
      dashCd: round1(Math.max(0.7, 1.6 - 0.02 * agi)),
      goldMult: Math.round((1 + Math.min(0.5, 0.01 * total.chance)) * 100) / 100,
    };
    return { level, base, bonus, total, slots, weapon: { type: w.type, rarity: w.rarity, training: w === TRAINING_WEAPON, spec }, derived };
  }

  /** Or gagné pour un combat : par vague terminée, plus une prime de victoire, majoré par la Chance. */
  function reward(result, built) {
    let gold = 0;
    for (let w = 1; w <= result.cleared; w++) gold += 3 + 2 * w;
    if (result.state === "won") gold += 25;
    return Math.round(gold * (built?.derived.goldMult ?? 1));
  }

  /* ---------- le combat ---------- */
  /**
   * @param opts { level, stats, equipment, seed } (voir `build`)
   * @returns Un combat : `step(input, dt?)`, `hud()`, `result()`, `drain()` ; l'état à dessiner est dans `hero`, `bots`, `shots`, `fx`.
   */
  function create(opts = {}) {
    const built = build(opts);
    const d = built.derived, wp = built.weapon.spec;
    const rng = mulberry32(opts.seed ?? 1);
    const level = built.level;
    const hero = {
      x: HERO_START.x, y: HERO_START.y, r: HERO_R, hp: d.maxHp, maxHp: d.maxHp, face: [0, -1], moving: false,
      cd: 0, windup: 0, dashT: 0, dashCd: 0, dash: [0, -1], inv: 0, hurt: 0, swing: 0, stun: 0, kb: null,
    };
    const fight = {
      built, hero, bots: [], shots: [], fx: [], t: 0, state: "between", timer: 1.2, wave: 0, waves: WAVES.length, kills: 0, cleared: 0, damageDealt: 0, ending: "", events: [],
    };
    const emit = (name) => fight.events.push(name);

    function blocked(x, y, r) {
      if (x - r < BOUNDS.x0 || x + r > BOUNDS.x1 || y - r < BOUNDS.y0 || y + r > BOUNDS.y1) return true;
      for (const o of OBSTACLES) if (x + r > o.x && x - r < o.x + o.w && y + r > o.y && y - r < o.y + o.h) return true;
      return false;
    }
    /** Déplace une entité axe par axe : elle glisse le long des murs et des piliers. @returns Vrai si elle a bougé. */
    function move(e, dx, dy) {
      let moved = false;
      if (dx && !blocked(e.x + dx, e.y, e.r)) { e.x += dx; moved = true; }
      if (dy && !blocked(e.x, e.y + dy, e.r)) { e.y += dy; moved = true; }
      return moved;
    }
    const norm = (dx, dy) => { const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    const aliveBots = () => fight.bots.filter((b) => b.alive);
    const nearestBot = () => {
      let best = null, bd = Infinity;
      for (const b of fight.bots) { if (!b.alive) continue; const dd = dist(hero.x, hero.y, b.x, b.y); if (dd < bd) { bd = dd; best = b; } }
      return best ? { bot: best, dist: bd } : null;
    };

    /* ----- bots ----- */
    function spawnBot(type, wave, at) {
      const spec = BOTS[type];
      const hpScale = (1 + 0.04 * (level - 1)) * (1 + 0.06 * (wave - 1));
      const dmgScale = (1 + 0.025 * (level - 1)) * (1 + 0.06 * (wave - 1));
      const hp = Math.round(spec.hp * hpScale);
      const bot = {
        type, spec, x: at[0], y: at[1], r: spec.r, hp, maxHp: hp, dmg: round1(spec.dmg * dmgScale), alive: true, dying: 0, face: [0, 1],
        cd: 0.6 + rng() * 0.8, windup: 0, spawnT: SPAWN_TIME, stun: 0, flash: 0, kb: null, side: rng() < 0.5 ? -1 : 1, rush: null, chargeCd: 3.5, summoned: false, tell: null,
      };
      fight.bots.push(bot);
      return bot;
    }
    function startWave(n) {
      fight.wave = n;
      fight.state = "fighting";
      const list = WAVES[n - 1].bots;
      list.forEach((type, i) => spawnBot(type, n, SPAWNS[(i * 2 + n) % SPAWNS.length]));
      emit("wave");
    }

    function hurtHero(dmg, fx, fy, knock = 40) {
      if (fight.state !== "fighting" || hero.inv > 0 || hero.hp <= 0) return false;
      hero.hp = Math.max(0, hero.hp - Math.max(1, Math.round(dmg)));
      hero.inv = HIT_INV; hero.hurt = 0.22;
      const [ux, uy] = norm(hero.x - fx, hero.y - fy);
      hero.kb = [ux * knock * 3, uy * knock * 3];
      fight.fx.push({ kind: "num", x: hero.x, y: hero.y - 8, text: `-${Math.max(1, Math.round(dmg))}`, hero: true, t: 0, life: 0.7 });
      emit("hurt");
      if (hero.hp <= 0) { fight.state = "lost"; fight.ending = "Tu es à terre."; emit("lose"); }
      return true;
    }

    function hitBot(b, dmg, crit, ux, uy, stun, knock) {
      if (!b.alive) return;
      b.hp -= dmg; b.flash = 0.12;
      fight.damageDealt += dmg;
      if (knock) b.kb = [ux * knock * (b.spec.boss ? 0.3 : 1) * 3, uy * knock * (b.spec.boss ? 0.3 : 1) * 3];
      if (stun) b.stun = Math.max(b.stun, b.spec.boss ? Math.min(stun, 0.15) : stun);
      fight.fx.push({ kind: "num", x: b.x, y: b.y - 8, text: String(Math.round(dmg)), crit, t: 0, life: 0.6 });
      emit(crit ? "crit" : "hit");
      if (b.hp <= 0) {
        b.alive = false; b.dying = 0.35; fight.kills++;
        fight.fx.push({ kind: "puff", x: b.x, y: b.y, t: 0, life: 0.4 });
        emit("kill");
      }
    }
    const rollDamage = () => { const crit = rng() < d.crit; return { crit, dmg: round1(d.damage * (crit ? d.critMult : 1)) }; };

    /* ----- le forgeron ----- */
    function heroStrike() {
      if (wp.ranged) {
        const near = nearestBot();
        let dir = hero.face;
        if (near && near.dist <= wp.range) dir = norm(near.bot.x - hero.x, near.bot.y - hero.y);
        hero.face = dir;
        const roll = rollDamage();
        fight.shots.push({ x: hero.x + dir[0] * 8, y: hero.y + dir[1] * 8, vx: dir[0] * wp.projSpeed, vy: dir[1] * wp.projSpeed, dmg: roll.dmg, crit: roll.crit, mine: true, pierce: Boolean(wp.pierce), hit: new Set(), life: wp.range / wp.projSpeed, kind: built.weapon.type === "bow" ? "arrow" : "bolt", stun: 0, knock: wp.knock });
        emit("shoot");
        return;
      }
      const cosHalf = Math.cos((wp.arc / 2) * Math.PI / 180);
      fight.fx.push({ kind: "slash", x: hero.x, y: hero.y, dir: hero.face.slice(), reach: wp.reach, arc: wp.arc, t: 0, life: 0.14 });
      hero.swing = 0.14;
      let hits = 0;
      for (const b of fight.bots) {
        if (!b.alive) continue;
        const dd = dist(hero.x, hero.y, b.x, b.y);
        if (dd - b.r - hero.r > wp.reach) continue;
        const [ux, uy] = norm(b.x - hero.x, b.y - hero.y);
        if (dd > hero.r + b.r + 2 && ux * hero.face[0] + uy * hero.face[1] < cosHalf) continue;
        const roll = rollDamage();
        hitBot(b, roll.dmg, roll.crit, ux, uy, wp.stun, wp.knock);
        hits++;
      }
      emit(hits ? "swing-hit" : "swing");
    }

    function updateHero(input) {
      const h = hero;
      h.inv = Math.max(0, h.inv - STEP); h.cd -= STEP; h.dashCd -= STEP; h.hurt = Math.max(0, h.hurt - STEP); h.swing = Math.max(0, h.swing - STEP);
      if (h.kb) { move(h, h.kb[0] * STEP, h.kb[1] * STEP); h.kb = Math.hypot(h.kb[0], h.kb[1]) < 6 ? null : [h.kb[0] * (1 - 9 * STEP), h.kb[1] * (1 - 9 * STEP)]; }
      let mx = (input.right ? 1 : 0) - (input.left ? 1 : 0), my = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      const len = Math.hypot(mx, my);
      if (len) { mx /= len; my /= len; }
      h.moving = false;
      if (h.dashT > 0) {
        h.dashT -= STEP;
        move(h, h.dash[0] * DASH_SPEED * STEP, h.dash[1] * DASH_SPEED * STEP);
      } else {
        if (len) {
          h.face = [mx, my]; h.moving = true;
          move(h, mx * d.speed * (h.windup > 0 ? 0.5 : 1) * STEP, my * d.speed * (h.windup > 0 ? 0.5 : 1) * STEP);
        }
        if (input.dash && h.dashCd <= 0) {
          h.dash = len ? [mx, my] : h.face.slice(); h.dashT = DASH_TIME; h.dashCd = d.dashCd; h.inv = Math.max(h.inv, DASH_INV); h.windup = 0;
          emit("dash");
        }
      }
      if (h.windup > 0) {
        h.windup -= STEP;
        if (h.windup <= 0) heroStrike();
      } else if (input.attack && h.cd <= 0 && h.dashT <= 0) {
        // Visée assistée : le coup part vers l'ennemi le plus proche à portée (le clavier n'a pas de souris)
        const near = nearestBot();
        const range = wp.ranged ? wp.range : wp.reach + hero.r + 14;
        if (near && near.dist <= range + near.bot.r) {
          const dir = norm(near.bot.x - h.x, near.bot.y - h.y);
          // Au corps à corps, on ne se retourne pas tout seul : seul ce qui est devant (à 100° près) est visé. À distance, on tire sur le plus proche, où qu'il soit (on peut fuir et tirer).
          if (wp.ranged || dir[0] * h.face[0] + dir[1] * h.face[1] >= -0.17) h.face = dir;
        }
        h.windup = wp.windup; h.cd = d.cooldown;
      }
    }

    /* ----- bots : intelligence simple, lisible, avec un signal avant chaque coup ----- */
    function botStrike(b) {
      b.tell = null;
      if (b.spec.ranged) {
        const dir = norm(hero.x - b.x, hero.y - b.y);
        fight.shots.push({ x: b.x + dir[0] * 8, y: b.y + dir[1] * 8, vx: dir[0] * b.spec.projSpeed, vy: dir[1] * b.spec.projSpeed, dmg: b.dmg, mine: false, pierce: false, hit: new Set(), life: b.spec.range / b.spec.projSpeed, kind: b.type === "archer" ? "arrow" : "bolt", stun: 0, knock: 20 });
        emit("bot-shoot");
        return;
      }
      const dd = dist(b.x, b.y, hero.x, hero.y);
      fight.fx.push({ kind: "slash", x: b.x, y: b.y, dir: b.face.slice(), reach: b.spec.reach, arc: 110, t: 0, life: 0.14, bot: true });
      if (dd - b.r - hero.r <= b.spec.reach) hurtHero(b.dmg, b.x, b.y, b.spec.knock || 40);
    }
    /** Avance vers (ux, uy) ; si un pilier bloque, longe-le. */
    function chase(b, ux, uy, speed) {
      const dx = ux * speed * STEP, dy = uy * speed * STEP;
      if (!move(b, dx, dy)) move(b, -uy * b.side * speed * STEP, ux * b.side * speed * STEP);
    }
    function updateBots() {
      const h = hero;
      for (const b of fight.bots) {
        if (!b.alive) { b.dying -= STEP; continue; }
        b.flash = Math.max(0, b.flash - STEP); b.cd -= STEP; b.chargeCd -= STEP;
        if (b.spawnT > 0) { b.spawnT -= STEP; continue; }
        if (b.kb) { move(b, b.kb[0] * STEP, b.kb[1] * STEP); b.kb = Math.hypot(b.kb[0], b.kb[1]) < 6 ? null : [b.kb[0] * (1 - 9 * STEP), b.kb[1] * (1 - 9 * STEP)]; }
        if (b.stun > 0) { b.stun -= STEP; continue; }
        const dd = dist(b.x, b.y, h.x, h.y) || 1;
        const [ux, uy] = norm(h.x - b.x, h.y - b.y);
        if (b.rush) {
          b.rush.t -= STEP;
          move(b, b.rush.dir[0] * 210 * STEP, b.rush.dir[1] * 210 * STEP);
          if (!b.rush.done && dd <= b.r + h.r + 2) { b.rush.done = true; hurtHero(b.dmg * 1.6, b.x, b.y, 90); }
          if (b.rush.t <= 0) { b.rush = null; b.stun = 0.7; b.chargeCd = 4.5; }
          continue;
        }
        if (b.windup > 0) {
          b.windup -= STEP;
          if (b.windup <= 0) {
            if (b.pending === "charge") { b.pending = null; b.tell = null; b.rush = { dir: b.chargeDir, t: 0.45, done: false }; emit("charge"); }
            else botStrike(b);
          }
          continue;
        }
        b.face = [ux, uy];
        // Le seigneur : une charge annoncée, puis il appelle du renfort quand il faiblit
        if (b.spec.boss) {
          if (!b.summoned && b.hp < b.maxHp / 2) {
            b.summoned = true;
            spawnBot("gobelin", fight.wave, SPAWNS[3]); spawnBot("gobelin", fight.wave, SPAWNS[4]);
            emit("summon");
          }
          if (b.chargeCd <= 0 && dd > 50 && dd < 190) {
            b.pending = "charge"; b.chargeDir = [ux, uy]; b.windup = 0.6; b.tell = { kind: "charge", dir: [ux, uy] };
            emit("tell");
            continue;
          }
        }
        const speed = b.spec.speed * (b.spec.boss && b.hp < b.maxHp / 2 ? 1.25 : 1);
        if (b.spec.ranged) {
          const pref = b.spec.pref;
          if (dd < pref - 18) chase(b, -ux, -uy, speed);
          else if (dd > pref + 25) chase(b, ux, uy, speed);
          else move(b, -uy * b.side * speed * 0.5 * STEP, ux * b.side * speed * 0.5 * STEP);
          if (b.cd <= 0 && dd <= b.spec.range) { b.windup = b.spec.windup; b.cd = b.spec.cd; b.tell = { kind: "shot" }; emit("tell"); }
        } else {
          if (dd - b.r - h.r > b.spec.reach * 0.75) chase(b, ux, uy, speed);
          if (b.cd <= 0 && dd - b.r - h.r <= b.spec.reach) { b.windup = b.spec.windup; b.cd = b.spec.cd; b.tell = { kind: "melee" }; emit("tell"); }
        }
      }
      // Les bots ne s'empilent pas
      const live = aliveBots();
      for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
        const a = live[i], c = live[j], dd = dist(a.x, a.y, c.x, c.y), min = a.r + c.r + 1;
        if (dd < min && dd > 0) { const [ux, uy] = norm(c.x - a.x, c.y - a.y), push = (min - dd) / 2; move(a, -ux * push, -uy * push); move(c, ux * push, uy * push); }
      }
      fight.bots = fight.bots.filter((b) => b.alive || b.dying > 0);
    }

    /* ----- projectiles et effets ----- */
    function updateShots() {
      for (const s of fight.shots) {
        s.x += s.vx * STEP; s.y += s.vy * STEP; s.life -= STEP;
        if (s.life <= 0 || blocked(s.x, s.y, 1)) { s.dead = true; continue; }
        if (s.mine) {
          for (const b of fight.bots) {
            if (!b.alive || s.hit.has(b) || dist(s.x, s.y, b.x, b.y) > b.r + 3) continue;
            s.hit.add(b);
            const [ux, uy] = norm(s.vx, s.vy);
            hitBot(b, s.dmg, s.crit, ux, uy, s.stun, s.knock);
            if (!s.pierce) { s.dead = true; break; }
          }
        } else if (dist(s.x, s.y, hero.x, hero.y) <= hero.r + 3) {
          hurtHero(s.dmg, s.x - s.vx * 0.05, s.y - s.vy * 0.05, s.knock);
          s.dead = true;
        }
      }
      fight.shots = fight.shots.filter((s) => !s.dead);
    }
    function updateFx() {
      for (const f of fight.fx) f.t += STEP;
      fight.fx = fight.fx.filter((f) => f.t < f.life);
    }

    /* ----- déroulement des vagues ----- */
    function updateFlow() {
      if (fight.state === "between") {
        fight.timer -= STEP;
        if (fight.timer <= 0) startWave(fight.wave + 1);
      } else if (fight.state === "fighting" && aliveBots().length === 0 && fight.bots.every((b) => b.spawnT <= 0)) {
        fight.cleared = fight.wave;
        if (fight.wave >= WAVES.length) { fight.state = "won"; fight.ending = "L'arène est à toi !"; emit("win"); return; }
        fight.state = "between"; fight.timer = BETWEEN_TIME;
        hero.hp = Math.min(hero.maxHp, hero.hp + Math.round(hero.maxHp * 0.35));
        emit("clear");
      }
    }

    fight.step = (input = {}, dt = STEP) => {
      if (fight.state === "won" || fight.state === "lost") return;
      // Un pas fixe : le même combat se rejoue à l'identique (un grand dt est découpé)
      let left = dt;
      while (left > 1e-9 && fight.state !== "won" && fight.state !== "lost") {
        left -= STEP;
        fight.t += STEP;
        updateHero(input);
        updateBots();
        updateShots();
        updateFx();
        updateFlow();
        if (fight.t > TIME_LIMIT && fight.state !== "won") { fight.state = "lost"; fight.ending = "Le temps est écoulé."; emit("lose"); }
      }
    };
    fight.hud = () => ({
      state: fight.state, hp: hero.hp, maxHp: hero.maxHp, wave: fight.wave, waves: fight.waves, waveName: WAVES[Math.max(0, Math.min(fight.wave, fight.waves) - 1)].name,
      botsLeft: aliveBots().length, kills: fight.kills, time: fight.t, dashReady: hero.dashCd <= 0, dashPct: clamp(1 - hero.dashCd / d.dashCd, 0, 1), ending: fight.ending,
      next: fight.state === "between" ? Math.min(fight.wave + 1, fight.waves) : 0,
    });
    fight.result = () => ({ state: fight.state, cleared: fight.cleared, wave: fight.wave, kills: fight.kills, time: round1(fight.t), damage: Math.round(fight.damageDealt), gold: reward({ state: fight.state, cleared: fight.cleared }, built) });
    /** Les événements sonores survenus depuis le dernier appel (touche, critique, vague...). */
    fight.drain = () => fight.events.splice(0);
    return fight;
  }

  globalThis.ForgeCombat = {
    T, W, H, STEP, STATS, STAT_IDS, RARITIES, RARITY_STAT, SLOT_STAT, SLOT_NAME, RARITY_DMG, WEAPONS, TRAINING_WEAPON, BOTS, WAVES, BOUNDS, OBSTACLES, HERO_START, SPAWNS,
    pointsFor, spent, normalizeStats, build, reward, create,
  };
})();
