/* Moteur de jeu à règles de la forge.
   Le problème en deux phrases : une personne décrit un jeu avec ses mots, un agent le traduit en DONNÉES (une carte, des objets, une physique, des règles
   « quand X, alors Y », des conditions de victoire et de défaite), et ce moteur, qui est notre code, les exécute. Aucun code venu d'un utilisateur ne s'exécute jamais.
   Ce fichier est de la logique pure (aucun DOM) : le navigateur le joue, le serveur s'en sert pour contrôler un jeu avant de le garder (src/rooms/gameCheck.ts).
   Format et règles : docs/jeux.md. */
(() => {
  "use strict";

  const T = 16, W = 24, H = 15; // une tuile = 16 px, un niveau = 24 x 15 tuiles
  const STEP = 1 / 60;

  /** Tuiles de la carte : `.` vide, `#` bloc, `=` plateforme traversable par en dessous (comme un bloc en vue de dessus), `^` piques. */
  const TILES = { ".": "vide", "#": "bloc", "=": "plateforme", "^": "piques" };
  const MODES = ["platformer", "topdown"];

  /** Objets posables. `group` fixe le comportement de base ; `move` est le déplacement par défaut d'un ennemi (`range` en tuiles, `speed` en px/s). */
  const KINDS = {
    coin: { w: 10, h: 10, group: "item", value: 1 },
    gem: { w: 10, h: 10, group: "item", value: 5 },
    key: { w: 10, h: 10, group: "item" },
    heart: { w: 10, h: 10, group: "item" },
    goal: { w: 12, h: 14, group: "goal" },
    door: { w: 16, h: 16, group: "door" },
    spring: { w: 14, h: 6, group: "spring" },
    slime: { w: 12, h: 10, group: "enemy", move: { pattern: "patrol-x", range: 3, speed: 24 } },
    bat: { w: 12, h: 10, group: "enemy", flying: true, move: { pattern: "patrol-y", range: 3, speed: 30 } },
    skull: { w: 12, h: 12, group: "enemy", move: { pattern: "chase", range: 6, speed: 28 } },
  };
  const PATTERNS = ["none", "patrol-x", "patrol-y", "chase"];
  const EVENTS = ["start", "touch", "defeat", "timer", "score", "collected_all"];
  const EFFECTS = ["score", "lives", "keys", "say", "remove", "spawn", "teleport", "bounce", "flag", "win", "lose", "gravity", "speed", "jump"];
  const WIN_CONDITIONS = ["score", "reach", "collect_all", "defeat_all", "survive"];
  const LIMITS = { things: 60, spawned: 40, rules: 30, effects: 6, text: 120, title: 40, intro: 220, lives: 9, patrolRange: 12, score: 1000 };
  const PHYSICS = { gravity: [0, 1500], speed: [30, 200], jump: [100, 400] };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const approach = (v, target, delta) => (v < target ? Math.min(v + delta, target) : Math.max(v - delta, target));
  const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  /**
   * Prépare une partie.
   * @param def Définition du jeu (déjà validée : src/rooms/game.ts).
   * @returns La partie : `step(dt, input)` l'avance, `hud()` donne ce qu'il faut afficher, `things`, `player`, `state`.
   */
  function create(def) {
    const mode = def.mode;
    const platformer = mode === "platformer";
    const phys = { gravity: platformer ? 900 : 0, speed: platformer ? 80 : 70, jump: 270, ...(def.physics || {}) };
    if (!platformer) phys.gravity = 0;
    const rows = def.map;
    const doorAt = (tx, ty) => g.things.some((d) => d.alive && d.group === "door" && Math.floor((d.x + 1) / T) === tx && Math.floor((d.y + 1) / T) === ty);
    /** Tuile en (tx, ty). Hors carte : mur à gauche, à droite et en haut ; en bas, le vide en plateforme (on y tombe) et un mur en vue de dessus. */
    const tileAt = (tx, ty) => {
      if (tx < 0 || tx >= W || ty < 0) return "#";
      if (ty >= H) return platformer ? "v" : "#";
      return rows[ty][tx];
    };

    let seq = 0;
    const makeThing = (spec) => {
      const k = KINDS[spec.kind];
      const x = spec.x * T + (T - k.w) / 2, y = spec.y * T + (T - k.h);
      const move = k.group === "enemy" ? { ...k.move, ...(spec.move || {}) } : null;
      return { id: spec.id || `${spec.kind}${++seq}`, kind: spec.kind, group: k.group, x, y, w: k.w, h: k.h, ox: x, oy: y, vx: 0, vy: 0, dir: 1, alive: true, touching: false, value: spec.value ?? k.value ?? 0, move, flying: Boolean(k.flying) };
    };

    const pw = 10, ph = platformer ? 14 : 10;
    const start = { x: def.player.x * T + (T - pw) / 2, y: def.player.y * T + (T - ph) };
    const g = {
      def, mode, phys, t: 0, score: 0, lives: def.player.lives ?? 3, keys: 0, state: "playing", ending: "", message: null, events: [], flags: {}, reached: {},
      created: {}, spawned: 0, acc: 0, pending: [], ruleState: (def.rules || []).map(() => ({ next: null, done: false })), started: false,
      player: { x: start.x, y: start.y, w: pw, h: ph, vx: 0, vy: 0, onGround: false, fx: 1, fy: 1, inv: 0, coyote: 0, buffer: 0, wasJump: false, wasAct: false, attack: 0, cool: 0 },
      things: [],
    };
    for (const spec of def.things || []) addThing(spec);

    function addThing(spec) {
      const th = makeThing(spec);
      g.things.push(th);
      g.created[th.kind] = (g.created[th.kind] || 0) + 1;
      return th;
    }
    const emit = (name) => g.events.push(name);
    const alive = (kind) => g.things.filter((t) => t.alive && t.kind === kind).length;

    /* ---------- déplacement et collisions contre la carte ---------- */
    /** Vrai si la tuile bloque ce corps : bloc, porte fermée, et plateforme traversable seulement quand on arrive par au-dessus. */
    function blocks(tx, ty, axis, dir, prevBottom) {
      const c = tileAt(tx, ty);
      if (c === "#" || doorAt(tx, ty)) return true;
      if (c === "=") return !platformer || (axis === "y" && dir > 0 && prevBottom <= ty * T + 0.001);
      return false;
    }
    /** Avance un corps sur un axe en le repoussant hors des tuiles pleines. @returns Vrai s'il a heurté quelque chose. */
    function move(b, axis, d) {
      if (!d) return false;
      const prevBottom = b.y + b.h;
      b[axis] += d;
      let hit = false;
      const x0 = Math.floor(b.x / T), x1 = Math.floor((b.x + b.w - 0.001) / T), y0 = Math.floor(b.y / T), y1 = Math.floor((b.y + b.h - 0.001) / T);
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (!blocks(tx, ty, axis, d, prevBottom)) continue;
          hit = true;
          if (axis === "x") b.x = d > 0 ? tx * T - b.w : (tx + 1) * T;
          else if (d > 0) { b.y = ty * T - b.h; b.onGround = true; } else b.y = (ty + 1) * T;
          b[axis === "x" ? "vx" : "vy"] = 0;
        }
      }
      return hit;
    }

    /* ---------- le joueur ---------- */
    function hurt(respawn) {
      const p = g.player;
      if (p.inv > 0 || g.state !== "playing") return;
      g.lives -= 1;
      p.inv = respawn ? 1.5 : 1.2;
      emit("hurt");
      if (g.lives <= 0) return end("lost", "Plus de vies.");
      if (respawn) { p.x = start.x; p.y = start.y; p.vx = 0; p.vy = 0; } else if (platformer) { p.vy = -150; p.vx = -p.fx * 100; }
    }

    function movePlayer(dt, input) {
      const p = g.player;
      const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0), dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
      p.onGround = false;
      if (platformer) {
        if (dx) p.fx = dx;
        p.vx = approach(p.vx, dx * phys.speed, phys.speed * (p.coyote > 0 ? 14 : 8) * dt);
        if (input.jump && !p.wasJump) p.buffer = 0.1;
        p.wasJump = Boolean(input.jump);
        p.buffer = Math.max(0, p.buffer - dt);
        if (p.buffer > 0 && p.coyote > 0) { p.vy = -phys.jump; p.coyote = 0; p.buffer = 0; emit("jump"); }
        if (!input.jump && p.vy < -phys.jump * 0.4) p.vy = -phys.jump * 0.4; // lâcher la touche écourte le saut
        p.vy = Math.min(p.vy + phys.gravity * dt, 420);
        move(p, "x", p.vx * dt);
        move(p, "y", p.vy * dt);
        p.coyote = p.onGround ? 0.08 : Math.max(0, p.coyote - dt);
      } else {
        const n = dx && dy ? 0.7071 : 1;
        if (dx || dy) { p.fx = dx; p.fy = dy; }
        p.vx = dx * n * phys.speed;
        p.vy = dy * n * phys.speed;
        move(p, "x", p.vx * dt);
        move(p, "y", p.vy * dt);
        // en vue de dessus, la touche d'action donne un coup court devant soi
        if (input.act && !p.wasAct && p.cool <= 0) { p.attack = 0.18; p.cool = 0.45; emit("slash"); }
        p.wasAct = Boolean(input.act);
        p.attack = Math.max(0, p.attack - dt);
        p.cool = Math.max(0, p.cool - dt);
      }
      p.inv = Math.max(0, p.inv - dt);
      // le vide, puis les piques
      if (platformer && p.y > H * T + 8) hurt(true);
      const px0 = Math.floor((p.x + 2) / T), px1 = Math.floor((p.x + p.w - 2) / T), py0 = Math.floor((p.y + 2) / T), py1 = Math.floor((p.y + p.h - 1) / T);
      for (let ty = py0; ty <= py1; ty++) for (let tx = px0; tx <= px1; tx++) if (tileAt(tx, ty) === "^") hurt(true);
    }

    /* ---------- les objets ---------- */
    function moveThing(e, dt) {
      const m = e.move;
      if (!m || m.pattern === "none") return;
      const p = g.player, sp = m.speed * dt, range = m.range * T;
      if (m.pattern === "patrol-x") {
        const hit = move(e, "x", e.dir * sp);
        const ahead = e.x + (e.dir > 0 ? e.w + 1 : -1), foot = e.y + e.h + 2;
        const ledge = platformer && !e.flying && tileAt(Math.floor(ahead / T), Math.floor(foot / T)) !== "#" && tileAt(Math.floor(ahead / T), Math.floor(foot / T)) !== "=";
        if (hit || ledge || Math.abs(e.x - e.ox) > range) e.dir = -e.dir;
      } else if (m.pattern === "patrol-y") {
        const hit = move(e, "y", e.dir * sp);
        if (hit || Math.abs(e.y - e.oy) > range) e.dir = -e.dir;
      } else if (m.pattern === "chase") {
        const ex = e.x + e.w / 2, ey = e.y + e.h / 2, qx = p.x + p.w / 2, qy = p.y + p.h / 2;
        if (Math.hypot(qx - ex, qy - ey) > range) return;
        move(e, "x", Math.sign(qx - ex) * sp);
        if (!platformer || e.flying) move(e, "y", Math.sign(qy - ey) * sp);
      }
    }

    /** Position du joueur par rapport à un objet : au-dessus, en dessous ou sur le côté. */
    const sideOf = (t) => {
      const p = g.player;
      if (p.y + p.h <= t.y + t.h * 0.6) return "above";
      if (p.y >= t.y + t.h * 0.5) return "below";
      return "side";
    };

    function remove(t) { t.alive = false; }
    function defeat(t, by) {
      remove(t);
      g.pending.push({ type: "defeat", kind: t.kind, id: t.id, by });
    }

    function touch(t) {
      const p = g.player;
      const ev = { type: "touch", kind: t.kind, id: t.id, from: sideOf(t) };
      if (t.group === "item") {
        if (t.kind === "key") g.keys += 1;
        else if (t.kind === "heart") g.lives = Math.min(LIMITS.lives, g.lives + 1);
        else g.score += t.value;
        remove(t);
        emit(t.kind);
      } else if (t.group === "goal") {
        g.reached[t.kind] = true;
        g.reached[t.id] = true;
        emit("goal");
      } else if (t.group === "spring") {
        if (platformer && p.vy >= 0) { p.vy = -phys.jump * 1.55; emit("spring"); }
      } else if (t.group === "enemy") {
        if (platformer && p.vy > 0 && ev.from === "above") { defeat(t, "stomp"); p.vy = -phys.jump * 0.6; emit("stomp"); } else hurt(false);
      }
      g.pending.push(ev);
    }

    function updateThings(dt) {
      const p = g.player;
      for (const t of g.things) {
        if (!t.alive) continue;
        moveThing(t, dt);
        if (t.group === "door") {
          // une porte fermée est un mur ; la toucher avec une clé l'ouvre
          const near = { x: p.x - 2, y: p.y - 2, w: p.w + 4, h: p.h + 4 };
          if (g.keys > 0 && overlap(near, t)) { g.keys -= 1; remove(t); emit("door"); g.pending.push({ type: "touch", kind: t.kind, id: t.id, from: "side" }); }
          continue;
        }
        if (overlap(p, t)) { if (!t.touching) { t.touching = true; touch(t); } else if (t.group === "enemy" && p.inv <= 0) touch(t); } else t.touching = false;
      }
      if (p.attack > 0) {
        // le coup couvre le corps du joueur ET 12 px devant lui : un ennemi collé à lui peut être frappé
        const r = { x: p.x - 2 - (p.fx < 0 ? 12 : 0), y: p.y - 2 - (p.fy < 0 ? 12 : 0), w: p.w + 4 + (p.fx ? 12 : 0), h: p.h + 4 + (p.fy ? 12 : 0) };
        for (const t of g.things) if (t.alive && t.group === "enemy" && overlap(r, t)) defeat(t, "slash");
      }
    }

    /* ---------- les règles ---------- */
    const holds = (c) => {
      if (!c) return true;
      return (c.score_gte === undefined || g.score >= c.score_gte) && (c.lives_gte === undefined || g.lives >= c.lives_gte) && (c.keys_gte === undefined || g.keys >= c.keys_gte)
        && (c.flag === undefined || g.flags[c.flag]) && (c.not_flag === undefined || !g.flags[c.not_flag]);
    };
    function effect(e, ctx) {
      if (g.state !== "playing") return;
      if (e.score !== undefined) g.score += e.score;
      else if (e.lives !== undefined) { g.lives = clamp(g.lives + e.lives, 0, LIMITS.lives); if (g.lives <= 0) end("lost", "Plus de vies."); }
      else if (e.keys !== undefined) g.keys = Math.max(0, g.keys + e.keys);
      else if (e.say !== undefined) g.message = { text: e.say, until: g.t + 3 };
      else if (e.remove !== undefined) {
        for (const t of g.things) if (t.alive && ((e.remove === "other" && ctx.other === t) || t.id === e.remove || t.kind === e.remove)) remove(t);
      } else if (e.spawn !== undefined) {
        if (g.spawned < LIMITS.spawned) { g.spawned += 1; addThing(e.spawn); }
      } else if (e.teleport !== undefined) { g.player.x = e.teleport.x * T + (T - pw) / 2; g.player.y = e.teleport.y * T + (T - ph); g.player.vx = 0; g.player.vy = 0; }
      else if (e.bounce !== undefined) g.player.vy = -e.bounce;
      else if (e.flag !== undefined) g.flags[e.flag] = true;
      else if (e.win !== undefined) end("won", e.win);
      else if (e.lose !== undefined) end("lost", e.lose);
      else if (e.gravity !== undefined && platformer) phys.gravity = e.gravity;
      else if (e.speed !== undefined) phys.speed = e.speed;
      else if (e.jump !== undefined) phys.jump = e.jump;
    }
    const matches = (r, ev) => {
      if (r.on !== ev.type) return false;
      if ((ev.type === "touch" || ev.type === "defeat") && ((r.kind !== undefined && r.kind !== ev.kind) || (r.id !== undefined && r.id !== ev.id))) return false;
      if (ev.type === "touch" && r.from !== undefined && r.from !== ev.from) return false;
      return true;
    };
    function runRules() {
      const rules = def.rules || [];
      // événements nés du temps, du score et des objets ramassés
      if (!g.started) { g.started = true; g.pending.push({ type: "start" }); }
      rules.forEach((r, i) => {
        const st = g.ruleState[i];
        if (r.on === "timer") {
          if (r.at !== undefined && !st.done && g.t >= r.at) { st.done = true; g.pending.push({ type: "timer", index: i }); }
          if (r.every !== undefined) {
            if (st.next === null) st.next = r.every;
            if (g.t >= st.next) { st.next += r.every; g.pending.push({ type: "timer", index: i }); }
          }
        } else if (r.on === "score" && !st.done && g.score >= r.at) { st.done = true; g.pending.push({ type: "score", index: i }); }
        else if (r.on === "collected_all" && !st.done && (g.created[r.kind] || 0) > 0 && alive(r.kind) === 0) { st.done = true; g.pending.push({ type: "collected_all", index: i }); }
      });
      const batch = g.pending.splice(0);
      for (const ev of batch) {
        rules.forEach((r, i) => {
          const indexed = ev.index !== undefined;
          if (indexed ? i !== ev.index : !matches(r, ev)) return;
          if (!indexed && (r.on === "timer" || r.on === "score" || r.on === "collected_all")) return;
          if (!holds(r.if)) return;
          const other = ev.id ? g.things.find((t) => t.id === ev.id) : null;
          for (const e of r.do) effect(e, { other });
        });
      }
    }

    /* ---------- fin de partie ---------- */
    function end(state, text) {
      if (g.state !== "playing") return;
      g.state = state;
      g.ending = text || (state === "won" ? "Gagné !" : "Perdu.");
      emit(state === "won" ? "win" : "lose");
    }
    function checkEnd() {
      if (g.state !== "playing") return;
      for (const c of def.win || []) {
        const ok = (c.score !== undefined && g.score >= c.score) || (c.reach !== undefined && g.reached[c.reach]) || (c.survive !== undefined && g.t >= c.survive)
          || (c.collect_all !== undefined && (g.created[c.collect_all] || 0) > 0 && alive(c.collect_all) === 0) || (c.defeat_all !== undefined && (g.created[c.defeat_all] || 0) > 0 && alive(c.defeat_all) === 0);
        if (ok) return end("won");
      }
      for (const c of def.lose || []) if (c.time !== undefined && g.t >= c.time) return end("lost", "Temps écoulé.");
    }

    /** Un pas fixe de 1/60 s. */
    function tick(dt, input) {
      if (g.state !== "playing") return;
      g.events.length = 0;
      g.t += dt;
      movePlayer(dt, input);
      if (g.state === "playing") updateThings(dt);
      runRules();
      checkEnd();
    }
    /** Avance de `dt` secondes réelles par pas fixes : le résultat ne dépend pas de la vitesse de l'écran. */
    function step(dt, input) {
      g.acc += Math.min(dt, 0.1);
      const events = [];
      while (g.acc >= STEP && g.state === "playing") { tick(STEP, input || {}); g.acc -= STEP; events.push(...g.events); }
      g.events = events;
    }
    function hud() {
      const limit = (def.lose || []).find((c) => c.time !== undefined);
      return { score: g.score, lives: g.lives, keys: g.keys, state: g.state, ending: g.ending, time: g.t, remaining: limit ? Math.max(0, limit.time - g.t) : null, message: g.message && g.message.until > g.t ? g.message.text : null };
    }
    const copy = (v) => JSON.parse(JSON.stringify(v));
    /** Photographie de la partie (données seulement) ; `restore` la remet à cet état. Sert au solveur. */
    g.snapshot = () => copy({ t: g.t, score: g.score, lives: g.lives, keys: g.keys, state: g.state, ending: g.ending, message: g.message, flags: g.flags, reached: g.reached, created: g.created, spawned: g.spawned, acc: g.acc, started: g.started, pending: g.pending, ruleState: g.ruleState, player: g.player, things: g.things, phys, seq });
    g.restore = (snap) => {
      const c = copy(snap);
      Object.assign(phys, c.phys); seq = c.seq;
      delete c.phys; delete c.seq;
      Object.assign(g, c);
      g.events = [];
    };
    g.tick = tick;
    g.step = step;
    g.hud = hud;
    return g;
  }

  /**
   * Contrôle sans écran : fait jouer le niveau avec des entrées prévues d'avance et vérifie que rien ne plante ni ne sort de la carte.
   * @param def Définition du jeu.
   * @returns Les problèmes trouvés, en français (liste vide : rien à signaler).
   */
  function smoke(def) {
    const errors = [];
    const scripts = [
      { name: "immobile", input: () => ({}) },
      { name: "course vers la droite", input: (i) => ({ right: true, jump: i % 50 < 12, down: i % 90 < 30, act: i % 40 === 0 }) },
      { name: "course vers la gauche", input: (i) => ({ left: true, jump: i % 70 < 10, up: i % 120 < 20, act: i % 33 === 0 }) },
      { name: "haut et bas", input: (i) => ({ up: i % 100 < 50, down: i % 100 >= 50, right: i % 200 < 100, left: i % 200 >= 100, jump: i % 45 < 5 }) },
    ];
    for (const s of scripts) {
      let g;
      try {
        g = create(def);
        for (let i = 0; i < 60 * 25 && g.state === "playing"; i++) {
          g.tick(STEP, s.input(i));
          const p = g.player;
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error("position invalide");
          if (p.x < -1 || p.x + p.w > W * T + 1) throw new Error("le joueur sort de la carte");
        }
        for (const t of g.things) if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) throw new Error(`objet « ${t.id} » en position invalide`);
      } catch (err) {
        errors.push(`Jeu injouable (${s.name}) : ${err.message}`);
      }
    }
    return errors;
  }

  /**
   * Cherche automatiquement une façon de GAGNER le niveau, avec les vraies règles du moteur (recherche gloutonne guidée vers les objectifs, par actions
   * de quelques images). Trouver un chemin prouve que le niveau est gagnable ; ne rien trouver dans le budget ne prouve PAS le contraire.
   * @param def Définition du jeu.
   * @param opts { maxNodes, maxMs } budget de la recherche.
   * @returns { solved, seconds (durée de la partie gagnante), nodes }.
   */
  function solve(def, opts = {}) {
    const maxNodes = opts.maxNodes || 6000, maxMs = opts.maxMs || 4000, t0 = Date.now();
    const platformer = def.mode === "platformer";
    const A = platformer
      ? [{ i: { right: true }, n: 8 }, { i: { left: true }, n: 8 }, { i: { right: true }, n: 3 }, { i: { left: true }, n: 3 }, { i: { jump: true, right: true }, n: 22 }, { i: { jump: true, left: true }, n: 22 }, { i: { jump: true }, n: 22 }, { i: {}, n: 8 }]
      : [{ i: { right: true }, n: 8 }, { i: { left: true }, n: 8 }, { i: { up: true }, n: 8 }, { i: { down: true }, n: 8 }, { i: { right: true, act: true }, n: 8 }, { i: { left: true, act: true }, n: 8 }];
    // Ce que le niveau demande d'atteindre : les objets cités par les conditions de victoire ou par une règle qui gagne
    const want = new Set();
    for (const c of def.win || []) { if (c.reach) want.add(c.reach); if (c.collect_all) want.add(c.collect_all); if (c.defeat_all) want.add(c.defeat_all); if (c.score) { want.add("coin"); want.add("gem"); } }
    for (const r of def.rules || []) if (r.do.some((e) => e.win !== undefined) && (r.kind || r.id)) want.add(r.kind || r.id);
    const game = create(def);
    const heuristic = () => {
      let best = Infinity;
      const p = game.player;
      for (const t of game.things) if (t.alive && (want.has(t.kind) || want.has(t.id))) best = Math.min(best, Math.abs(t.x - p.x) + (platformer ? 1.5 : 1) * Math.abs(t.y - p.y));
      return best === Infinity ? 0 : best;
    };
    const key = () => { const p = game.player; return [Math.round(p.x / 3), Math.round(p.y / 3), Math.round(p.vy / 40), p.onGround ? 1 : 0, game.score, game.lives, game.keys, game.things.filter((t) => t.alive).length].join(","); };
    const heap = [];
    const push = (n) => { heap.push(n); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (heap[q].f <= heap[i].f) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && heap[l].f < heap[m].f) m = l; if (r < heap.length && heap[r].f < heap[m].f) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const seen = new Set([key()]);
    push({ snap: game.snapshot(), f: heuristic(), ticks: 0 });
    let nodes = 0;
    while (heap.length && nodes < maxNodes && Date.now() - t0 < maxMs) {
      const node = pop();
      nodes++;
      for (const a of A) {
        game.restore(node.snap);
        for (let k = 0; k < a.n && game.state === "playing"; k++) game.tick(STEP, a.i);
        if (game.state === "won") return { solved: true, seconds: Math.round((node.ticks + a.n) * STEP * 10) / 10, nodes };
        if (game.state !== "playing") continue;
        const k = key();
        if (seen.has(k)) continue;
        seen.add(k);
        const ticks = node.ticks + a.n;
        push({ snap: game.snapshot(), f: heuristic() + ticks * 0.02, ticks });
      }
    }
    return { solved: false, seconds: 0, nodes };
  }

  globalThis.ForgeEngine = { T, W, H, STEP, TILES, MODES, KINDS, PATTERNS, EVENTS, EFFECTS, WIN_CONDITIONS, LIMITS, PHYSICS, create, smoke, solve };
})();
